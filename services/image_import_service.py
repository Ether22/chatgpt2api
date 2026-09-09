"""One current import set per identity; reference files belong to ImageTaskService."""
from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path

from services.config import DATA_DIR
from services.image_storage_service import image_storage_service, write_json_atomic
from services.image_task_service import image_task_service
from services.image_import_parser import parse_markdown, validate_candidates
from services.content_filter import check_request
from utils.business_time import beijing_iso


class ImportConflict(ValueError):
    pass


class ImageImportService:
    def __init__(self, directory: Path, references):
        self.directory = directory
        self.references = references
        # ponytail: serialize metadata in this process; per-identity locks if disk writes contend.
        self._lock = threading.RLock()

    def _path(self, identity):
        owner = str(identity.get("id") or "").strip()
        if not owner:
            raise ValueError("identity id is required")
        return self.directory / (hashlib.sha256(owner.encode()).hexdigest() + ".json")

    def _read(self, identity):
        path = self._path(identity)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        return {"version": 0, "revision": 0, "barrier": 0, "md": None, "references": [], "receipts": {}, "pending": None, "updated_at": None}

    def _write(self, identity, state):
        # ponytail: O(n) current-metadata rewrite; use incremental rows for very large import sets.
        state["revision"] += 1
        state["updated_at"] = beijing_iso()
        write_json_atomic(self._path(identity), state)

    @staticmethod
    def _public(state):
        result = {key: state[key] for key in ("version", "revision", "md", "updated_at")}
        pending = state["pending"]
        result["pending"] = ({key: pending[key] for key in ("request_id", "version", "upload_ids", "clear")} if pending else None)
        result["references"] = []
        for item in state["references"]:
            public = {key: value for key, value in item.items() if key != "digest"}
            if pending and item["request_id"] in pending["targets"]:
                public.update(reference=None, error="清理尚未完成，请重试清理")
            result["references"].append(public)
        result["md_version"] = state.get("md_version", 0)
        result["candidates"] = validate_candidates(state.get("candidates", []), result["references"])
        return result

    @staticmethod
    def _check(state, version, *, append=False):
        if state["pending"]:
            raise ImportConflict("素材清理尚未完成，请先重试清理")
        if version != state["version"] and not (append and state["barrier"] <= version < state["version"]):
            raise ImportConflict("素材版本冲突，请刷新当前素材后重新操作")

    @staticmethod
    def _filename(name):
        if not name or len(name) > 255 or "/" in name or "\\" in name or "\x00" in name:
            raise ValueError("文件名无效")
        return name

    @staticmethod
    def _replayed(state, request_id, fingerprint):
        previous = state["receipts"].get(request_id)
        if previous is not None and previous != fingerprint:
            raise ImportConflict("request_id 已用于其他操作，请使用新标识")
        return previous is not None

    def get(self, identity):
        with self._lock:
            return self._public(self._read(identity))

    def correct_candidate(self, identity, request_id, version, md_version, key, changes):
        allowed = {"document_id", "name", "prompt", "size", "output_name", "reference_names", "skipped", "ignored"}
        if not changes or set(changes) - allowed:
            raise ValueError("请提供可修改的候选字段")
        for field, value in changes.items():
            if field in {"skipped", "ignored"}:
                valid = isinstance(value, bool)
            elif field == "reference_names":
                valid = value is None or (isinstance(value, list) and len(value) <= 10000
                         and all(isinstance(name, str) and name and len(name) <= 255 for name in value))
            else:
                valid = (field == "output_name" and value is None) or (isinstance(value, str) and len(value) <= (5 * 1024 * 1024 if field == "prompt" else 255))
            if not valid:
                raise ValueError(f"候选字段无效：{field}")
        digest = hashlib.sha256(json.dumps(changes, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        fingerprint = ["candidate", version, md_version, key, digest]
        with self._lock:
            state = self._read(identity)
            if self._replayed(state, request_id, fingerprint):
                return self._public(state)
            self._check(state, version)
            if md_version != state.get("md_version", 0):
                raise ImportConflict("MD 已替换，请刷新预览后重新操作")
            candidate = next((item for item in state.get("candidates", []) if item["key"] == key), None)
            if candidate is None:
                raise KeyError(key)
            for field, value in changes.items():
                if field in {"skipped", "ignored"}:
                    candidate[field] = value
                else:
                    if field == "size":
                        value = re.sub(r"\s*[×Xx]\s*", "x", value.strip())
                    candidate["config"][field] = value
                    candidate["errors"] = [error for error in candidate["errors"] if error["field"] != field]
            if changes.get("ignored"):
                checked = next(item for item in self._public(state)["candidates"] if item["key"] == key)
                candidate["config"]["reference_names"] = [match["name"] for match in checked["matches"] if match["status"] == "ready"]
                candidate["errors"] = [error for error in candidate["errors"]
                                       if error["code"] == "conflicting_field" and error["field"] != "reference_names"]
            state["version"] += 1
            state["receipts"][request_id] = fingerprint
            self._write(identity, state)
            return self._public(state)

    def validated_candidates(self, identity, version, md_version, keys, *, allow_pending=False):
        """Read a consistent server configuration for submission; this does not pin files.

        The caller must persist/pin its immutable snapshot before dispatching tasks.
        allow_pending admits only registered uploads, never invalid or skipped rows.
        """
        with self._lock:
            state = self._read(identity)
            self._check(state, version)
            if md_version != state.get("md_version", 0):
                raise ImportConflict("MD 已替换，请刷新预览")
            if not keys or len(keys) != len(set(keys)):
                raise ValueError("请选择不重复的候选条目")
            public = self._public(state)
            by_key = {item["key"]: item for item in public["candidates"]}
            selected = []
            for key in keys:
                if key not in by_key:
                    raise KeyError(key)
                candidate = by_key[key]
                if candidate["skipped"] or candidate["status"] == "error" or (candidate["status"] == "pending" and not allow_pending):
                    raise ValueError(f"条目 {candidate['config']['document_id']} 已跳过、有错误或参考图尚未就绪")
                selected.append(candidate)
            return {"version": public["version"], "revision": public["revision"], "md_version": md_version, "candidates": selected}

    def submit_batch(self, identity, body, base_url=""):
        if body.get("draft_id") is None:
            body = {key: value for key, value in body.items() if key != "draft_id"}
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self._lock:
            replay = self.references.replay_batch(identity, body["request_id"], fingerprint)
            if replay is not None:
                return replay
            snapshot = self.validated_candidates(identity, body["version"], body["md_version"],
                                                  [entry["key"] for entry in body["entries"]], allow_pending=True)
        for candidate in snapshot["candidates"]:
            check_request(candidate["config"]["prompt"])
        image_storage_service.check_writable(verify_destinations=True)
        # This lock also guards clear/replace: validation through durable reference pin
        # is one acceptance boundary, even though current metadata is a separate store.
        with self._lock:
            replay = self.references.replay_batch(identity, body["request_id"], fingerprint)
            if replay is not None:
                return replay
            snapshot = self.validated_candidates(identity, body["version"], body["md_version"],
                                                  [entry["key"] for entry in body["entries"]], allow_pending=True)
            state = self._read(identity)
            uploads = {item["request_id"]: item for item in state["references"]}
            submissions = []
            for entry, candidate in zip(body["entries"], snapshot["candidates"]):
                cfg = candidate["config"]
                submissions.append({"request_id": body["request_id"], "conversation_id": body["conversation_id"],
                    "draft_id": body.get("draft_id"),
                    "prompt": cfg["prompt"], "model": body["model"], "quality": body["quality"],
                    "size": cfg["size"], "count": entry["count"] if entry["count"] is not None else body["count"],
                    "ratio": ":".join(cfg["size"].split("x")), "tier": "custom", "referenceImages": [],
                    "md": {**cfg, "document_name": state["md"]["name"], "md_version": body["md_version"],
                           "candidate_key": candidate["key"], "upload_ids": [match["upload_id"] for match in candidate["matches"]]},
                    "uploads": [uploads[match["upload_id"]] for match in candidate["matches"]]})
            return self.references.submit_md_batch(identity, submissions, fingerprint, base_url)

    def replace_md(self, identity, request_id, version, name, data):
        self._filename(name)
        if not name.lower().endswith(".md") or not data or len(data) > 5 * 1024 * 1024:
            raise ValueError("请选择非空的 MD 文件（最大5MB）")
        try:
            content = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("MD 文件必须使用 UTF-8 编码") from exc
        fingerprint = ["md", name, hashlib.sha256(data).hexdigest(), version]
        with self._lock:
            state = self._read(identity)
            if self._replayed(state, request_id, fingerprint):
                return self._public(state)
            self._check(state, version)
            state["md"] = {"name": name, "content": content, "size": len(data)}
            state["version"] += 1
            state["md_version"] = state["version"]
            state["candidates"] = parse_markdown(content, state["md_version"])
            state["receipts"][request_id] = fingerprint
            self._write(identity, state)
            return self._public(state)

    def reserve_reference(self, identity, request_id, version, name, size):
        self._filename(name)
        fingerprint = ["reference", name, size, version]
        with self._lock:
            state = self._read(identity)
            if self._replayed(state, request_id, fingerprint):
                return self._public(state)
            self._check(state, version, append=True)
            if any(item["name"] == name for item in state["references"]):
                raise ImportConflict(f"同名参考图已存在：{name}，请移除后重新添加")
            state["references"].append({"request_id": request_id, "name": name, "size": size,
                                        "reference": None, "error": "等待上传，请重试或移除后重新选择"})
            state["receipts"][request_id] = fingerprint
            state["version"] += 1
            self._write(identity, state)
            return self._public(state)

    def upload_reference(self, identity, request_id, name, data, base_url):
        with self._lock:
            state = self._read(identity)
            if state["pending"]:
                raise ImportConflict("素材清理尚未完成，请先重试清理")
            item = next((item for item in state["references"] if item["request_id"] == request_id), None)
            if item is None:
                raise KeyError(request_id)
            digest = hashlib.sha256(data).hexdigest()
            if item["name"] != name or item["size"] != len(data) or item.get("digest", digest) != digest:
                raise ImportConflict("上传文件与登记不一致，请移除后重新选择")
            if item["reference"]:
                return self._public(state)
            # Save retry identity before the reference ledger or physical files can change.
            item["digest"] = digest
            self._write(identity, state)
        reference = self.references.upload_reference(identity, request_id, data, name, base_url, scope="imports")
        with self._lock:
            state = self._read(identity)
            item = next((item for item in state["references"] if item["request_id"] == request_id), None)
            if item is None or (state["pending"] and request_id in state["pending"]["targets"]):
                raise ImportConflict("该上传已被移除或正在清理，不再加入当前素材")
            item["reference"] = reference
            item.pop("error", None)
            self._write(identity, state)
            return self._public(state)

    def clear(self, identity, request_id, version, upload_ids):
        return self._remove(identity, request_id, version, upload_ids, clear=True)

    def remove_reference(self, identity, request_id, version, upload_id):
        return self._remove(identity, request_id, version, [upload_id], clear=False)

    def _remove(self, identity, request_id, version, upload_ids, *, clear):
        upload_ids = list(dict.fromkeys(upload_ids))
        fingerprint = ["clear" if clear else "remove", version, upload_ids]
        with self._lock:
            state = self._read(identity)
            if self._replayed(state, request_id, fingerprint):
                return self._public(state)
            pending = state["pending"]
            if pending:
                if pending["request_id"] != request_id or pending["fingerprint"] != fingerprint:
                    raise ImportConflict("素材清理尚未完成，请先重试清理")
            else:
                self._check(state, version)
                ids = list(dict.fromkeys([*upload_ids, *([item["request_id"] for item in state["references"]] if clear else [])]))
                pending = {"request_id": request_id, "version": version, "upload_ids": upload_ids,
                           "clear": clear, "targets": ids, "fingerprint": fingerprint}
                state["pending"] = pending
                state["version"] += 1
                if clear:
                    state["barrier"] = state["version"]
                self._write(identity, state)
        # Keep slow file I/O outside the metadata lock. The intent blocks conflicting
        # mutations, but GET and other identities remain available during cleanup.
        for upload_id in pending["targets"]:
            self.references.cancel_reference_upload(identity, upload_id, scope="imports")
        with self._lock:
            state = self._read(identity)
            if self._replayed(state, request_id, fingerprint):
                return self._public(state)
            state["references"] = [item for item in state["references"] if item["request_id"] not in pending["targets"]]
            if clear:
                state["md"] = None
                state["md_version"] = state["version"]
                state["candidates"] = []
            for upload_id in pending["targets"]:
                state["receipts"][upload_id] = ["cancelled"]
            state["pending"] = None
            state["receipts"][request_id] = fingerprint
            self._write(identity, state)
            return self._public(state)


image_import_service = ImageImportService(DATA_DIR / "image_imports", image_task_service)
