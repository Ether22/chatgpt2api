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
from concurrent.futures import Future
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from services.config import DATA_DIR, config
from services.content_filter import request_text
from services.log_service import LOG_TYPE_CALL, log_service
from services.image_storage_service import ImageStorageError, image_storage_service, is_managed_image
from services.storage import image_rows
from PIL import Image, UnidentifiedImageError
from utils.business_time import beijing_iso
from services.protocol import openai_v1_image_edit, openai_v1_image_generations
from services.protocol.conversation import encode_images
from services.openai_backend_api import ImageUploadCache
from utils.redact import redact

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}


def _now_iso() -> str:
    return beijing_iso()


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    try:
        # Keep the offset after microseconds; unzoned history retains local semantics.
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
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
    if task.get("data") is not None and not task.get("result_deleted"):
        item["data"] = task.get("data")
    if task.get("usage") is not None:
        item["usage"] = task.get("usage")
    if task.get("error"):
        item["error"] = task.get("error")
    if task.get("progress"):
        item["progress"] = task.get("progress")
    if task.get("duration_ms") is not None:
        item["duration_ms"] = task.get("duration_ms")
    for field in ("dispatch_state", "error_code", "error_detail", "retryable", "can_resume", "waiting", "result_deleted", "result_cleanup"):
        if field in task:
            item[field] = copy.deepcopy(task[field])
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


