"""Serve ticket 06's production page with real temporary auth/task/image storage.

Adapted from 06; only the upstream generator/model catalog are controlled. No real accounts,
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
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "ticket05-bootstrap-only"

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
import uvicorn

from api import accounts, ai, image_imports, image_tasks, support, system
from services import config as config_module, image_storage_service, image_tags_service
from services.account_service import AccountService
from services.auth_service import AuthService
from services.image_task_service import ImageTaskService
from services import openai_backend_api
from test.test_image_conversations_http import image_bytes
from services.image_import_service import ImageImportService
from services.storage.json_storage import JSONStorageBackend


sequence = itertools.count(1)
consumed = []


def controlled_upstream(payload):
    time.sleep(3)
    if "controlled-error" in payload["prompt"]:
        payload["lifecycle_callback"]("sending", {"protocol": "web", "base_url": "https://controlled.test", "account_ref": "synthetic-recovery", "request_id": "controlled-request"})
        payload["lifecycle_callback"]("conversation", {"conversation_id": "controlled-conversation"})
        raise TimeoutError("controlled timeout Authorization: Bearer hidden-secret")
    number = next(sequence)
    consumed.append(number)
    width, height = [(420, 210), (210, 420), (300, 300), (480, 280)][(number - 1) % 4]
    image = Image.new("RGB", (width, height), ["#f8c06a", "#90cfbc", "#a6bcf5", "#eab4d1"][(number - 1) % 4])
    ImageDraw.Draw(image).text((20, 20), f"Synthetic {number}", fill="black", font_size=22)
    output = io.BytesIO()
    image.save(output, format="PNG")
    payload["progress_callback"]("image_stream_resolve_start")
    time.sleep(0.2 * (number % 4))
    return {"data": [{"b64_json": base64.b64encode(output.getvalue()).decode()}]}


class RecoveryBackend(openai_backend_api.OpenAIBackendAPI):
    """Only the upstream boundary is controlled; resume API/storage/worker remain real."""
    def __init__(self, access_token):
        assert access_token == "synthetic-recovery"
        self.base_url = "https://controlled.test"
    def _poll_image_results(self, conversation_id, _timeout):
        assert conversation_id == "controlled-conversation"
        time.sleep(4)
        return ["controlled-file"], []
    def resolve_conversation_image_urls(self, *_args, **_kwargs): return ["https://controlled.test/result.png"]
    def download_image_bytes(self, _urls): return [image_bytes()]
    def delete_conversation(self, _id): return None
    def close(self): pass


if __name__ == "__main__":
    export = ROOT / "web" / "out"
    assert (export / "image" / "index.html").is_file(), "Build web/out first"
    temporary_parent = ROOT / "data" / "ticket05"
    temporary_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temporary_parent) as temporary:
        directory = Path(temporary)
        config_module.DATA_DIR = directory
        image_storage_service.image_storage_service.index_file = directory / "image_index.json"
        image_tags_service.TAGS_FILE = directory / "image_tags.json"
        storage = JSONStorageBackend(directory / "accounts.json")
        auth = AuthService(storage)
        for name in ("A", "B"):
            identity, _ = auth.create_key(role="admin", name=f"Synthetic {name}")
            auth.update_key(identity["id"], {"key": f"ticket05-{name}"})
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
        app.include_router(system.create_router("ticket05-test"))
        app.include_router(accounts.create_router())
        app.include_router(ai.create_router())
        app.include_router(image_tasks.create_router())
        app.include_router(image_imports.create_router())
        @app.get("/ticket05-consumption")
        def consumption():
            return {"count": len(consumed)}
        app.mount("/", StaticFiles(directory=export, html=True), name="web")
        with patch.object(openai_backend_api, "OpenAIBackendAPI", RecoveryBackend), patch.object(openai_backend_api.account_service, "image_recovery_token", return_value="synthetic-recovery"), patch("services.openai_backend_api.OpenAIBackendAPI.list_models", return_value={"data": [{"id": "gpt-image-2"}]}):
            uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TICKET05_PORT", "43150")))
