"""Ticket 11 only: production UI, real SQLite/PNG and controlled external/failure boundaries."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "ticket11-bootstrap"
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from PIL import Image
import uvicorn
from api import accounts, ai, image_imports, image_tasks, support, system
from services import config as config_module, image_storage_service as storage, image_tags_service as tags
from services.account_service import AccountService
from services.auth_service import AuthService
from services.image_import_service import ImageImportService
from services.image_task_service import ImageTaskService
from services.storage import image_rows
from services.storage.json_storage import JSONStorageBackend
from utils.business_time import beijing_iso

remote, remote_deletes, consumed, temporary_dirs = {}, [], [], []
control = {"delay": 0, "fail": "", "hold": False, "data_failure": False, "unlink_failure": False}
gate = threading.Event()
gate.set()
metrics = {}
directory = None
service = None
reference = None
original_rglob, original_unlink, original_connect = Path.rglob, Path.unlink, sqlite3.connect


class Remote:
    def __init__(self, settings): pass
    def test(self): return {"ok": True}
    def put(self, rel, payload, content_type="image/png"):
        remote[rel] = payload
        return f"https://controlled.example/{rel}"
    def get(self, rel): return remote[rel]
    def delete(self, rel):
        remote_deletes.append(rel)
        time.sleep(control["delay"])
        if control["fail"] and control["fail"] in rel:
            raise OSError("受控 WebDAV 目标副本暂时不可用")
        return remote.pop(rel, None) is not None


def png(color="#90cfbc"):
    output = io.BytesIO()
    Image.new("RGB", (480, 320), color).save(output, format="PNG")
    return output.getvalue()


def upstream(payload):
    payload["lifecycle_callback"]("sending", {"protocol": "controlled"})
    consumed.append(1)
    if control["hold"]:
        assert gate.wait(60)
    return {"data": [{"b64_json": base64.b64encode(png()).decode()}]}


class ObservedConnection(sqlite3.Connection):
    fail_commit = False
    def execute(self, sql, parameters=(), /):
        if sql.startswith("INSERT INTO ") and len(parameters) == 3:
            if metrics.get("active"):
                metrics["persist_rows"] += 1
                metrics["persist_json_bytes"] += len(parameters[2].encode("utf-8"))
            if control["data_failure"] and parameters[0] == "tasks" and json.loads(parameters[2]).get("data"):
                self.fail_commit = True
        if metrics.get("active") and sql.startswith("DELETE FROM "):
            metrics["deleted_rows"] += 1
        return super().execute(sql, parameters)
    def __exit__(self, error_type, error, traceback):
        if error_type is None and self.in_transaction and self.fail_commit:
            self.rollback()
            raise PermissionError("受控迟到结果检查点写入失败")
        return super().__exit__(error_type, error, traceback)


def connect(database, *args, **kwargs):
    kwargs.setdefault("factory", ObservedConnection)
    return original_connect(database, *args, **kwargs)


def rglob(path, *args, **kwargs):
    if metrics.get("active") and directory and path.is_relative_to(directory):
        metrics["directory_scans"] += 1
    return original_rglob(path, *args, **kwargs)


def unlink(path, *args, **kwargs):
    if control["unlink_failure"] and path.is_relative_to(config_module.config.images_dir):
        raise PermissionError("受控本地副本删除失败")
    return original_unlink(path, *args, **kwargs)


def attach_service(restored):
    global service
    service = restored
    image_tasks.image_task_service = ai.image_task_service = service
    image_imports.image_import_service = ImageImportService(directory / "imports", service)
    holders = service._result_holders
    def observed_holders(**kwargs):
        if metrics.get("active"): metrics["holder_builds"] += 1
        return holders(**kwargs)
    service._result_holders = observed_holders
    cleanup = service.cleanup_results
    def observed_cleanup(*args, **kwargs):
        started = time.perf_counter()
        result = cleanup(*args, **kwargs)
        if metrics.get("active"):
            metrics["cleanup_ms"] = round((time.perf_counter() - started) * 1000, 2)
            metrics["finished_at"] = time.perf_counter()
        return result
    service.cleanup_results = observed_cleanup


def seed(count=6, mode="local"):
    global directory, reference
    if service:
        gate.set()
        service.shutdown(3)
    control.update(delay=0, fail="", hold=False, data_failure=False, unlink_failure=False)
    remote.clear(); remote_deletes.clear(); consumed.clear(); metrics.clear()
    temporary = tempfile.TemporaryDirectory(dir=parent)
    temporary_dirs.append(temporary)
    directory = Path(temporary.name)
    config_module.DATA_DIR = directory
    config_module.config.data["image_storage"] = {"enabled": True, "mode": mode, "webdav_url": "https://controlled.example"}
    storage.image_storage_service.index_file = directory / "image_index.sqlite3"
    tags.TAGS_FILE = directory / "tags.json"
    tasks, conversations, index, tag_data = {}, {}, {}, {}
    pixels = png()
    for owner, total in ((identities["A"], count), (identities["B"], 1)):
        owner_id = owner["id"]
        namespace = hashlib.sha256(owner_id.encode()).hexdigest()
        for number in range(2 if owner == identities["A"] else 1):
            cid = f'{"a" if owner == identities["A"] else "b"}-{number}'
            turns, sources = [], []
            per_conversation = total // 2 if owner == identities["A"] else total
            for n in range(0, per_conversation, 100 if count > 100 else 3):
                tid = f"{cid}-turn-{n}"
                ids = []
                for ordinal in range(min(100 if count > 100 else 3, per_conversation - n)):
                    task_id = f"{tid}-{ordinal}"
                    rel = f"managed/{namespace}/2026/09/08/{task_id}.png"
                    original = config_module.config.images_dir / rel
                    original.parent.mkdir(parents=True, exist_ok=True)
                    if mode != "webdav": original.write_bytes(pixels)
                    if mode != "local": remote[rel] = pixels
                    for thumb in (config_module.config.image_thumbnails_dir / rel, config_module.config.image_thumbnails_dir / f"{rel}.png"):
                        thumb.parent.mkdir(parents=True, exist_ok=True)
                        thumb.write_bytes(pixels)
                    index[rel] = {"path": rel, "rel": rel, "name": original.name, "owner_id": owner_id,
                                  "local": mode != "webdav", "webdav": mode != "local", "storage": mode,
                                  "storage_target": storage.image_storage_service.storage_target(), "size": len(pixels),
                                  "width": 480, "height": 320, "date": "2026-09-08", "created_at": beijing_iso()}
                    tag_data[rel] = ["scope-fixture"]
                    ids.append(task_id)
                    tasks[f"{owner_id}:{task_id}"] = {"id": task_id, "owner_id": owner_id, "managed": True,
                        "status": "success", "dispatch_state": "complete", "mode": "generate", "model": "gpt-image-2", "size": "1024x1024",
                        "image_conversation_id": cid, "turn_id": tid, "source_entry_id": tid,
                        "created_at": beijing_iso(), "updated_at": beijing_iso(), "data": [{"url": f"/images/{rel}"}]}
                sources.append({"id": tid, "name": f"Source {n}"})
                turns.append({"id": tid, "sourceEntryId": tid, "prompt": f"Fixture {cid} round {n}", "count": len(ids),
                              "task_ids": ids, "request_id": tid, "referenceImages": [], "mode": "generate", "model": "gpt-image-2",
                              "quality": "auto", "size": "1024x1024", "ratio": "1:1", "tier": "1k", "createdAt": beijing_iso()})
            conversations[cid] = {"id": cid, "owner_id": owner_id, "title": f"Scope gallery {cid}", "createdAt": beijing_iso(),
                                  "updatedAt": beijing_iso(), "turns": turns, "sourceEntries": sources}
    path = directory / "tasks.sqlite3"
    image_rows.save(path, {"tasks": tasks, "conversations": conversations, "current": {identities["A"]["id"]: "a-0", identities["B"]["id"]: "b-0"}})
    image_rows.save(storage.image_storage_service.index_file, {"images": index})
    tags.save_tags(tag_data)
    attach_service(ImageTaskService(path, generation_handler=upstream, edit_handler=upstream))
    reference = service.upload_reference(identities["A"], "current-reference", png("#eab4d1"), "shared.png", "")
    service.retain_reference(identities["A"], reference["id"], scope="imports")
    return {"count": count, "reference": reference}


if __name__ == "__main__":
    parent = ROOT / "data" / "ticket11"
    parent.mkdir(parents=True, exist_ok=True)
    auth_storage = JSONStorageBackend(parent / f"synthetic-accounts-{os.getpid()}.json")
    auth = AuthService(auth_storage)
    identities = {}
    for label in ("A", "B"):
        owner, key = auth.create_key(role="admin", name=f"Synthetic {label}")
        auth.update_key(owner["id"], {"key": f"ticket11-{label}"})
        identities[label] = owner
    support.auth_service = accounts.auth_service = auth
    accounts.account_service = AccountService(auth_storage)
    with patch.object(storage, "WebDAVClient", Remote), patch.object(sqlite3, "connect", connect), \
         patch.object(Path, "rglob", rglob), patch.object(Path, "unlink", unlink), \
         patch("services.openai_backend_api.OpenAIBackendAPI.list_models", return_value={"data": [{"id": "gpt-image-2"}]}):
        seed()
        app = FastAPI()
        for router in (system.create_router("ticket11"), accounts.create_router(), ai.create_router(), image_tasks.create_router(), image_imports.create_router()):
            app.include_router(router)
        @app.post("/ticket11/seed")
        def seed_route(body: dict): return seed(body.get("count", 6), body.get("mode", "local"))
        @app.post("/ticket11/control")
        def configure(body: dict):
            control.update(body)
            if control["hold"]: gate.clear()
            else: gate.set()
            return control
        @app.post("/ticket11/restart")
        def restart():
            service.shutdown(3)
            attach_service(ImageTaskService(service.path, generation_handler=upstream, edit_handler=upstream))
            service.start()
            return {"ok": True}
        @app.post("/ticket11/measure")
        def measure():
            metrics.update(active=True, holder_builds=0, directory_scans=0, persist_rows=0, persist_json_bytes=0, deleted_rows=0,
                           started_at=time.perf_counter())
            return {"ok": True}
        @app.get("/ticket11/state")
        def state():
            return {"local": [p.relative_to(config_module.config.images_dir).as_posix() for p in original_rglob(config_module.config.images_dir, "*.png")],
                    "thumbnails": [p.relative_to(config_module.config.image_thumbnails_dir).as_posix() for p in original_rglob(config_module.config.image_thumbnails_dir, "*.png")],
                    "remote": list(remote), "remote_deletes": list(remote_deletes), "consumed": len(consumed),
                    "tags": tags.load_tags(), "metrics": dict(metrics), "reference": reference}
        app.mount("/", StaticFiles(directory=ROOT / "web" / "out", html=True), name="web")
        try:
            uvicorn.run(app, host="127.0.0.1", port=43210)
        finally:
            control.update(data_failure=False, unlink_failure=False, hold=False)
            gate.set()
            service.shutdown(3)
            for temporary in temporary_dirs: temporary.cleanup()
