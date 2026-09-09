"""Serve ticket 08's production page with real temporary auth/task/image storage.

Only the upstream generator/model catalog are controlled. No real accounts,
OAuth, remote storage, or application lifespan workers are used.
"""
import base64
import io
import itertools
import os
from pathlib import Path
import sys
import tempfile
import time
from threading import Event
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "ticket08-bootstrap-only"

from fastapi import FastAPI, Header
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo
import uvicorn

from api import accounts, ai, image_imports, image_tasks, support, system
from services import config as config_module, image_storage_service, image_tags_service
from services import image_task_service as task_module
from services.account_service import AccountService
from services.auth_service import AuthService
from services.image_task_service import ImageTaskService
from services.image_import_service import ImageImportService
from services.storage.json_storage import JSONStorageBackend


sequence = itertools.count(1)
consumed = []
upload_entered, release_upload = Event(), Event()


def controlled_upstream(payload):
    number = next(sequence)
    payload["lifecycle_callback"]("sending", {"protocol": "controlled"})
    consumed.append({"number": number, "prompt": payload["prompt"], "size": payload["size"], "quality": payload["quality"], "model": payload["model"]})
    width, height = [(420, 210), (210, 420), (300, 300), (480, 280)][(number - 1) % 4]
    image = Image.new("RGB", (width, height), ["#f8c06a", "#90cfbc", "#a6bcf5", "#eab4d1"][(number - 1) % 4])
    ImageDraw.Draw(image).text((20, 20), f"Synthetic {number}", fill="black", font_size=22)
    output = io.BytesIO()
    image.save(output, format="PNG")
    payload["progress_callback"]("image_stream_resolve_start")
    time.sleep(0.2 * (number % 4))
    return {"data": [{"b64_json": base64.b64encode(output.getvalue()).decode()}]}


