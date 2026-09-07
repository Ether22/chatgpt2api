"""Ticket 17 real HTTP routes backed by temporary accounts and a controlled upstream."""
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "ticket17-browser-only"

from fastapi import FastAPI
import uvicorn
from api import accounts, system
from services.account_service import AccountService
from services.config import config
from services.storage.json_storage import JSONStorageBackend


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="ticket17-") as directory:
        accounts.account_service = AccountService(JSONStorageBackend(Path(directory) / "accounts.json"))
        accounts.account_service.add_account_items([
            {"access_token": "normal-test", "email": "normal@example.invalid", "quota": 1},
            {"access_token": "invalid-test", "email": "invalid@example.invalid", "status": "异常"},
        ])
        config.path = Path(directory) / "config.json"
        config.update({"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True})
        app = FastAPI()
        app.include_router(accounts.create_router())
        app.include_router(system.create_router("ticket17-browser"))

        @app.get("/v1/models")
        def models():
            return {"data": []}

        with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", return_value={"status": "限流", "quota": 0}), \
             patch("curl_cffi.requests.Session.request", side_effect=RuntimeError("external network disabled")):
            uvicorn.run(app, host="127.0.0.1", port=43271)
