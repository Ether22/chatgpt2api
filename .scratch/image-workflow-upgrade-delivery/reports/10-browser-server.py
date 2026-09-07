"""Real production UI/HTTP/SQLite/files, controlled upstream and WebDAV only."""
import base64
import io
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "ticket10-bootstrap-only"

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from PIL import Image
import uvicorn
from api import accounts, ai, image_imports, image_tasks, support, system
from services import config as config_module, image_storage_service as storage_module, image_tags_service as tags
from services.account_service import AccountService
from services.auth_service import AuthService
from services.image_task_service import ImageTaskService
from services.image_import_service import ImageImportService
from services.storage.json_storage import JSONStorageBackend

remote = {}
control = {"fail": False, "delay": 0.0}
consumed = []

class Remote:
    def __init__(self, settings):
        pass
    def test(self):
        return {"ok": True}
    def put(self, rel, payload, content_type="image/png"):
        remote[rel] = payload
        return f"https://synthetic.example/{rel}"
    def get(self, rel):
        return remote[rel]
    def delete(self, rel):
        time.sleep(control["delay"])
        if control["fail"]:
            raise storage_module.ImageStorageError("受控 WebDAV 副本暂时不可用")
        return remote.pop(rel, None) is not None

def png(color="#a6bcf5"):
    output = io.BytesIO()
    Image.new("RGB", (420, 280), color).save(output, format="PNG")
    return output.getvalue()

def upstream(payload):
    consumed.append(1)
    return {"data": [{"b64_json": base64.b64encode(png()).decode()}]}

if __name__ == "__main__":
    parent = ROOT / "data" / "ticket10"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temporary, patch.object(storage_module, "WebDAVClient", Remote):
        directory = Path(temporary)
        config_module.DATA_DIR = directory
        config_module.config.data["image_storage"] = {"enabled": True, "mode": "both", "webdav_url": "https://synthetic.example"}
        storage_module.image_storage_service.index_file = directory / "image_index.json"
        tags.TAGS_FILE = directory / "image_tags.json"
        storage = JSONStorageBackend(directory / "accounts.json")
        auth = AuthService(storage)
        owner = None
        for name in ("A", "B"):
            identity, _ = auth.create_key(role="admin", name=f"Synthetic {name}")
            auth.update_key(identity["id"], {"key": f"ticket10-{name}"})
            if name == "A":
                owner = identity
        support.auth_service = accounts.auth_service = auth
        accounts.account_service = AccountService(storage)
        service = ImageTaskService(directory / "tasks.sqlite3", generation_handler=upstream, edit_handler=upstream)
        ai.image_task_service = image_tasks.image_task_service = service
        image_imports.image_import_service = ImageImportService(directory / "imports", service)
        reference = service.upload_reference(owner, "reference", png("#eab4d1"), "reference.png", "http://127.0.0.1:43200")
        service.submit_turn(owner, {"request_id": "browser-round", "prompt": "Three blue candidates for deletion verification", "model": "gpt-image-2", "size": "1024x1024", "ratio": "1:1", "tier": "1k", "quality": "auto", "count": 3, "referenceImages": [{"id": reference["id"]}]}, "http://127.0.0.1:43200")
        app = FastAPI()
        for router in (system.create_router("ticket10-test"), accounts.create_router(), ai.create_router(), image_tasks.create_router(), image_imports.create_router()):
            app.include_router(router)
        @app.post("/ticket10-control")
        def controls(body: dict):
            control.update(body)
            return control
        @app.get("/ticket10-storage")
        def files():
            return {"local": [p.relative_to(config_module.config.images_dir).as_posix() for p in config_module.config.images_dir.rglob("*") if p.is_file()],
                    "remote": list(remote), "consumed": len(consumed)}
        app.mount("/", StaticFiles(directory=ROOT / "web" / "out", html=True), name="web")
        with patch("services.openai_backend_api.OpenAIBackendAPI.list_models", return_value={"data": [{"id": "gpt-image-2"}]}):
            uvicorn.run(app, host="127.0.0.1", port=43200)
        service.shutdown()
