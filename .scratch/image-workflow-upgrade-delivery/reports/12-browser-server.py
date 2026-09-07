"""Ticket 12 production UI/HTTP with temporary storage and a controlled upstream."""
import hashlib
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

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "ticket12-bootstrap-only"

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
import uvicorn

from api import accounts, ai, image_imports, image_tasks, support, system
from services import config as config_module, image_storage_service, image_tags_service
from services.account_service import AccountService
from services.auth_service import AuthService
from services.image_task_service import ImageTaskService
from services.image_import_service import ImageImportService
from services.storage.json_storage import JSONStorageBackend
from services.log_service import log_service


sequence = itertools.count(1)
consumed = []


originals = {}
round_sequence = {}
release_result = Event()

def controlled_upstream(payload):
    number = next(sequence)
    local = next(round_sequence.setdefault(payload["prompt"], itertools.count(1)))
    payload["lifecycle_callback"]("sending", {"protocol": "controlled"})
    consumed.append({"number": number, "prompt": payload["prompt"], "size": payload["size"], "quality": payload["quality"], "model": payload["model"]})
    if payload["prompt"].startswith("Round100") and local == 99:
        raise RuntimeError("controlled failed image 99")
    if payload["prompt"].startswith("Round100") and local == 100:
        assert release_result.wait(300)
    fmt = ["PNG", "JPEG", "GIF"][(local - 1) % 3]
    image = Image.new("RGB", (120, 80), ["#f8c06a", "#90cfbc", "#a6bcf5"][(local - 1) % 3])
    ImageDraw.Draw(image).text((5, 5), f"Synthetic {number}", fill="black")
    output = io.BytesIO()
    if fmt == "GIF":
        image.save(output, format=fmt, save_all=True, append_images=[Image.new("RGB", (120, 80), "red")], duration=100, loop=0)
    else:
        image.save(output, format=fmt)
    data = output.getvalue()
    originals[hashlib.sha256(data).hexdigest()] = {"format": fmt, "number": number, "ordinal": local, "prompt": payload["prompt"], "bytes": len(data)}
    return {"data": [{"b64_json": base64.b64encode(data).decode()}]}


if __name__ == "__main__":
    export = ROOT / "web" / "out"
    assert (export / "image" / "index.html").is_file(), "Build web/out first"
    temporary_parent = ROOT / "data" / "ticket12"
    temporary_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temporary_parent) as temporary:
        directory = Path(temporary)
        config_module.DATA_DIR = directory
        log_service.path = directory / "logs.jsonl"
        image_storage_service.image_storage_service.index_file = directory / "image_index.json"
        image_tags_service.TAGS_FILE = directory / "image_tags.json"
        storage = JSONStorageBackend(directory / "accounts.json")
        auth = AuthService(storage)
        for name in ("A", "B"):
            identity, _ = auth.create_key(role="admin", name=f"Synthetic {name}")
            auth.update_key(identity["id"], {"key": f"ticket12-{name}"})
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
        ai.image_task_service = image_tasks.image_task_service
        image_imports.image_import_service = ImageImportService(directory / 'imports', image_tasks.image_task_service)
        app = FastAPI()
        app.include_router(system.create_router("ticket12-test"))
        app.include_router(accounts.create_router())
        app.include_router(ai.create_router())
        app.include_router(image_tasks.create_router())
        app.include_router(image_imports.create_router())
        @app.post("/ticket12-log")
        def add_test_log(body: dict):
            log_service.add("call", "Ticket12 viewer permissions", {"urls": [body["url"]], "status": "success"})
            return {"saved": True}
        @app.get("/ticket12-state")
        def consumption():
            return {"count": len(consumed), "calls": consumed, "originals": originals}
        @app.post("/ticket12-release-result")
        def finish_result():
            release_result.set()
            return {"released": True}
        app.mount("/", StaticFiles(directory=export, html=True), name="web")
        with patch("services.openai_backend_api.OpenAIBackendAPI.list_models", return_value={"data": [{"id": "gpt-image-2"}]}):
            uvicorn.run(app, host="127.0.0.1", port=43220)