class TaskServiceStopped(BaseException):
    """Leave the last durable checkpoint for the next service instance."""


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_generations.handle,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_edit.handle,
        retention_days_getter: Callable[[], int] | None = None,
    ):
        self.path = path.with_suffix(".sqlite3")
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self._conversations: dict[str, dict[str, Any]] = {}
        self._current: dict[str, str] = {}
        self._references: dict[str, dict[str, Any]] = {}
        self._reference_locks: dict[str, threading.RLock] = {}
        self._result_cleanup_locks: dict[str, threading.Lock] = {}
        self._stopping = threading.Event()
        self._workers: dict[str, threading.Thread] = {}
        self._deleted_tasks: set[str] = set()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            changed = self._recover_unfinished_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked(tasks=self._tasks)

    def start(self) -> None:
        """Recover accepted work after the application has initialized its services."""
        with self._lock:
            self._stopping.clear()
            payloads = {}
            for key, task in self._tasks.items():
                if task["status"] in UNFINISHED_STATUSES and task.get("dispatch_state") == "pending":
                    payload = payloads.setdefault(task.get("turn_id") or key, {**task["request"], "_preparation": Future()})
                    self._start_task(key, task["mode"], payload, task.get("identity") or {"id": task["owner_id"]})
                elif task.get("dispatch_state") in {"sent", "unknown"}:
                    self._start_recovery(key, task.get("identity") or {"id": task["owner_id"]}, 30)

    def shutdown(self, timeout: float = 1.0) -> None:
        self._stopping.set()
        with self._lock:
            workers = list(self._workers.values())
        deadline = time.monotonic() + timeout
        for worker in workers:
            worker.join(max(0, deadline - time.monotonic()))

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
                             and image_id not in turn.get("dismissedImageIds", [])
                             and not self._tasks[_task_key(item["owner_id"], image_id)].get("result_deleted"))):
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

    def conversation_metadata(self, identity: dict[str, object], conversation_id: str) -> dict[str, Any]:
        with self._lock:
            return self._conversation_metadata(self._owned_conversation(identity, conversation_id))

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
            turn["resultCleanups"] = []
            for ordinal, task_id in enumerate(saved["task_ids"], 1):
                stored_task = self._tasks[_task_key(item["owner_id"], task_id)]
                if stored_task.get("result_deleted"):
                    if not navigation and stored_task["result_cleanup"]["state"] != "complete":
                        turn["resultCleanups"].append({"id": task_id, "ordinal": ordinal, **stored_task["result_cleanup"]})
                    continue
                if saved.get("resultsDeleted"):
                    continue
                if task_id in saved.get("dismissedImageIds", []):
                    continue
                task = _public_task(self._tasks[_task_key(item["owner_id"], task_id)])
                status = task["status"]
                image = {"id": task_id, "taskId": task_id, "ordinal": ordinal,
                         "status": status if status in TERMINAL_STATUSES else "loading"}
                if status not in TERMINAL_STATUSES:
                    image["taskStatus"] = status
                if task.get("data") and not navigation:
                    image.update(task["data"][0])
                for source, target in (("error", "error"), ("progress", "progress"),
                                       ("elapsed_secs", "elapsedSecs"), ("duration_ms", "durationMs"), ("updated_at", "updatedAt"),
                                       ("error_code", "errorCode"), ("error_detail", "errorDetail"),
                                       ("can_resume", "canResume"), ("retryable", "retryable"),
                                       ("dispatch_state", "dispatchState"), ("waiting", "waiting")):
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
                self._save_locked(conversations=[conversation["id"]], current=[owner])
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
                self._save_locked(current=[owner])
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
                self._save_locked(conversations=[conversation_id])
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
                self._save_locked(conversations=[item["id"] for item in targets], current=[owner])
            except Exception:
                for item in targets:
                    item.pop("deleted", None)
                self._restore_current(owner, previous_current)
                raise

    def delete_result(self, identity: dict[str, object], conversation_id: str, turn_id: str, task_id: str) -> dict[str, Any]:
        """Commit invisibility before scheduling physical cleanup; retries use the same task tombstone."""
        key = _task_key(_owner_id(identity), task_id)
        with self._lock:
            conversation = self._owned_conversation(identity, conversation_id)
            turn = next((turn for turn in conversation["turns"] if turn["id"] == turn_id), None)
            if not turn or task_id not in turn["task_ids"]:
                raise KeyError("result not found")
            task = self._tasks[key]
            if task["status"] != TASK_STATUS_SUCCESS:
                raise ValueError("仅支持删除已完成的单张结果")
            if not task.get("result_deleted") or task["result_cleanup"]["state"] in {"error", "retained"}:
                now = _now_iso()
                updated = {**task, "result_deleted": True, "updated_at": now, "updated_ts": time.time(),
                           "result_cleanup": {"state": "pending", "updated_at": now}}
                generated_holders, held = self._result_holders(exclude_key=key)
                with image_storage_service._index_lock:
                    visibility = {}
                    for path in self._result_paths(task):
                        if not is_managed_image(path) or not image_storage_service.can_access(path, identity):
                            raise ImageStorageError("结果文件不属于当前登录身份")
                        if path not in generated_holders:
                            item = image_rows.get(image_storage_service.index_file, "images", path) or {}
                            visibility[path] = {**item, "result_hidden": True, "deleting": path not in held}
                    image_rows.save_result_deletion(self.path, key, updated, image_storage_service.index_file, visibility)
                self._tasks[key] = updated
            return {"id": task_id, **copy.deepcopy(self._tasks[key]["result_cleanup"])}

    @staticmethod
    def _result_paths(task: dict[str, Any]) -> set[str]:
        return {urlsplit(image.get("url", "")).path.removeprefix("/images/")
                for image in task.get("data", []) if urlsplit(image.get("url", "")).path.startswith("/images/")}

    def _result_holders(self, *, exclude_key: str = "") -> tuple[set[str], set[str]]:
        # ponytail: scan existing holders on single deletion; add a reverse index if bulk profiling requires it.
        generated = {path for key, task in self._tasks.items() if key != exclude_key and not task.get("result_deleted")
                     for path in self._result_paths(task)}
        return generated, generated | {ref["path"] for ref in self._references.values()
                                       if not ref.get("deleted") and (ref["input_scopes"] or ref["turn_ids"])}

    def cleanup_result(self, identity: dict[str, object], task_id: str) -> None:
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        with self._lock:
            lock = self._result_cleanup_locks.setdefault(key, threading.Lock())
        with lock:
            with self._lock:
                task = self._tasks.get(key)
                if not task or not task.get("result_deleted"):
                    raise KeyError("deleted result not found")
                if task["result_cleanup"]["state"] == "complete":
                    return
                paths = self._result_paths(task)
                generated_holders, held = self._result_holders()
            try:
                if not paths and task.get("data"):
                    raise ImageStorageError("结果没有可验证的服务器文件位置，无法确认物理清理")
                for path in paths:
                    # Ownership is checked against server-held task data, never a client-supplied file path.
                    if not is_managed_image(path) or not image_storage_service.can_access(path, identity):
                        raise ImageStorageError("结果文件不属于当前登录身份")
                    if path not in generated_holders:
                        image_storage_service.hide_result(path)
                    if path not in held:
                        image_storage_service.delete(path)
                cleanup = {"state": "retained" if paths & held else "complete", "updated_at": _now_iso()}
            except Exception as exc:
                cleanup = {"state": "error", "error": redact(str(exc), [config.auth_key]), "updated_at": _now_iso()}
            with self._lock:
                previous = self._tasks[key]
                self._tasks[key] = {**previous, "result_cleanup": cleanup,
                                    "updated_at": cleanup["updated_at"], "updated_ts": time.time()}
                try:
                    self._save_locked(tasks=[key])
                except Exception:
                    self._tasks[key] = previous
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

    def _reference_lock(self, reference_id: str):
        with self._lock:
            return self._reference_locks.setdefault(reference_id, threading.RLock())

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
        try:
            with Image.open(io.BytesIO(data)) as image:
                mime_type = Image.MIME.get(image.format)
                if mime_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                    raise ValueError("参考图仅支持 PNG、JPEG、WebP、GIF")
                image.verify()
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
            raise ValueError("无法读取参考图") from exc
        image_storage_service.check_writable(verify_destinations=True)
        with self._lock:
            reference = next((item for item in self._references.values()
                              if item["owner_id"] == owner and item["request_id"] == request_id and item["upload_scope"] == scope), None)
            if reference:
                if (reference.get("deleted") or reference.get("upload_cancelled") or reference.get("digest", digest) != digest
                        or reference["name"] != name or reference["size"] != len(data)):
                    raise ValueError("上传request_id已使用，请为新文件使用新标识")
                if not reference["input_scopes"] and not reference["turn_ids"]:
                    raise ValueError("该上传正在清理，请使用新request_id")
            if reference is None or reference.get("state") == "reserved":
                previous = copy.deepcopy(reference)
                with image_storage_service.owner_scope(owner):
                    path = image_storage_service.make_reference_path(mime_type)
                reference_id = reference["id"] if reference else uuid.uuid4().hex
                reference = {**(reference or {}), "id": reference_id, "owner_id": owner, "request_id": request_id,
                             "name": name, "type": mime_type, "url": f"/images/{path}", "size": len(data),
                             "path": path, "digest": digest, "input_scopes": [scope], "upload_scope": scope,
                             "turn_ids": reference["turn_ids"] if reference else [],
                             "created_at": beijing_iso(), "state": "pending",
                             "storage_mode": image_storage_service.mode(),
                             "storage_target": self._reference_storage_target()}
                self._references[reference_id] = reference
                try:
                    # Record the intended file before either destination can receive bytes.
                    self._save_locked(references=[reference_id])
                except Exception:
                    if previous is None:
                        del self._references[reference_id]
                    else:
                        self._references[reference_id] = previous
                    raise
        with self._reference_lock(reference["id"]):
            with self._lock:
                reference = self._references[reference["id"]]
                if reference.get("deleted") or reference.get("upload_cancelled"):
                    raise ValueError("该上传已取消，请使用新request_id")
                if reference["state"] == "ready":
                    if scope not in reference["input_scopes"] and not reference["turn_ids"]:
                        return self.retain_reference(identity, reference["id"], scope=scope)
                    return self._public_reference(reference)
            self._check_reference_destination(reference)
            with image_storage_service.owner_scope(owner):
                image_storage_service.save(data, base_url, reference=True, reference_path=reference["path"],
                                           storage_mode=reference["storage_mode"])
            with self._lock:
                if reference.get("upload_cancelled"):
                    raise ValueError("该上传已取消，请使用新request_id")
                reference["state"] = "ready"
                try:
                    self._save_locked(references=[reference["id"]])
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
        return image_storage_service.storage_target()

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
        with self._reference_lock(reference_id), self._lock:
            reference = self._owned_reference(identity, reference_id)
            previous = reference["input_scopes"][:]
            reference["input_scopes"] = list(dict.fromkeys([*previous, scope]))
            try:
                self._save_locked(references=[reference_id])
            except Exception:
                reference["input_scopes"] = previous
                raise
            return self._public_reference(reference)

    def read_reference(self, identity: dict[str, object], reference_id: str) -> tuple[bytes, str, str]:
        with self._reference_lock(reference_id):
            with self._lock:
                reference = dict(self._owned_reference(identity, reference_id))
            self._check_reference_destination(reference)
            return image_storage_service.get_bytes(reference["path"]), reference["name"], reference["type"]

    def release_reference(self, identity: dict[str, object], reference_id: str, *, scope: str = "ordinary") -> dict[str, bool]:
        self._validate_reference_scope(scope)
        with self._reference_lock(reference_id):
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
                    self._save_locked(references=[reference_id])
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
                previous = reference.get("upload_cancelled")
                # An accepted turn holds bytes already stored/being stored. A reservation
                # without received bytes cannot be completed after current imports clear.
                reference["upload_cancelled"] = not (reference["turn_ids"] and reference.get("state") in {"pending", "ready"})
                try:
                    self._save_locked(references=[reference["id"]])
                except Exception:
                    if previous is None:
                        reference.pop("upload_cancelled", None)
                    else:
                        reference["upload_cancelled"] = previous
                    raise
            else:
                # Persist cancellation even when DELETE overtakes the multipart upload.
                reference_id = uuid.uuid4().hex
                self._references[reference_id] = {"id": reference_id, "owner_id": owner, "request_id": request_id,
                                                  "upload_scope": scope, "input_scopes": [], "turn_ids": [], "deleted": True}
                try:
                    self._save_locked(references=[reference_id])
                except Exception:
                    del self._references[reference_id]
                    raise
                return {"retained": False}
        return self.release_reference(identity, reference["id"], scope=scope)

    def release_turn_reference(self, identity: dict[str, object], reference_id: str, turn_id: str) -> dict[str, bool]:
        """Deletion callers release each snapshot ID after removing its turn/conversation and settling tasks."""
        owner = _owner_id(identity)
        with self._reference_lock(reference_id):
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
                    self._save_locked(references=[reference_id])
                except Exception:
                    self._references[reference_id] = previous
                    raise
            return self._delete_unused_reference(reference)

    def _delete_unused_reference(self, reference: dict[str, Any]) -> dict[str, bool]:
        if reference["turn_ids"] or reference["input_scopes"]:
            return {"retained": True}
        if reference.get("deleted"):
            return {"retained": False}
        with self._lock:
            retained = any(reference.get("path") in self._result_paths(task) for task in self._tasks.values()
                           if not task.get("result_deleted"))
        # The same existing task/reference records govern both release directions.
        if not retained and reference.get("path"):
            self._check_reference_destination(reference)
            image_storage_service.delete(reference["path"], reference_storage_mode=reference["storage_mode"])
        with self._lock:
            reference["deleted"] = True
            try:
                self._save_locked(references=[reference["id"]])
            except Exception:
                reference.pop("deleted", None)
                raise
        return {"retained": retained}

    def submit_turn(self, identity: dict[str, object], submission: dict[str, Any], base_url: str = "") -> dict[str, Any]:
        return self._submit_turns(identity, [submission], base_url)

    def replay_batch(self, identity, request_id, fingerprint):
        with self._lock:
            for conversation in self._conversations.values():
                if conversation["owner_id"] == _owner_id(identity) and request_id in conversation.get("batches", {}):
                    if conversation["batches"][request_id] != fingerprint:
                        raise ValueError("批量 request_id 已用于其他配置")
                    return self.get_conversation(identity, conversation["id"])
        return None

    def submit_md_batch(self, identity, submissions, fingerprint, base_url=""):
        return self._submit_turns(identity, submissions, base_url, fingerprint)

    def _submit_turns(self, identity, submissions, base_url, batch_fingerprint=None):
        owner = _owner_id(identity)
        first = submissions[0]
        request_id = first["request_id"]
        with self._lock:
            replay = self._replay_submission(identity, request_id, batch_fingerprint)
            if replay is not None:
                return replay
        if batch_fingerprint is None:
            image_storage_service.check_writable(verify_destinations=True)
        with self._lock:
            # One identity's concurrent first submissions resolve the target under the same save lock.
            replay = self._replay_submission(identity, request_id, batch_fingerprint)
            if replay is not None:
                return replay
            previous_current = self._current.get(owner)
            conversation_id = first.get("conversation_id") or previous_current
            conversation = (self._owned_conversation(identity, conversation_id) if conversation_id
                            else self._new_conversation(owner, first["prompt"][:24]))
            previous_conversation = copy.deepcopy(conversation) if conversation_id else None
            previous_references = {}
            starts = []
            try:
                for submission in submissions:
                    records = self._submission_references(identity, submission, previous_references)
                    payload = {key: submission.get(key) for key in ("prompt", "model", "size", "quality")}
                    payload.update(n=1, response_format="url", base_url=base_url,
                                   reference_ids=[record["id"] for record in records], _preparation=Future())
                    mode = "edit" if records else "generate"
                    source_id = submission.get("source_entry_id")
                    md = submission.get("md")
                    if md:
                        source_id = next((source["id"] for source in conversation["sourceEntries"]
                                          if source.get("documentId") == md["document_id"]), None)
                    if source_id and not any(source["id"] == source_id for source in conversation["sourceEntries"]):
                        raise ValueError("source entry not found in this conversation")
                    if not source_id:
                        source_id = uuid.uuid4().hex
                        conversation["sourceEntries"].append({"id": source_id, "name": md["name"] if md else submission["prompt"][:24],
                                                              **({"documentId": md["document_id"]} if md else {})})
                    turn_id, now = uuid.uuid4().hex, _now_iso()
                    payload.update(snapshot_turn_id=turn_id, snapshot_conversation_id=conversation["id"])
                    task_ids = [f"{turn_id}-{index}" for index in range(submission["count"])]
                    turn = {key: copy.deepcopy(submission[key]) for key in
                            ("prompt", "model", "size", "quality", "count", "ratio", "tier")}
                    turn.update(id=turn_id, sourceEntryId=source_id, mode=mode, createdAt=now,
                                task_ids=task_ids, request_id=request_id,
                                referenceImages=[self._public_reference(record) for record in records])
                    if md:
                        turn["md"] = copy.deepcopy(md)
                    for record in records:
                        if turn_id not in record["turn_ids"]:
                            record["turn_ids"].append(turn_id)
                    conversation["turns"].append(turn)
                    conversation["updatedAt"] = now
                    if len(conversation["turns"]) == 1:
                        conversation["title"] = md["name"] if md else submission["prompt"][:24]
                    for task_id in task_ids:
                        key = _task_key(owner, task_id)
                        self._tasks[key] = {**self._new_task(owner, task_id, mode, payload, identity),
                            "image_conversation_id": conversation["id"], "turn_id": turn_id, "source_entry_id": source_id}
                        if any(record["state"] != "ready" for record in records):
                            self._tasks[key].update(progress="waiting_reference", waiting={"reason": "reference", "message": "等待本条参考图上传；关闭页面后仍保留任务"})
                        starts.append((key, mode, payload))
                if batch_fingerprint:
                    conversation.setdefault("batches", {})[request_id] = batch_fingerprint
                self._current[owner] = conversation["id"]
                self._save_locked(tasks=[key for key, _, _ in starts], conversations=[conversation["id"]],
                                  current=[owner], references=previous_references)
            except Exception:
                for reference_id, previous in previous_references.items():
                    if previous is None:
                        self._references.pop(reference_id, None)
                    else:
                        self._references[reference_id] = previous
                for key, _, _ in starts:
                    self._tasks.pop(key, None)
                if previous_conversation is None:
                    del self._conversations[conversation["id"]]
                else:
                    self._conversations[conversation["id"]] = previous_conversation
                self._restore_current(owner, previous_current)
                raise
        for key, mode, payload in starts:
            self._start_task(key, mode, payload, identity)
        return self.get_conversation(identity, conversation["id"])

    def _replay_submission(self, identity, request_id, batch_fingerprint):
        if batch_fingerprint:
            return self.replay_batch(identity, request_id, batch_fingerprint)
        for existing in self._conversations.values():
            if existing["owner_id"] == _owner_id(identity) and any(turn["request_id"] == request_id for turn in existing["turns"]):
                return self.get_conversation(identity, existing["id"])
        return None

    def _submission_references(self, identity, submission, previous):
        records = []
        for upload in submission.get("uploads", []):
            record = next((item for item in self._references.values() if item["owner_id"] == _owner_id(identity)
                           and item["upload_scope"] == "imports" and item["request_id"] == upload["request_id"]), None)
            if record is None:
                reference_id = uuid.uuid4().hex
                previous[reference_id] = None
                record = {"id": reference_id, "owner_id": _owner_id(identity), "request_id": upload["request_id"],
                          "upload_scope": "imports", "input_scopes": ["imports"], "turn_ids": [],
                          "name": upload["name"], "size": upload["size"], "type": "", "url": "",
                          "state": "reserved", "created_at": _now_iso()}
                self._references[reference_id] = record
            if record.get("deleted") or record.get("upload_cancelled") or "imports" not in record["input_scopes"]:
                raise ValueError("该参考图上传已被清理，请刷新素材")
            records.append(record)
        if "md" not in submission:
            records = [self._owned_reference(identity, image["id"]) for image in submission.get("referenceImages", [])]
        for record in records:
            if record["id"] not in previous:
                previous[record["id"]] = copy.deepcopy(record)
        return records

    def _new_task(self, owner: str, task_id: str, mode: str, payload: dict[str, Any],
                  identity: dict[str, object]) -> dict[str, Any]:
        now = _now_iso()
        return {"id": task_id, "owner_id": owner, "status": TASK_STATUS_QUEUED, "mode": mode, "managed": True,
                "model": _clean(payload.get("model"), "gpt-image-2"), "size": _clean(payload.get("size")),
                "quality": _clean(payload.get("quality"), "auto"), "prompt": payload.get("prompt", ""),
                "created_at": now, "updated_at": now, "created_ts": time.time(), "dispatch_state": "pending",
                "identity": {key: identity[key] for key in ("id", "name", "role") if key in identity},
                "request": {key: payload[key] for key in ("prompt", "model", "size", "quality", "n",
                            "response_format", "base_url", "reference_ids", "inputs_id", "snapshot_turn_id", "snapshot_conversation_id") if key in payload}}

    def _start_task(self, key: str, mode: str, payload: dict[str, Any] | None, identity: dict[str, object]) -> None:
        def run():
            try:
                task = self._tasks[key]
                self._run_task(key, mode, payload if payload is not None else dict(task["request"]),
                               dict(identity), task["model"])
            except TaskServiceStopped:
                pass
            except Exception as exc:
                self._record_failure(key, exc)
            finally:
                with self._lock:
                    self._workers.pop(key, None)

        with self._lock:
            if self._stopping.is_set() or key in self._workers:
                return
            thread = threading.Thread(target=run, name=f"image-task-{key[-16:]}", daemon=True)
            self._workers[key] = thread
            try:
                thread.start()
            except Exception as exc:
                self._workers.pop(key, None)
                self._record_failure(key, exc)

    def _prepare_payload(self, payload: dict[str, Any], identity: dict[str, object]) -> dict[str, Any]:
        with self._lock:
            future = payload.setdefault("_preparation", Future())
            prepare = not future.running() and not future.done()
            if prepare:
                future.set_running_or_notify_cancel()
        if prepare:
            try:
                prepared = {key: value for key, value in payload.items() if key != "_preparation"}
                if prepared.get("reference_ids"):
                    self._wait_for_references(identity, prepared)
                    prepared["images"] = [self.read_reference(identity, reference_id) for reference_id in prepared["reference_ids"]]
                if prepared.get("inputs_id") and not prepared.get("images"):
                    inputs = image_rows.get(self.path, "inputs", prepared["inputs_id"])
                    if inputs is None:
                        raise RuntimeError("恢复所需的图片输入不存在")
                    for field in ("images", "mask"):
                        prepared[field] = [(base64.b64decode(data, validate=True), name, mime)
                                           for data, name, mime in inputs.get(field, [])]
                if prepared.get("images"):
                    prepared["encoded_images"] = encode_images(prepared["images"])
                    prepared["image_upload_cache"] = ImageUploadCache()
                future.set_result(prepared)
            except BaseException as exc:
                future.set_exception(exc)
                raise
        return future.result()

    def _wait_for_references(self, identity, payload):
        reference_ids = payload["reference_ids"]
        while True:
            with self._lock:
                conversation_id = payload.get("snapshot_conversation_id")
                if conversation_id:
                    conversation = self._owned_conversation(identity, conversation_id)
                    turn = next((turn for turn in conversation["turns"] if turn["id"] == payload["snapshot_turn_id"]), None)
                    if turn is None or turn.get("resultsDeleted"):
                        raise ValueError("本轮已删除，未发送生成请求")
                records = [self._references.get(reference_id) for reference_id in reference_ids]
                if any(not record or record["owner_id"] != _owner_id(identity) or record.get("deleted")
                       or record.get("upload_cancelled") for record in records):
                    raise ValueError("本轮等待的原始参考图上传已取消，未发送生成请求；请重新提交")
                if all(record["state"] == "ready" for record in records):
                    # Freeze the completed reference metadata before any consumption.
                    if conversation_id:
                        snapshot = [self._public_reference(record) for record in records]
                        if turn["referenceImages"] != snapshot:
                            previous = turn["referenceImages"]
                            previous_updated = conversation["updatedAt"]
                            turn["referenceImages"] = snapshot
                            conversation["updatedAt"] = _now_iso()
                            try:
                                self._save_locked(conversations=[conversation_id])
                            except Exception:
                                turn["referenceImages"] = previous
                                conversation["updatedAt"] = previous_updated
                                raise
                    return
            if self._stopping.wait(.2):
                raise TaskServiceStopped()

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

    def list_tasks(self, identity: dict[str, object], task_ids: list[str], versions: dict[str, str] | None = None) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        with self._lock:
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                elif not versions or versions.get(task_id) != task.get("updated_at"):
                    items.append(_public_task(task))
            if not requested_ids and versions is None:
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
            if key in self._tasks:
                return _public_task(self._tasks[key])
        image_storage_service.check_writable(verify_destinations=True)
        with self._lock:
            task = self._tasks.get(key)
            if task is not None:
                return _public_task(task)
            inputs = {}
            if payload.get("images") or payload.get("mask"):
                payload["inputs_id"] = key
                inputs[key] = {field: [(base64.b64encode(data).decode("ascii"), name, mime)
                                      for data, name, mime in payload.get(field, [])] for field in ("images", "mask")}
            task = self._new_task(owner, task_id, mode, payload, identity)
            self._tasks[key] = task
            try:
                self._save_locked(tasks=[key], inputs=inputs)
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
        def lifecycle_callback(event: str, checkpoint: dict[str, Any]) -> None:
            if self._stopping.is_set():
                raise TaskServiceStopped()
            if event == "ready":
                remaining = max(0, float(self._tasks[key].get("retry_not_before") or 0) - time.time())
                if self._stopping.wait(remaining):
                    raise TaskServiceStopped()
            elif event == "sending":
                image_storage_service.check_writable()
                with self._lock:
                    if self._tasks[key].get("dispatch_state") != "pending":
                        raise RuntimeError("图片请求已经发送，不能重复消费")
                    self._update_task(key, dispatch_state="sent", status=TASK_STATUS_RUNNING, waiting=None,
                                      sent_at=time.time(), upstream=checkpoint, started_ts=time.time(), retry_not_before=None)
            elif event == "conversation":
                self._update_task(key, conversation_id=checkpoint["conversation_id"])
            elif event == "waiting":
                self._update_task(key, status=TASK_STATUS_QUEUED, progress="waiting_account", waiting=checkpoint)
            elif event == "retry_rejected":
                with self._lock:
                    if self._tasks[key].get("dispatch_state") not in {"pending", "rejected"}:
                        raise RuntimeError("请求结果未知，不能重新发送")
                    self._update_task(key, dispatch_state="pending", status=TASK_STATUS_QUEUED,
                                      upstream=None, conversation_id="", sent_at=None)
            elif event == "rejected":
                delay = str(checkpoint.get("retry_after") or "")
                retry_at = time.time() + int(delay) if checkpoint.get("status_code") == 429 and delay.isdigit() and int(delay) > 0 else None
                with self._lock:
                    self._update_task(key, dispatch_state="rejected", retry_not_before=retry_at,
                                      status=TASK_STATUS_QUEUED if retry_at else self._tasks[key]["status"],
                                      waiting={"reason": "quota", "message": "上游限流，等待明确恢复时间",
                                               "restore_at": beijing_iso(datetime.fromtimestamp(retry_at).astimezone())} if retry_at else None,
                                      last_rejection={**checkpoint, "at": _now_iso(), "upstream": self._tasks[key].get("upstream")})
        # 创建进度回调，每个步骤完成后更新任务状态
        def progress_callback(step: str) -> None:
            if step == "image_stream_resolve_start":
                self._update_task(key, started_ts=time.time())
            self._update_task(key, progress=step)
        # 将进度回调添加到 payload 中（handler 会提取并传递给 ConversationRequest）
        try:
            payload = self._prepare_payload(payload, identity)
            lifecycle_callback("ready", {})
            payload_with_progress = {**payload, "progress_callback": progress_callback, "lifecycle_callback": lifecycle_callback}
            image_storage_service.check_writable()
            self._update_task(key, error="")
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
            self._update_task(key, status=TASK_STATUS_SUCCESS, dispatch_state="complete", data=data, usage=usage,
                              error="", error_detail="", error_code="", retryable=False, can_resume=False,
                              waiting=None, duration_ms=duration_ms)
            self._cleanup_completed_upstream(key)
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
        except TaskServiceStopped:
            return
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

    def _cleanup_completed_upstream(self, key: str) -> None:
        if not (config.image_remove_conversation_always or config.image_remove_conversation_after_result):
            return
        backend = None
        try:
            from services.openai_backend_api import OpenAIBackendAPI, account_service
            task = self._tasks[key]
            upstream = task.get("upstream") or {}
            if upstream.get("protocol") != "web" or not task.get("conversation_id"):
                return
            token = account_service.image_recovery_token(upstream.get("account_ref", ""))
            if not token:
                return
            backend = OpenAIBackendAPI(access_token=token)
            if upstream.get("base_url") == backend.base_url:
                backend.delete_conversation(task["conversation_id"])
        except Exception as exc:
            print(redact(f"[image-task] completed upstream cleanup failed: {exc}"))
        finally:
            if backend is not None:
                backend.close()

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
        from services.openai_backend_api import account_service
        message = redact(str(exc) or "image task failed", [config.auth_key, *account_service.list_tokens()])
        updates.update(status=TASK_STATUS_ERROR, error=message)
        with self._lock:
            task = self._tasks.get(key, {})
            sent = task.get("dispatch_state") in {"sent", "unknown"}
            dispatch_state = "unknown" if sent else task.get("dispatch_state", "pending")
            upstream = task.get("upstream") or {}
        code = getattr(exc, "code", None) or ("quota_unavailable" if "image quota" in message else
                "timeout" if isinstance(exc, TimeoutError) or "超时" in message or "timed out" in message.lower() else
                "storage_error" if isinstance(exc, OSError) and not isinstance(exc, ConnectionError) else "image_task_failed")
        detail = {"task_id": task.get("id"), "type": type(exc).__name__, "code": code, "message": message,
                  "dispatch_state": dispatch_state}
        if task.get("conversation_id"):
            detail["conversation_id"] = task["conversation_id"]
        if exc.__cause__:
            detail["cause"] = redact(str(exc.__cause__), [config.auth_key, *account_service.list_tokens()])
        updates.update(retryable=not sent, dispatch_state=detail["dispatch_state"], error_code=code,
                       error_detail=json.dumps(detail, ensure_ascii=False, indent=2),
                       can_resume=sent and upstream.get("protocol") == "web" and bool(upstream.get("account_ref")))
        try:
            self._update_task(key, **updates)
        except Exception as save_error:
            # Preserve the actual failure in live reads even if the disk remains unwritable.
            # On restart the last durable unfinished record is reported as interrupted.
            with self._lock:
                task = self._tasks.get(key)
                if task is not None:
                    task.update(updates, error=f"{updates['error']}；保存失败：{redact(str(save_error))}")
            print(redact(f"[image-task] {key}: {updates['error']}; cannot persist failure: {save_error}"))

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
            "started_at": beijing_iso(datetime.fromtimestamp(started).astimezone()),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if error:
            from services.openai_backend_api import account_service
            detail["error"] = redact(error, [config.auth_key, *account_service.list_tokens()])
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
            if self._stopping.is_set():
                raise TaskServiceStopped()
            task = self._tasks.get(key)
            if task is None:
                return
            if all(task.get(field) == value for field, value in updates.items()):
                return
            self._tasks[key] = {**task, **updates, "updated_at": _now_iso(), "updated_ts": time.time()}
            try:
                self._save_locked(tasks=[key])
            except Exception:
                self._tasks[key] = task
                raise

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        self._conversations = image_rows.load(self.path, "conversations")
        self._current = image_rows.load(self.path, "current")
        self._references = image_rows.load(self.path, "references")
        return image_rows.load(self.path, "tasks")

    def _save_locked(self, *, tasks=(), conversations=(), current=(), references=(), inputs=None) -> None:
        changes = {"tasks": {key: self._tasks.get(key) for key in {*tasks, *self._deleted_tasks}},
                   "conversations": {key: self._conversations.get(key) for key in conversations},
                   "current": {key: self._current.get(key) for key in current},
                   "references": {key: self._references.get(key) for key in references}}
        if inputs:
            changes["inputs"] = inputs
        image_rows.save(self.path, changes)
        self._deleted_tasks.clear()

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        for task in self._tasks.values():
            if task.get("status") in UNFINISHED_STATUSES:
                known_rejection = (task.get("dispatch_state") == "rejected" and
                                   (task.get("last_rejection") or {}).get("status_code") == 429 and
                                   isinstance(task.get("retry_not_before"), (int, float)) and task["retry_not_before"] > 0)
                if (task.get("dispatch_state") == "pending" or known_rejection) and task.get("request"):
                    task["dispatch_state"] = "pending"
                    task["status"] = TASK_STATUS_QUEUED
                    task["progress"] = "recovering_queue"
                elif task.get("dispatch_state") == "rejected":
                    task["status"] = TASK_STATUS_ERROR
                    task["error"] = "上游已拒绝该请求，请检查账号或输入后重新提交"
                    task["retryable"] = True
                else:
                    task["status"] = TASK_STATUS_ERROR
                    task["error"] = "服务已重启，已发送任务的结果未知，不能重新生成"
                    task["dispatch_state"] = "unknown"
                    task["retryable"] = False
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
            self._deleted_tasks.add(key)
        return bool(removed_keys)

    def resume_poll(
        self,
        identity: dict[str, object],
        task_id: str,
        extra_timeout_secs: float = 30.0,
    ) -> dict[str, Any]:
        """Verify an uncertain request on its original upstream account, without generating again."""
        owner = _owner_id(identity)
        key = _task_key(owner, _clean(task_id))
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                raise ValueError("task not found")
            if task.get("status") != TASK_STATUS_ERROR:
                raise ValueError("task is not in error state")
            if task.get("dispatch_state") != "unknown":
                raise ValueError("该任务没有待核实的已发送请求")
            self._start_recovery(key, identity, extra_timeout_secs)
            return _public_task(self._tasks[key])

    def _start_recovery(self, key: str, identity: dict[str, object], timeout: float) -> None:
        with self._lock:
            if key in self._workers or self._stopping.is_set():
                return
            task = self._tasks[key]
            self._update_task(key, status=TASK_STATUS_RUNNING, progress="verifying_result", waiting=None)
            def run():
                try:
                    self._run_resume_poll(key, task.get("conversation_id", ""), timeout, dict(identity), task["mode"], task["model"])
                finally:
                    with self._lock:
                        self._workers.pop(key, None)
            thread = threading.Thread(target=run, name=f"image-verify-{key[-16:]}", daemon=True)
            self._workers[key] = thread
            try:
                thread.start()
            except Exception as exc:
                self._workers.pop(key, None)
                self._record_failure(key, exc)

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
            from services.openai_backend_api import OpenAIBackendAPI, account_service
            from services.protocol.conversation import format_image_result

            task = self._tasks[key]
            upstream = task.get("upstream") or {}
            if upstream.get("protocol") != "web":
                raise RuntimeError("该上游协议没有可靠的结果查询接口，结果仍未知；不会重新生成")
            token = account_service.image_recovery_token(upstream.get("account_ref", ""))
            if not token:
                raise RuntimeError("无法找到原上游账号，结果仍未知；不会改用其他账号重新生成")
            backend = OpenAIBackendAPI(access_token=token)
            if upstream.get("base_url") != backend.base_url:
                raise RuntimeError("原上游地址已变更，结果仍未知；请恢复原地址后核实")
            if not conversation_id:
                conversation_id = backend.find_image_conversation(upstream.get("request_id", ""))
                if not conversation_id:
                    raise RuntimeError("没有找到与原请求标识匹配的上游会话，结果仍未知；不会重新生成")
                self._update_task(key, conversation_id=conversation_id)
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
                data = format_image_result(image_items, task.get("prompt", ""), "url",
                                           task.get("request", {}).get("base_url", ""), int(time.time()))["data"]
            self._update_task(key, status=TASK_STATUS_SUCCESS, dispatch_state="complete", data=data, error="",
                              error_detail="", error_code="", retryable=False, can_resume=False,
                              duration_ms=int((time.time() - started) * 1000))
            self._cleanup_completed_upstream(key)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成（续轮询）",
                status="success",
                urls=_collect_image_urls(data),
            )
        except TaskServiceStopped:
            return
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