if __name__ == "__main__":
    export = ROOT / "web" / "out"
    assert (export / "image" / "index.html").is_file(), "Build web/out first"
    temporary_parent = ROOT / "data" / "ticket08"
    temporary_parent.mkdir(parents=True, exist_ok=True)
    metadata = PngInfo()
    metadata.add_text("test", "ticket08-slow")
    Image.new("RGB", (24, 16), "blue").save(temporary_parent / "slow.png", pnginfo=metadata)
    Image.new("RGB", (24, 16), "green").save(temporary_parent / "reference.png")
    with tempfile.TemporaryDirectory(dir=temporary_parent) as temporary:
        directory = Path(temporary)
        config_module.DATA_DIR = directory
        image_storage_service.image_storage_service.index_file = directory / "image_index.json"
        image_tags_service.TAGS_FILE = directory / "image_tags.json"
        storage = JSONStorageBackend(directory / "accounts.json")
        auth = AuthService(storage)
        for name in ("A", "B"):
            identity, _ = auth.create_key(role="admin", name=f"Synthetic {name}")
            auth.update_key(identity["id"], {"key": f"ticket08-{name}"})
        support.auth_service = auth
        accounts.auth_service = auth
        storage.save_accounts([
            {"access_token": f"synthetic-{mode}-{status}", "type": "plus", "status": status,
             "usage_mode": mode, "quota": quota, "email": f"{mode}-{quota}@example.test"}
            for mode, status, quota in [("normal", "正常", 3), ("monitor", "正常", 500),
                                        ("disabled", "正常", 600), ("normal", "限流", 700)]
        ])
        accounts.account_service = AccountService(storage)
        image_tasks.image_task_service = ImageTaskService(directory / "tasks.json", generation_handler=controlled_upstream, edit_handler=controlled_upstream)
        task_module.image_task_service = image_tasks.image_task_service
        ai.image_task_service = image_tasks.image_task_service
        image_imports.image_import_service = ImageImportService(directory / 'imports', image_tasks.image_task_service)
        app = FastAPI()
        app.include_router(system.create_router("ticket08-test"))
        app.include_router(accounts.create_router())
        app.include_router(ai.create_router())
        app.include_router(image_tasks.create_router())
        app.include_router(image_imports.create_router())
        @app.get("/ticket08-state")
        def consumption():
            return {"count": len(consumed), "calls": consumed, "upload_entered": upload_entered.is_set()}
        @app.post("/followup-seed-cleanups")
        def seed_cleanups(authorization: str | None = Header(default=None)):
            import copy
            from services.image_task_service import _now_iso
            identity = support.require_identity(authorization)
            service = image_tasks.image_task_service
            with service._lock:
                owner = identity["id"]
                cid, tid = "cleanup-preview", "cleanup-preview-turn"
                task_ids = [f"cleanup-preview-{n}" for n in range(55)]
                service._conversations[cid] = {"id": cid, "owner_id": owner, "title": "已删除的产品图片",
                    "deleted": True, "createdAt": _now_iso(), "updatedAt": _now_iso(), "sourceEntries": [],
                    "turns": [{"id": tid, "task_ids": task_ids}]}
                for n, task_id in enumerate(task_ids):
                    task = service._new_task(owner, task_id, "generate", {"prompt": "synthetic cleanup"}, identity)
                    task.update(image_conversation_id=cid, turn_id=tid, status="error", dispatch_state="cancelled", result_deleted=True,
                        result_cleanup={"state": "error", "error": "演示清理失败：上游连接超时，请重试核实原请求。" * 5})
                    service._tasks[f"{owner}:{task_id}"] = task
                service._save_locked(tasks=[f"{owner}:{tid}" for tid in task_ids], conversations=[cid])
            return {"count": len(task_ids)}
        @app.post("/ticket08-release-upload")
        def release():
            release_upload.set()
            return {"released": True}
        @app.post("/followup-date-gallery")
        def date_gallery(authorization: str | None = Header(default=None)):
            from services.storage import image_rows
            from urllib.parse import urlsplit
            identity = support.require_identity(authorization)
            service = image_tasks.image_task_service
            changes = {}
            with service._lock:
                for number, task in enumerate(task for task in service._tasks.values() if task["owner_id"] == identity["id"] and task.get("data")):
                    for data in task["data"]:
                        rel = urlsplit(data["url"]).path.removeprefix("/images/")
                        item = image_rows.get(image_storage_service.image_storage_service.index_file, "images", rel)
                        day = "2026-09-01" if number < 12 else "2026-09-08"
                        changes[rel] = {**item, "date": day, "created_at": day + f"T08:00:{number:02d}+08:00"}
                        image_tags_service.set_tags(rel, ["keep"])
                image_rows.save(image_storage_service.image_storage_service.index_file, {"images": changes})
            return {"dated": len(changes)}
        @app.post("/ticket08-restart")
        def restart():
            image_tasks.image_task_service.shutdown(5)
            image_tasks.image_task_service = ImageTaskService(directory / "tasks.json", generation_handler=controlled_upstream, edit_handler=controlled_upstream)
            task_module.image_task_service = image_tasks.image_task_service
            ai.image_task_service = image_tasks.image_task_service
            image_imports.image_import_service = ImageImportService(directory / 'imports', image_tasks.image_task_service)
            image_tasks.image_task_service.start()
            return {"restarted": True}
        real_save = image_storage_service.image_storage_service.save
        def save(data, *args, **kwargs):
            if kwargs.get("reference") and b"ticket08-slow" in data:
                upload_entered.set()
                assert release_upload.wait(120), "controlled slow upload timed out"
            return real_save(data, *args, **kwargs)
        image_storage_service.image_storage_service.save = save
        app.mount("/", StaticFiles(directory=export, html=True), name="web")
        with patch("services.openai_backend_api.OpenAIBackendAPI.list_models", return_value={"data": [{"id": "gpt-image-2"}]}):
            uvicorn.run(app, host="127.0.0.1", port=43280)
