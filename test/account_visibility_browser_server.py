"""Isolated ticket 16 browser fixture: real account HTTP/storage, controlled upstream."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "ticket-16-browser")

import uvicorn
from fastapi import FastAPI, Header
from fastapi.staticfiles import StaticFiles

import api.accounts as accounts_api
from api.support import require_admin, require_identity
from services.account_service import AccountService
from services.storage.json_storage import JSONStorageBackend


def main():
    with tempfile.TemporaryDirectory(prefix="account-16-") as directory:
        storage = JSONStorageBackend(Path(directory) / "accounts.json")
        service = AccountService(storage)
        service.add_account_items([
            {"access_token": "qa-a", "email": "a@example.test", "quota": 3},
            {"access_token": "qa-b", "email": "b@example.test", "quota": 5, "hidden": True},
            {"access_token": "qa-d", "email": "d@example.test", "quota": 7, "usage_mode": "disabled"},
            {"access_token": "qa-m", "email": "m@example.test", "quota": 11, "usage_mode": "monitor", "refresh_token": "qa-m"},
            {"access_token": "qa-n", "email": "n@example.test", "quota": 13, "usage_mode": "monitor"},
        ])
        accounts_api.account_service = service
        app = FastAPI()
        app.include_router(accounts_api.create_router())

        @app.post("/auth/login")
        def login(authorization: str | None = Header(default=None)):
            identity = require_identity(authorization)
            return {"role": identity["role"], "subject_id": identity["id"], "name": "ticket-16"}

        @app.get("/v1/models")
        def models():
            return {"data": []}

        @app.get("/api/third-party-apps")
        def apps():
            return {"third_party_apps": []}

        @app.get("/version")
        def version():
            return {"version": "test"}

        @app.post("/qa/reload")
        def reload(authorization: str | None = Header(default=None)):
            nonlocal service
            require_admin(authorization)
            service = AccountService(storage)
            accounts_api.account_service = service
            return {"ok": True}

        @app.post("/qa/rotate")
        def rotate(authorization: str | None = Header(default=None)):
            require_admin(authorization)
            service.refresh_access_token("qa-m", force=True)
            return {"ok": True}

        def info(backend):
            account = service.get_account(backend.access_token)
            return {"quota": account["quota"], "status": "正常"}

        app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[1] / "web/out", html=True), name="web")
        with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", autospec=True, side_effect=info), \
             patch("curl_cffi.requests.Session.post", return_value=SimpleNamespace(
                 status_code=200, text="ok", json=lambda: {"access_token": "qa-m-rotated"}
             )):
            uvicorn.run(app, host="127.0.0.1", port=43260)


if __name__ == "__main__":
    main()
