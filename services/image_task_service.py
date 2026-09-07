from __future__ import annotations

import base64
import hashlib
import io
import copy
import json
import threading
import time
import uuid
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from services.config import DATA_DIR, config
from services.content_filter import request_text
from services.log_service import LOG_TYPE_CALL, log_service
from services.image_storage_service import ImageStorageError, image_storage_service, write_json_atomic
from PIL import Image, UnidentifiedImageError
from utils.business_time import beijing_iso
from services.protocol import openai_v1_image_edit, openai_v1_image_generations
from services.protocol.conversation import encode_images
from services.openai_backend_api import ImageUploadCache

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:26], fmt).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _owner_id(identity: dict[str, object]) -> str:
    owner = _clean(identity.get("id"))
    if not owner:
        raise ValueError("identity id is required")
    return owner


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _collect_image_urls(data: list[Any]) -> list[str]:
    urls: list[str] = []
    for item in data:
        if isinstance(item, dict):
            url = item.get("url")
            if isinstance(url, str) and url:
                urls.append(url)
    return urls


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "model": task.get("model"),
        "size": task.get("size"),
        "quality": task.get("quality"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }
    if task.get("conversation_id"):
        item["conversation_id"] = task.get("conversation_id")
    if task.get("data") is not None:
        item["data"] = task.get("data")
    if task.get("usage") is not None:
        item["usage"] = task.get("usage")
    if task.get("error"):
        item["error"] = task.get("error")
    if task.get("progress"):
        item["progress"] = task.get("progress")
    if task.get("duration_ms") is not None:
        item["duration_ms"] = task.get("duration_ms")
    if task.get("status") in (TASK_STATUS_RUNNING, TASK_STATUS_QUEUED):
        if task.get("status") == TASK_STATUS_RUNNING:
            # RUNNING 状态仅在 started_ts 被设置后（image_stream_resolve_start）才计时
            base_ts = task.get("started_ts")
        else:
            # QUEUED 状态从 created_ts 开始计时（排队等待中）
            base_ts = task.get("created_ts") or task.get("updated_ts")
        if base_ts:
            item["elapsed_secs"] = round(time.time() - base_ts, 1)
    return item


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_generations.handle,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_edit.handle,
        retention_days_getter: Callable[[], int] | None = None,
    ):
        self.path = path
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self._conversations: dict[str, dict[str, Any]] = {}
        self._current: dict[str, str] = {}
        self._references: dict[str, dict[str, Any]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            changed = self._recover_unfinished_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()

    def list_conversations(self, identity: dict[str, object], offset: int = 0, limit: int = 30) -> dict[str, Any]:
        owner = _owner_id(identity)
        with self._lock:
            items = [item for item in self._conversations.values()
                     if item["owner_id"] == owner and not item.get("deleted")]
            items.sort(key=lambda item: (item["updatedAt"], item["id"]), reverse=True)
            page = self._page(len(items), offset, limit, 100)
            metadata = [self._conversation_metadata(item) for item in items]
            return {"items": metadata[offset:offset + limit], "pagination": page,
                    "stats": {key: sum(item["stats"][key] for item in metadata) for key in ("queued", "running")},
                    "current_conversation_id": self._current.get(owner)}

    def get_conversation(self, identity: dict[str, object], conversation_id: str, offset: int | None = None,
                         limit: int = 2, turn_id: str = "", image_id: str = "", navigation: bool = False) -> dict[str, Any]:
        with self._lock:
            item = self._owned_conversation(identity, conversation_id)
            target = None
            if turn_id or image_id:
                for index, turn in enumerate(item["turns"]):
                    if turn.get("promptDeleted") and turn.get("resultsDeleted"):
                        continue
                    if ((not turn_id or turn["id"] == turn_id) and
                            (not image_id or not turn.get("resultsDeleted") and image_id in turn["task_ids"]
                             and image_id not in turn.get("dismissedImageIds", []))):
                        offset = index // max(1, limit) * limit
                        target = {"turn_id": turn["id"], "image_id": image_id or None}
                        break
                if target is None:
                    raise KeyError("result not found")
            result = self._public_conversation(item, offset, limit, navigation)
            if target:
                result["target"] = target
            return result

    @staticmethod
    def _page(total: int, offset: int | None, limit: int, maximum: int = 10) -> dict[str, Any]:
        if not 1 <= limit <= maximum or offset is not None and offset < 0:
            raise ValueError("invalid pagination")
        offset = max(0, (total - 1) // limit * limit) if offset is None else offset
        return {"offset": offset, "limit": limit, "total": total,
                "next_offset": offset + limit if offset + limit < total else None,
                "previous_offset": max(0, offset - limit) if offset else None}

    def _conversation_metadata(self, item: dict[str, Any]) -> dict[str, Any]:
        stats = {"queued": 0, "running": 0}
        for turn in item["turns"]:
            if turn.get("resultsDeleted"):
                continue
            statuses = {self._tasks[_task_key(item["owner_id"], task_id)]["status"] for task_id in turn["task_ids"]
                        if task_id not in turn.get("dismissedImageIds", [])}
            if TASK_STATUS_RUNNING in statuses:
                stats["running"] += 1
            elif TASK_STATUS_QUEUED in statuses:
                stats["queued"] += 1
        return {**{key: item[key] for key in ("id", "title", "createdAt", "updatedAt")},
                "turnCount": len(item["turns"]), "stats": stats, "turns": []}

    def _owned_conversation(self, identity: dict[str, object], conversation_id: str) -> dict[str, Any]:
        item = self._conversations.get(conversation_id)
        if not item or item["owner_id"] != _owner_id(identity) or item.get("deleted"):
            raise KeyError("conversation not found")
        return item

    def _public_conversation(self, item: dict[str, Any], offset: int | None = None, limit: int = 2,
                             navigation: bool = False) -> dict[str, Any]:
        result = self._conversation_metadata(item)
        page = self._page(len(item["turns"]), offset, limit)
        result["pagination"] = page
        selected = item["turns"][page["offset"]:page["offset"] + limit]
        if navigation:
            selected = [turn for turn in selected if not (turn.get("promptDeleted") and turn.get("resultsDeleted"))]
        source_ids = {turn["sourceEntryId"] for turn in selected}
        result["sourceEntries"] = [copy.deepcopy(source) for source in item["sourceEntries"] if source["id"] in source_ids]
        for saved in selected:
            turn = ({key: saved[key] for key in ("id", "sourceEntryId", "createdAt", "count")} if navigation else
                    {key: copy.deepcopy(value) for key, value in saved.items() if key not in {"task_ids", "request_id"}})
            if navigation:
                turn.update(promptDeleted=bool(saved.get("promptDeleted")), resultsDeleted=bool(saved.get("resultsDeleted")))
            images = []
            for task_id in ([] if saved.get("resultsDeleted") else saved["task_ids"]):
                if task_id in saved.get("dismissedImageIds", []):
                    continue
                task = _public_task(self._tasks[_task_key(item["owner_id"], task_id)])
                status = task["status"]
                image = {"id": task_id, "taskId": task_id,
                         "status": status if status in TERMINAL_STATUSES else "loading"}
                if status not in TERMINAL_STATUSES:
                    image["taskStatus"] = status
                if task.get("data") and not navigation:
                    image.update(task["data"][0])
                for source, target in (("error", "error"), ("progress", "progress"),
                                       ("elapsed_secs", "elapsedSecs"), ("duration_ms", "durationMs")):
                    if task.get(source) is not None and not navigation:
                        image[target] = task[source]
                images.append(image)
            turn["images"] = images
            turn["status"] = ("generating" if any(image["status"] == "loading" for image in images)
                              else "error" if any(image["status"] == "error" for image in images) else "success")
            result["turns"].append(turn)
        return result

    def _new_conversation(self, owner: str, title: str = "新对话") -> dict[str, Any]:
        now = _now_iso()
        conversation = {"id": uuid.uuid4().hex, "owner_id": owner, "title": title,
                        "createdAt": now, "updatedAt": now, "turns": [], "sourceEntries": []}
        self._conversations[conversation["id"]] = conversation
        self._current[owner] = conversation["id"]
        return conversation

    def create_conversation(self, identity: dict[str, object], request_id: str) -> dict[str, Any]:
        owner = _owner_id(identity)
        with self._lock:
            for conversation in self._conversations.values():
                if conversation["owner_id"] == owner and conversation.get("creation_request_id") == request_id:
                    return self.get_conversation(identity, conversation["id"])
            previous_current = self._current.get(owner)
            conversation = self._new_conversation(owner)
            conversation["creation_request_id"] = request_id
            try:
                self._save_locked()
            except Exception:
                del self._conversations[conversation["id"]]
                self._restore_current(owner, previous_current)
                raise
            return self._public_conversation(conversation)

    def _restore_current(self, owner: str, value: str | None) -> None:
        if value is None:
            self._current.pop(owner, None)
        else:
            self._current[owner] = value

    def set_current_conversation(self, identity: dict[str, object], conversation_id: str) -> None:
        owner = _owner_id(identity)
        with self._lock:
            self._owned_conversation(identity, conversation_id)
            previous = self._current.get(owner)
            self._current[owner] = conversation_id
            try:
                self._save_locked()
            except Exception:
                self._restore_current(owner, previous)
                raise

    def update_conversation(self, identity: dict[str, object], conversation_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._owned_conversation(identity, conversation_id)
            updated = copy.deepcopy(current)
            if "title" in updates:
                updated["title"] = updates["title"]
            for visibility in updates.get("turns", []):
                turn = next((turn for turn in updated["turns"] if turn["id"] == visibility["id"]), None)
                if turn is None:
                    raise KeyError("turn not found")
                for flag in ("promptDeleted", "resultsDeleted"):
                    if flag in visibility:
                        turn[flag] = bool(visibility[flag])
                if "dismissedImageIds" in visibility:
                    if not set(visibility["dismissedImageIds"]).issubset(turn["task_ids"]):
                        raise ValueError("image not found in this turn")
                    turn["dismissedImageIds"] = visibility["dismissedImageIds"]
            updated["updatedAt"] = _now_iso()
            self._conversations[conversation_id] = updated
            try:
                self._save_locked()
            except Exception:
                self._conversations[conversation_id] = current
                raise
            return self._public_conversation(updated)

    def delete_conversations(self, identity: dict[str, object], conversation_id: str | None = None) -> None:
        owner = _owner_id(identity)
        with self._lock:
            targets = ([self._owned_conversation(identity, conversation_id)] if conversation_id else
                       [item for item in self._conversations.values() if item["owner_id"] == owner and not item.get("deleted")])
            previous_current = self._current.get(owner)
            for item in targets:
                item["deleted"] = True
                if self._current.get(owner) == item["id"]:
                    self._current.pop(owner, None)
            try:
                self._save_locked()
            except Exception:
                for item in targets:
                    item.pop("deleted", None)
                self._restore_current(owner, previous_current)
                raise

    def _owned_reference(self, identity: dict[str, object], reference_id: str) -> dict[str, Any]:
        reference = self._references.get(reference_id)
        if not reference or reference["owner_id"] != _owner_id(identity) or reference.get("deleted"):
            raise KeyError("reference not found")
        if reference.get("state") != "ready":
            raise ValueError("参考图上传未完成，请重试上传或移除")
        if not reference["input_scopes"] and not reference["turn_ids"]:
            raise KeyError("reference released")
        return reference

    @staticmethod
    def _public_reference(reference: dict[str, Any]) -> dict[str, Any]:
        return {key: reference[key] for key in ("id", "name", "type", "url", "size")}

    def upload_reference(self, identity: dict[str, object], request_id: str, data: bytes,
                         name: str, base_url: str = "", *, scope: str = "ordinary") -> dict[str, Any]:
        self._validate_reference_scope(scope)
        owner = _owner_id(identity)
        if not request_id.strip() or not data or len(data) > 50 * 1024 * 1024:
            raise ValueError("参考图不能为空且不得超过50MB，request_id不能为空")
        name = name.replace("\\", "/").rsplit("/", 1)[-1]
        if not name or len(name) > 255:
            raise ValueError("参考图文件名无效")
        digest = hashlib.sha256(data).hexdigest()
        with self._lock:
            reference = next((item for item in self._references.values()
                              if item["owner_id"] == owner and item["request_id"] == request_id and item["upload_scope"] == scope), None)
            if reference:
                if reference.get("deleted") or reference.get("upload_cancelled") or reference["digest"] != digest or reference["name"] != name:
                    raise ValueError("上传request_id已使用，请为新文件使用新标识")
                if reference["state"] == "ready":
                    if scope not in reference["input_scopes"]:
                        return self.retain_reference(identity, reference["id"], scope=scope)
                    return self._public_reference(reference)
                if not reference["input_scopes"]:
                    raise ValueError("该上传正在清理，请使用新request_id")
            else:
                try:
                    with Image.open(io.BytesIO(data)) as image:
                        mime_type = Image.MIME.get(image.format)
                        if mime_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                            raise ValueError("参考图仅支持 PNG、JPEG、WebP、GIF")
                        image.verify()
                except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
                    raise ValueError("无法读取参考图") from exc
                image_storage_service.check_writable(verify_destinations=True)
                with image_storage_service.owner_scope(owner):
                    path = image_storage_service.make_reference_path(mime_type)
                reference_id = uuid.uuid4().hex
                reference = {"id": reference_id, "owner_id": owner, "request_id": request_id,
                             "name": name, "type": mime_type, "url": f"/images/{path}", "size": len(data),
                             "path": path, "digest": digest, "input_scopes": [scope], "upload_scope": scope, "turn_ids": [],
                             "created_at": beijing_iso(), "state": "pending",
                             "storage_mode": image_storage_service.mode(),
                             "storage_target": self._reference_storage_target()}
                self._references[reference_id] = reference
                try:
                    # Record the intended file before either destination can receive bytes.
                    self._save_locked()
                except Exception:
                    del self._references[reference_id]
                    raise
            self._check_reference_destination(reference)
            with image_storage_service.owner_scope(owner):
                image_storage_service.save(data, base_url, reference=True, reference_path=reference["path"],
                                           storage_mode=reference["storage_mode"])
            reference["state"] = "ready"
            try:
                self._save_locked()
            except Exception:
                reference["state"] = "pending"
                raise
            return self._public_reference(reference)

    @staticmethod
    def _validate_reference_scope(scope: str) -> None:
        if scope not in {"ordinary", "imports"}:
            raise ValueError("unknown reference scope")

    @staticmethod
    def _reference_storage_target() -> dict[str, str]:
        settings = image_storage_service.settings()
        return {key: (str(settings.get(key) or "") if key == "webdav_username" else str(settings.get(key) or "").rstrip("/"))
                for key in ("webdav_url", "webdav_root_path", "webdav_username")}

    def _check_reference_destination(self, reference: dict[str, Any]) -> None:
        if reference["storage_mode"] in {"webdav", "both"} and reference["storage_target"] != self._reference_storage_target():
            raise ImageStorageError("参考图远端存储位置已变更，请恢复原位置后重试")

    def list_references(self, identity: dict[str, object], *, scope: str = "ordinary") -> dict[str, Any]:
        self._validate_reference_scope(scope)
        with self._lock:
            return {"items": [
                {**self._public_reference(item),
                 **({"error": "释放未完成，请重试移除"} if item.get("cleanup_scope") else
                    {"error": "上传未完成，请移除并重新选择"} if item["state"] != "ready" else {})}
                for item in self._references.values()
                if item["owner_id"] == _owner_id(identity) and (scope in item["input_scopes"] or item.get("cleanup_scope") == scope)
                and not item.get("deleted")
            ]}

    def retain_reference(self, identity: dict[str, object], reference_id: str, *, scope: str = "ordinary") -> dict[str, Any]:
        self._validate_reference_scope(scope)
        with self._lock:
            reference = self._owned_reference(identity, reference_id)
            previous = reference["input_scopes"][:]
            reference["input_scopes"] = list(dict.fromkeys([*previous, scope]))
            try:
                self._save_locked()
            except Exception:
                reference["input_scopes"] = previous
                raise
            return self._public_reference(reference)

    def read_reference(self, identity: dict[str, object], reference_id: str) -> tuple[bytes, str, str]:
        with self._lock:
            reference = self._owned_reference(identity, reference_id)
            self._check_reference_destination(reference)
            return image_storage_service.get_bytes(reference["path"]), reference["name"], reference["type"]

    def release_reference(self, identity: dict[str, object], reference_id: str, *, scope: str = "ordinary") -> dict[str, bool]:
        self._validate_reference_scope(scope)
        with self._lock:
            reference = self._references.get(reference_id)
            if not reference or reference["owner_id"] != _owner_id(identity):
                raise KeyError("reference not found")
            if reference.get("deleted"):
                return {"retained": False}
            previous = copy.deepcopy(reference)
            reference["input_scopes"] = [item for item in reference["input_scopes"] if item != scope]
            if not reference["input_scopes"] and not reference["turn_ids"]:
                reference["cleanup_scope"] = scope
            try:
                self._save_locked()
            except Exception:
                self._references[reference_id] = previous
                raise
            return self._delete_unused_reference(reference)

    def cancel_reference_upload(self, identity: dict[str, object], request_id: str, *, scope: str = "ordinary") -> dict[str, bool]:
        self._validate_reference_scope(scope)
        if not request_id.strip() or len(request_id) > 128:
            raise ValueError("上传request_id无效")
        owner = _owner_id(identity)
        with self._lock:
            reference = next((item for item in self._references.values()
                              if item["owner_id"] == owner and item["request_id"] == request_id and item["upload_scope"] == scope), None)
            if reference:
                reference["upload_cancelled"] = True
                return self.release_reference(identity, reference["id"], scope=scope)
            # Persist cancellation even when DELETE overtakes the multipart upload.
            reference_id = uuid.uuid4().hex
            self._references[reference_id] = {"id": reference_id, "owner_id": owner, "request_id": request_id,
                                              "upload_scope": scope, "input_scopes": [], "turn_ids": [], "deleted": True}
            try:
                self._save_locked()
            except Exception:
                del self._references[reference_id]
                raise
            return {"retained": False}

    def release_turn_reference(self, identity: dict[str, object], reference_id: str, turn_id: str) -> dict[str, bool]:
        """Deletion callers release each snapshot ID after removing its turn/conversation and settling tasks."""
        owner = _owner_id(identity)
        with self._lock:
            reference = self._references.get(reference_id)
            if not reference or reference["owner_id"] != owner:
                raise KeyError("reference not found")
            if any(item["owner_id"] == owner and not item.get("deleted")
                   and any(turn["id"] == turn_id for turn in item["turns"]) for item in self._conversations.values()):
                raise ValueError("轮次快照仍存在，不能释放参考图")
            if any(task["owner_id"] == owner and task.get("turn_id") == turn_id
                   and task["status"] not in TERMINAL_STATUSES for task in self._tasks.values()):
                raise ValueError("轮次仍有在途任务，不能释放参考图")
            previous = copy.deepcopy(reference)
            reference["turn_ids"] = [item for item in reference["turn_ids"] if item != turn_id]
            if not reference["input_scopes"] and not reference["turn_ids"]:
                reference["cleanup_scope"] = reference["upload_scope"]
            try:
                self._save_locked()
            except Exception:
                self._references[reference_id] = previous
                raise
            return self._delete_unused_reference(reference)

    def _delete_unused_reference(self, reference: dict[str, Any]) -> dict[str, bool]:
        if reference["turn_ids"] or reference["input_scopes"]:
            return {"retained": True}
        if reference.get("deleted"):
            return {"retained": False}
        # Keep the record until every destination confirms deletion; each release operation is retryable.
        self._check_reference_destination(reference)
        image_storage_service.delete(reference["path"], reference_storage_mode=reference["storage_mode"])
        thumbnail = config.image_thumbnails_dir / f'{reference["path"]}.png'
        thumbnail.unlink(missing_ok=True)
        reference["deleted"] = True
        try:
            self._save_locked()
        except Exception:
            reference.pop("deleted", None)
            raise
        return {"retained": False}

    def submit_turn(self, identity: dict[str, object], submission: dict[str, Any], base_url: str = "") -> dict[str, Any]:
        owner = _owner_id(identity)
        request_id = submission["request_id"]
        payload = {key: submission.get(key) for key in ("prompt", "model", "size", "quality")}
        payload.update(n=1, response_format="url", base_url=base_url)
        references = submission.get("referenceImages", [])
        mode = "edit" if references else "generate"
        with self._lock:
            # One identity's concurrent first submissions resolve the target under the same save lock.
            for existing in self._conversations.values():
                if existing["owner_id"] == owner and any(turn["request_id"] == request_id for turn in existing["turns"]):
                    return self.get_conversation(identity, existing["id"])
            reference_records = [self._owned_reference(identity, image["id"]) for image in references]
            if reference_records:
                payload["images"] = [self.read_reference(identity, image["id"]) for image in reference_records]
                # Shared immutable encoding and upload coordination stay in memory, outside the durable snapshot.
                payload["encoded_images"] = encode_images(payload["images"])
                payload["image_upload_cache"] = ImageUploadCache()
            image_storage_service.check_writable(verify_destinations=True)
            previous_current = self._current.get(owner)
            conversation_id = submission.get("conversation_id") or previous_current
            conversation = (self._owned_conversation(identity, conversation_id) if conversation_id
                            else self._new_conversation(owner, submission["prompt"][:24]))
            previous_conversation = copy.deepcopy(conversation) if conversation_id else None
            source_id = submission.get("source_entry_id")
            if source_id and not any(source["id"] == source_id for source in conversation["sourceEntries"]):
                if not conversation_id:
                    del self._conversations[conversation["id"]]
                    self._restore_current(owner, previous_current)
                raise ValueError("source entry not found in this conversation")
            source_id = source_id or uuid.uuid4().hex
            if not submission.get("source_entry_id"):
                conversation["sourceEntries"].append({"id": source_id, "name": submission["prompt"][:24]})
            turn_id = uuid.uuid4().hex
            now = _now_iso()
            task_ids = [f"{turn_id}-{index}" for index in range(submission["count"])]
            turn = {key: copy.deepcopy(submission[key]) for key in
                    ("prompt", "model", "size", "quality", "count", "ratio", "tier", "referenceImages")}
            turn.update(id=turn_id, sourceEntryId=source_id, mode=mode, createdAt=now,
                        task_ids=task_ids, request_id=request_id)
            turn["referenceImages"] = [self._public_reference(reference) for reference in reference_records]
            for reference in reference_records:
                if turn_id not in reference["turn_ids"]:
                    reference["turn_ids"].append(turn_id)
            conversation["turns"].append(turn)
            conversation["updatedAt"] = now
            if len(conversation["turns"]) == 1:
                conversation["title"] = submission["prompt"][:24]
            for task_id in task_ids:
                self._tasks[_task_key(owner, task_id)] = {
                    **self._new_task(owner, task_id, mode, payload),
                    "image_conversation_id": conversation["id"], "turn_id": turn_id, "source_entry_id": source_id,
                    "prompt": submission["prompt"],
                }
            self._current[owner] = conversation["id"]
            try:
                self._save_locked()
            except Exception:
                for reference in reference_records:
                    if turn_id in reference["turn_ids"]:
                        reference["turn_ids"].remove(turn_id)
                for task_id in task_ids:
                    self._tasks.pop(_task_key(owner, task_id), None)
                if previous_conversation is None:
                    del self._conversations[conversation["id"]]
                else:
                    self._conversations[conversation["id"]] = previous_conversation
                self._restore_current(owner, previous_current)
                raise
        for task_id in task_ids:
            self._start_task(_task_key(owner, task_id), mode, payload, identity)
        return self.get_conversation(identity, conversation["id"])

    def _new_task(self, owner: str, task_id: str, mode: str, payload: dict[str, Any]) -> dict[str, Any]:
        now = _now_iso()
        return {"id": task_id, "owner_id": owner, "status": TASK_STATUS_QUEUED, "mode": mode, "managed": True,
                "model": _clean(payload.get("model"), "gpt-image-2"), "size": _clean(payload.get("size")),
                "quality": _clean(payload.get("quality"), "auto"), "prompt": payload.get("prompt", ""),
                "created_at": now, "updated_at": now, "created_ts": time.time()}

    def _start_task(self, key: str, mode: str, payload: dict[str, Any], identity: dict[str, object]) -> None:
        thread = threading.Thread(target=self._run_task,
                                  args=(key, mode, payload, dict(identity), _clean(payload.get("model"), "gpt-image-2")),
                                  name=f"image-task-{key[-16:]}", daemon=True)
        try:
            thread.start()
        except Exception as exc:
            self._record_failure(key, exc)

    def submit_generation(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        quality: str = "auto",
        base_url: str = "",
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "model": model,
            "n": 1,
            "size": size,
            "quality": quality,
            "response_format": "url",
            "base_url": base_url,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="generate", payload=payload)

    def submit_edit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        quality: str = "auto",
        base_url: str = "",
        images: list[tuple[bytes, str, str]] | None = None,
        masks: list[tuple[bytes, str, str]] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "images": images or [],
            "mask": masks or [],
            "model": model,
            "n": 1,
            "size": size,
            "quality": quality,
            "response_format": "url",
            "base_url": base_url,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="edit", payload=payload)

    def list_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        with self._lock:
            if self._cleanup_locked():
                self._save_locked()
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                else:
                    items.append(_public_task(task))
            if not requested_ids:
                items = [
                    _public_task(task)
                    for task in self._tasks.values()
                    if task.get("owner_id") == owner
                ]
                items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
                missing_ids = []
            return {"items": items, "missing_ids": missing_ids}

    def _submit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        mode: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _clean(client_task_id)
        if not task_id:
            raise ValueError("client_task_id is required")
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        with self._lock:
            cleaned = self._cleanup_locked()
            task = self._tasks.get(key)
            if task is not None:
                if cleaned:
                    self._save_locked()
                return _public_task(task)
            image_storage_service.check_writable(verify_destinations=True)
            task = self._new_task(owner, task_id, mode, payload)
            self._tasks[key] = task
            try:
                self._save_locked()
            except Exception:
                self._tasks.pop(key, None)
                raise

        self._start_task(key, mode, payload, identity)
        return _public_task(task)

    def _run_task(
        self,
        key: str,
        mode: str,
        payload: dict[str, Any],
        identity: dict[str, object],
        model: str,
    ) -> None:
        started = time.time()
        # 创建进度回调，每个步骤完成后更新任务状态
        def progress_callback(step: str) -> None:
            if step == "image_stream_resolve_start":
                self._update_task(key, started_ts=time.time())
            self._update_task(key, progress=step)
        # 将进度回调添加到 payload 中（handler 会提取并传递给 ConversationRequest）
        payload_with_progress = {**payload, "progress_callback": progress_callback}
        try:
            image_storage_service.check_writable()
            self._update_task(key, status=TASK_STATUS_RUNNING, error="")
            handler = self.edit_handler if mode == "edit" else self.generation_handler
            with image_storage_service.owner_scope(_owner_id(identity)):
                result = handler(payload_with_progress)
                if isinstance(result, dict) and isinstance(result.get("data"), list):
                    result = {**result, "data": self._store_task_images(result["data"], identity, payload.get("base_url", ""))}
            if not isinstance(result, dict):
                raise RuntimeError("image task returned streaming result unexpectedly")
            data = result.get("data")
            account_email = _clean(result.get("_account_email") or result.get("account_email"))
            if not isinstance(data, list) or not data:
                upstream = _clean(result.get("message"))
                if upstream:
                    message = upstream
                else:
                    message = "号池中没有可用账号或所有账号均被限流，请检查号池状态（账号额度、是否被封禁、是否到达生图上限）"
                error = RuntimeError(message)
                if account_email:
                    setattr(error, "account_email", account_email)
                raise error
            usage = result.get("usage")
            duration_ms = int((time.time() - started) * 1000)
            self._update_task(key, status=TASK_STATUS_SUCCESS, data=data, usage=usage, error="", duration_ms=duration_ms)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成",
                request_preview=request_text(payload.get("prompt")),
                urls=_collect_image_urls(data),
                account_email=account_email,
            )
        except Exception as exc:
            error_message = str(exc) or "image task failed"
            account_email = _clean(getattr(exc, "account_email", ""))
            conversation_id = _clean(getattr(exc, "conversation_id", ""))
            duration_ms = int((time.time() - started) * 1000)
            self._record_failure(key, exc, duration_ms=duration_ms,
                                 **({"conversation_id": conversation_id} if conversation_id else {}))
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败",
                request_preview=request_text(payload.get("prompt")),
                status="failed",
                error=error_message,
                account_email=account_email,
            )

    def _store_task_images(self, data: list[dict[str, Any]], identity: dict[str, object], base_url: str) -> list[dict[str, Any]]:
        stored = []
        for image in data:
            item = dict(image)
            if item.get("b64_json"):
                if not item.get("url"):
                    item["url"] = image_storage_service.save(base64.b64decode(item["b64_json"], validate=True), base_url).url
                item.pop("b64_json", None)
            path = urlsplit(item.get("url", "")).path
            if path.startswith("/images/"):
                image_storage_service.require_owner(path.removeprefix("/images/"), identity)
            stored.append(item)
        return stored

    def _record_failure(self, key: str, exc: Exception, **updates: Any) -> None:
        updates.update(status=TASK_STATUS_ERROR, error=str(exc) or "image task failed")
        try:
            self._update_task(key, **updates)
        except Exception as save_error:
            # Preserve the actual failure in live reads even if the disk remains unwritable.
            # On restart the last durable unfinished record is reported as interrupted.
            with self._lock:
                task = self._tasks.get(key)
                if task is not None:
                    task.update(updates, error=f"{updates['error']}；保存失败：{save_error}")
            print(f"[image-task] {key}: {updates['error']}; cannot persist failure: {save_error}")

    def _log_call(
        self,
        identity: dict[str, object],
        mode: str,
        model: str,
        started: float,
        suffix: str,
        *,
        request_preview: str = "",
        status: str = "success",
        error: str = "",
        urls: list[str] | None = None,
        account_email: str = "",
    ) -> None:
        endpoint = "/v1/images/edits" if mode == "edit" else "/v1/images/generations"
        summary_prefix = "图生图" if mode == "edit" else "文生图"
        detail = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name"),
            "role": identity.get("role"),
            "endpoint": endpoint,
            "model": model,
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if error:
            detail["error"] = error
        if account_email:
            detail["account_email"] = account_email
        if urls:
            detail["urls"] = list(dict.fromkeys(urls))
        try:
            log_service.add(LOG_TYPE_CALL, f"{summary_prefix}{suffix}", detail)
        except Exception:
            pass

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            self._tasks[key] = {**task, **updates, "updated_at": _now_iso(), "updated_ts": time.time()}
            try:
                self._save_locked()
            except Exception:
                self._tasks[key] = task
                raise

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            self._conversations = raw.get("conversations", {})
            self._current = raw.get("current", {})
            self._references = raw.get("references", {})
        raw_items = raw.get("tasks") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            return {}
        tasks: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            status = _clean(item.get("status"))
            if status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}:
                status = TASK_STATUS_ERROR
            task = {
                **item,
                "id": task_id,
                "owner_id": owner,
                "status": status,
                "mode": "edit" if item.get("mode") == "edit" else "generate",
                "model": _clean(item.get("model"), "gpt-image-2"),
                "size": _clean(item.get("size")),
                "quality": _clean(item.get("quality"), "auto"),
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
                "created_ts": item.get("created_ts"),
                "updated_ts": item.get("updated_ts"),
                "started_ts": item.get("started_ts"),
                "duration_ms": item.get("duration_ms"),
            }
            data = item.get("data")
            if isinstance(data, list):
                task["data"] = data
            usage = item.get("usage")
            if isinstance(usage, dict):
                task["usage"] = usage
            error = _clean(item.get("error"))
            if error:
                task["error"] = error
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        # ponytail: single-process JSON snapshot under one lock; use transactional row storage for larger histories/multiple workers.
        snapshot = {"tasks": list(self._tasks.values()), "conversations": self._conversations, "current": self._current,
                    "references": self._references}
        write_json_atomic(self.path, snapshot)

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        for task in self._tasks.values():
            if task.get("status") in UNFINISHED_STATUSES:
                task["status"] = TASK_STATUS_ERROR
                task["error"] = "服务已重启，未完成的图片任务已中断"
                task["updated_at"] = _now_iso()
                changed = True
        return changed

    def _cleanup_locked(self) -> bool:
        try:
            retention_days = max(1, int(self.retention_days_getter()))
        except Exception:
            retention_days = 30
        cutoff = time.time() - retention_days * 86400
        removed_keys = [
            key
            for key, task in self._tasks.items()
            if not task.get("managed") and task.get("status") in TERMINAL_STATUSES and _timestamp(task.get("updated_at")) < cutoff
        ]
        for key in removed_keys:
            self._tasks.pop(key, None)
        return bool(removed_keys)

    def resume_poll(
        self,
        identity: dict[str, object],
        task_id: str,
        extra_timeout_secs: float = 30.0,
    ) -> dict[str, Any]:
        """恢复对已超时任务的轮询，额外等待 extra_timeout_secs 秒。"""
        owner = _owner_id(identity)
        key = _task_key(owner, _clean(task_id))
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                raise ValueError("task not found")
            if task.get("status") != TASK_STATUS_ERROR:
                raise ValueError("task is not in error state")
            error_msg = _clean(task.get("error"))
            if "超时" not in error_msg:
                raise ValueError("task error is not a timeout error")
            conversation_id = _clean(task.get("conversation_id"))
            if not conversation_id:
                raise ValueError("task has no conversation_id")
            mode = task.get("mode", "generate")
            model = task.get("model", "gpt-image-2")
            # 将任务状态重置为 running
            self._update_task(key, status=TASK_STATUS_RUNNING, error="")

        # 启动新线程继续轮询
        thread = threading.Thread(
            target=self._run_resume_poll,
            args=(key, conversation_id, extra_timeout_secs, dict(identity), mode, model),
            name=f"image-resume-{_clean(task_id)[:16]}",
            daemon=True,
        )
        try:
            thread.start()
        except Exception as exc:
            self._record_failure(key, exc)
        return _public_task(task)

    def _run_resume_poll(
        self,
        key: str,
        conversation_id: str,
        extra_timeout_secs: float,
        identity: dict[str, object],
        mode: str,
        model: str,
    ) -> None:
        """后台线程：继续轮询已有 conversation_id 的图片结果。"""
        started = time.time()
        backend = None
        try:
            from services.openai_backend_api import OpenAIBackendAPI
            from services.protocol.conversation import format_image_result

            backend = OpenAIBackendAPI(proxy_url=config.proxy_url or None)
            file_ids, sediment_ids = backend._poll_image_results(
                conversation_id,
                extra_timeout_secs,
            )
            if not file_ids and not sediment_ids:
                raise RuntimeError(
                    f"继续等待 {extra_timeout_secs} 秒后仍未找到图片结果。"
                )

            image_urls = backend.resolve_conversation_image_urls(
                conversation_id, file_ids, sediment_ids, poll=False,
            )
            if not image_urls:
                raise RuntimeError("图片 URL 解析失败")

            image_items = [
                {"b64_json": __import__("base64").b64encode(image_data).decode("ascii")}
                for image_data in backend.download_image_bytes(image_urls)
            ]
            with image_storage_service.owner_scope(_owner_id(identity)):
                data = format_image_result(image_items, "", "url", "", int(time.time()))["data"]
            self._update_task(key, status=TASK_STATUS_SUCCESS, data=data, error="", duration_ms=int((time.time() - started) * 1000))
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成（续轮询）",
                status="success",
                urls=_collect_image_urls(data),
            )
        except Exception as exc:
            error_message = str(exc) or "resume poll failed"
            duration_ms = int((time.time() - started) * 1000)
            self._record_failure(key, exc, duration_ms=duration_ms)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败（续轮询）",
                status="failed",
                error=error_message,
            )
        finally:
            if backend is not None:
                backend.close()


image_task_service = ImageTaskService(DATA_DIR / "image_tasks.json")
