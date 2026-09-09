"""Production UI + real temporary 3,200-result dataset; no external consumption."""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "ticket13-bootstrap-only"
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import uvicorn
from api import accounts, ai, image_tasks, support, system
from services import config as config_module
from services.account_service import AccountService
from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend

spec = importlib.util.spec_from_file_location("benchmark", ROOT / ".scratch/image-workflow-upgrade-delivery/reports/13-benchmark.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)

if __name__ == "__main__":
    parent = ROOT / "data" / "ticket14"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temporary:
        directory = Path(temporary)
        config_module.DATA_DIR = directory
        storage = JSONStorageBackend(directory / "accounts.json")
        auth = AuthService(storage)
        owner = None
        for name in ("A", "B"):
            identity, _ = auth.create_key(role="admin", name=f"Synthetic {name}")
            auth.update_key(identity["id"], {"key": f"ticket13-{name}"})
            if name == "A":
                owner = identity["id"]
        support.auth_service = auth
        accounts.auth_service = auth
        accounts.account_service = AccountService(storage)
        image_tasks.image_task_service = benchmark.seed(directory, owner, dense=os.environ.get("TICKET13_DENSE") == "1")
        if True:
            from services.storage import image_rows
            from services.image_task_service import ImageTaskService
            saved = image_rows.load(directory / "tasks.json", "conversations")
            for conversation in saved.values():
                sources = conversation["sourceEntries"][:8]
                for n, source in enumerate(sources):
                    if n % 2 == 0:
                        source.update(documentId=f"SUB{n:02}", name=f"MD item {n}")
                conversation["sourceEntries"] = sources
                for n, turn in enumerate(conversation["turns"]):
                    turn["sourceEntryId"] = sources[n % 8]["id"]
            image_rows.save(directory / "tasks.json", {"conversations": saved})
            image_tasks.image_task_service = ImageTaskService(directory / "tasks.json")
        from services import image_task_service as task_module
        task_module.image_task_service = image_tasks.image_task_service
        ai.image_task_service = image_tasks.image_task_service
        app = FastAPI()
        app.include_router(system.create_router("ticket13-test"))
        app.include_router(accounts.create_router())
        app.include_router(ai.create_router())
        app.include_router(image_tasks.create_router())
        app.mount("/", StaticFiles(directory=ROOT / "web" / "out", html=True), name="web")
        with patch("services.openai_backend_api.OpenAIBackendAPI.list_models", return_value={"data": [{"id": "gpt-image-2"}]}):
            uvicorn.run(app, host="127.0.0.1", port=43290)
