"""Real local HTTP/storage with a fixed business clock and controlled image upstream."""
import base64
import os
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

import uvicorn
from fastapi.testclient import TestClient
from api.app import create_app
from services.account_service import AccountService
from services.auth_service import AuthService
from services.config import config
from services.image_task_service import ImageTaskService
from services.log_service import LogService
from services.storage.json_storage import JSONStorageBackend
from test.test_account_export import make_jwt
from test.test_beijing_business_time import FrozenDateTime
from test.test_beijing_business_time_stage_b import server_timezone
from test.test_image_conversations_http import image_bytes, submit, wait_for_history


def main():
    with TemporaryDirectory(prefix="beijing-18b-") as directory, ExitStack() as stack:
        root = Path(directory)
        stack.enter_context(server_timezone("UTC0"))
        stack.enter_context(patch("services.config.DATA_DIR", root))
        stack.enter_context(patch("utils.business_time.datetime", FrozenDateTime))
        stack.enter_context(patch.dict(os.environ, {"CHATGPT2API_BASE_URL": "http://127.0.0.1:43282"}))
        stack.enter_context(patch("curl_cffi.requests.Session.request", side_effect=AssertionError("External transport disabled in browser fixture")))
        stack.enter_context(patch.dict(config.data, {"image_storage": {"mode": "local"}}))
        store = JSONStorageBackend(root / "accounts.json")
        accounts = AccountService(store)
        accounts.add_account_items([{
            "access_token": make_jwt({"exp": 1788796801, "iat": 1788796741}),
            "id_token": make_jwt({"email": "midnight@example.test"}), "refresh_token": "fake",
            "email": "midnight@example.test", "quota": 10, "restore_at": "2026-09-07T15:59:59Z",
        }])
        accounts.add_account_items([{"access_token": "legacy", "email": "legacy@example.test", "created_at": "2026-09-07 16:00:01", "restore_at": "2026-09-07 16:00:01"}])
        upstream = lambda payload: {"data": [{"b64_json": base64.b64encode(image_bytes()).decode()}]}
        tasks = ImageTaskService(root / "tasks.sqlite3", generation_handler=upstream, edit_handler=upstream)
        for target, value in {
            "api.accounts.account_service": accounts,
            "api.support.account_service": accounts,
            "api.support.auth_service": AuthService(store),
            "api.image_tasks.image_task_service": tasks,
            "services.image_storage_service.image_storage_service.index_file": root / "images.sqlite3",
            "services.image_tags_service.TAGS_FILE": root / "tags.json",
            "services.log_service.log_service": LogService(root / "logs.jsonl"),
            "api.support.WEB_DIST_DIR": Path(__file__).resolve().parents[1] / "web/out",
        }.items():
            stack.enter_context(patch(target, value))
        app = create_app()
        # Seed through the same public routes consumed by the browser.
        env = {"client": TestClient(app), "headers": {"Authorization": "Bearer chatgpt2api"}}
        assert submit(env, prompt="midnight image").status_code == 200
        history = wait_for_history(env)
        assert history["items"][0]["createdAt"].endswith("+08:00")
        uvicorn.run(app, host="127.0.0.1", port=43282, lifespan="off", log_level="warning")


if __name__ == "__main__":
    main()
