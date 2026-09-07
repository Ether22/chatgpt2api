"""One current import set per identity; reference files belong to ImageTaskService."""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path

from services.config import DATA_DIR
from services.image_storage_service import write_json_atomic
from services.image_task_service import image_task_service
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
            for upload_id in pending["targets"]:
                state["receipts"][upload_id] = ["cancelled"]
            state["pending"] = None
            state["receipts"][request_id] = fingerprint
            self._write(identity, state)
            return self._public(state)


image_import_service = ImageImportService(DATA_DIR / "image_imports", image_task_service)
