"""Run with python -m test.beijing_business_time_server after web production build.

Real local HTTP routes/storage, a fixed clock and an in-memory R2 transport.
No account watchers, schedulers or live upstreams are started.
"""
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import unquote
import os

os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

import uvicorn
from api.app import create_app
from services.auth_service import AuthService
from services.backup_service import BackupService
from services.config import DEFAULT_BACKUP_INCLUDE, config
from services.log_service import LoggedCall, LogService
from services.storage.json_storage import JSONStorageBackend
from test.test_beijing_business_time import FrozenDateTime


def main():
    objects = {}

    def transport(_session, method, url, **kwargs):
        if method == "PUT":
            objects[url] = kwargs["data"]
        if method == "GET" and "list-type" in url:
            contents = "".join(f"<Contents><Key>{unquote(key.split('/bucket/', 1)[1])}</Key><Size>{len(body)}</Size><LastModified>2026-09-07T16:00:01Z</LastModified></Contents>" for key, body in objects.items())
            return SimpleNamespace(status_code=200, text=f"<ListBucketResult>{contents}</ListBucketResult>")
        return SimpleNamespace(status_code=200, headers={}, content=objects.get(url, b""))

    with TemporaryDirectory(prefix="beijing-18-") as directory, ExitStack() as stack:
        root = Path(directory)
        storage = JSONStorageBackend(root / "accounts.json")
        auth = AuthService(storage)
        logs = LogService(root / "logs.jsonl")
        backup = BackupService()
        settings = dict(account_id="test", access_key_id="test", secret_access_key="test", bucket="bucket", prefix="backups", encrypt=False, include={key: False for key in DEFAULT_BACKUP_INCLUDE}, rotation_keep=0)
        stack.enter_context(patch.dict(config.data, {"backup": settings}))
        for target, value in {
            "services.auth_service.datetime": FrozenDateTime,
            "services.backup_service.datetime": FrozenDateTime,
            "utils.business_time.datetime": FrozenDateTime,
            "services.config.BACKUP_STATE_FILE": root / "backup-state.json",
            "services.config.CONFIG_FILE": root / "config.json",
            "services.log_service.log_service": logs,
            "api.accounts.auth_service": auth,
            "api.support.auth_service": auth,
            "api.system.log_service": logs,
            "api.system.backup_service": backup,
            "api.support.WEB_DIST_DIR": Path(os.environ.get("BEIJING_WEB_DIST") or Path(__file__).resolve().parents[1] / "web" / "out"),
            "services.backup_service.requests.Session.request": transport,
        }.items():
            stack.enter_context(patch(target, value))
        stack.enter_context(patch.object(config, "get_storage_backend", return_value=storage))
        _, raw_key = auth.create_key(role="user", name="midnight-key")
        auth.authenticate(raw_key)
        # Feed explicit UTC data through real API formatting, without rewriting it.
        saved = storage.load_auth_keys()
        saved[0]["created_at"] = "2026-09-07T16:00:01Z"
        storage.save_auth_keys(saved)
        started = FrozenDateTime.instant.timestamp() - 2
        with patch("time.time", return_value=started + 2):
            LoggedCall({"id": "test", "name": "midnight-key"}, "/test", "test", "midnight", started=started).log("done")
        backup.run_backup()
        uvicorn.run(create_app(), host="127.0.0.1", port=43281, lifespan="off", log_level="warning")


if __name__ == "__main__":
    main()
