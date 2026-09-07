"""Stage B: public services, real temporary files, controlled clocks/upstreams."""
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import ctypes
import os
import time
import json
import io
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.image_task_service import ImageTaskService
from services.storage import image_rows
from services.image_storage_service import ImageStorageService
from services.config import config
from services.account_service import AccountService
from services.storage.json_storage import JSONStorageBackend
from test.test_image_conversations_http import image_bytes
from test.test_beijing_business_time import FrozenDateTime
from test.test_account_export import make_jwt


@contextmanager
def server_timezone(zone):
    old = os.environ.get("TZ")

    def set_zone(value):
        if value is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = value
        if hasattr(time, "tzset"):
            time.tzset()
        else:
            crt = ctypes.CDLL("ucrtbase")
            crt._putenv_s(b"TZ", (value or "").encode())
            crt._tzset()

    set_zone(zone)
    try:
        yield
    finally:
        set_zone(old)


def test_offset_task_retention_keeps_the_same_instant(tmp_path):
    owner = {"id": "time-test", "role": "admin"}
    instant = datetime(2026, 9, 7, 16, 0, 1, 123456, tzinfo=UTC)
    for zone in ("UTC0", "PST8", "CST-8"):
        path = tmp_path / f"{zone}.sqlite3"
        # Persisted non-managed rows are the only remaining retention consumer.
        image_rows.save(path, {"tasks": {
            f"time-test:{key}": {"id": key, "owner_id": owner["id"], "status": "success", "updated_at": value}
            for key, value in {"offset": "2026-09-08T00:00:01.123456+08:00", "utc": "2026-09-07T16:00:01.123456Z", "legacy": "2026-09-08 00:00:01.123456"}.items()
        }})
        with server_timezone(zone), patch("time.time", return_value=(instant + timedelta(days=29, hours=23)).timestamp()) as clock:
            assert len(ImageTaskService(path, retention_days_getter=lambda: 30).list_tasks(owner, [])["items"]) == 3
            clock.return_value = (instant + timedelta(days=30, hours=4)).timestamp()
            result = ImageTaskService(path, retention_days_getter=lambda: 30).list_tasks(owner, ["offset", "utc", "legacy"])
            assert result["missing_ids"] == (["offset", "utc", "legacy"] if zone == "CST-8" else ["offset", "utc"])


def test_image_paths_and_file_mtime_use_beijing_in_every_server_zone(tmp_path):
    for zone in ("UTC0", "PST8", "CST-8"):
        root = tmp_path / zone
        with server_timezone(zone), patch("services.config.DATA_DIR", root), patch.dict(config.data, {"image_storage": {"mode": "local"}}), patch("utils.business_time.datetime", FrozenDateTime):
            service = ImageStorageService(root / "index.sqlite3")
            for instant, day in [(datetime(2026, 9, 7, 15, 59, 59, tzinfo=UTC), "2026-09-07"), (datetime(2026, 9, 7, 16, 0, 1, tzinfo=UTC), "2026-09-08")]:
                with patch.object(FrozenDateTime, "instant", instant), patch("time.time", return_value=instant.timestamp()):
                    result = service.save(image_bytes(), "http://controlled.test")
                    assert result.rel.startswith(day.replace("-", "/") + "/")
                    row = next(item for item in service.list_items("") if item["rel"] == result.rel)
                    assert row["created_at"].startswith(day + "T") and row["created_at"].endswith("+08:00")
            recovered = config.images_dir / "mtime.png"
            recovered.write_bytes(image_bytes())
            os.utime(recovered, (1788796801, 1788796801))
            rows = service.list_items("", start_date="2026-09-08", end_date="2026-09-08")
            row = next(item for item in rows if item["rel"] == "mtime.png")
            assert row["date"] == "2026-09-08"
            assert row["created_at"] == "2026-09-08T00:00:01+08:00"


def test_account_business_dates_and_rate_limit_keep_instant(tmp_path):
    with patch("services.config.DATA_DIR", tmp_path), patch("services.account_service.datetime", FrozenDateTime), patch("utils.business_time.datetime", FrozenDateTime), server_timezone("UTC0"):
        store = JSONStorageBackend(tmp_path / "accounts.json")
        service = AccountService(store)
        service.add_accounts(["time-token"])
        assert service.get_account("time-token")["created_at"] == "2026-09-08T00:00:01+08:00"
        service.mark_text_used("time-token")
        assert service.get_account("time-token")["last_used_at"] == "2026-09-08T00:00:01+08:00"
        service.mark_image_result("time-token", success=True)
        assert service.get_account("time-token")["last_used_at"] == "2026-09-08T00:00:01+08:00"
        result = service.mark_rate_limited("time-token", retry_after=60)
        assert result["restore_at"] == "2026-09-08T00:01:01+08:00"
        assert datetime.fromisoformat(result["restore_at"]).timestamp() == FrozenDateTime.instant.timestamp() + 60
        assert AccountService(store).list_accounts()[0]["restore_at"] == result["restore_at"]


def test_account_refresh_and_legacy_output_without_migration(tmp_path):
    from services.log_service import LogService
    from services.openai_backend_api import InvalidAccessTokenError

    with patch("services.config.DATA_DIR", tmp_path), patch("services.account_service.datetime", FrozenDateTime), patch("utils.business_time.datetime", FrozenDateTime), patch("services.account_service.log_service", LogService(tmp_path / "logs.jsonl")):
        store = JSONStorageBackend(tmp_path / "accounts.json")
        store.save_accounts([{"access_token": "old", "refresh_token": "fake", "created_at": "2026-09-07T16:00:01Z", "restore_at": "2026-09-08 02:00:00"}])
        before = (tmp_path / "accounts.json").read_bytes()
        service = AccountService(store)
        assert service.list_accounts()[0]["created_at"] == "2026-09-08T00:00:01+08:00"
        assert service.get_account("old")["restore_at"] == "2026-09-08 02:00:00"
        assert (tmp_path / "accounts.json").read_bytes() == before
        with patch("curl_cffi.requests.Session.post", side_effect=RuntimeError("controlled OAuth failure")):
            service.refresh_access_token("old", force=True)
        assert store.load_accounts()[0]["last_token_refresh_error_at"] == "2026-09-08T00:00:01+08:00"
        response = SimpleNamespace(status_code=200, text="ok", json=lambda: {"access_token": "new"})
        with patch("curl_cffi.requests.Session.post", return_value=response):
            assert service.refresh_access_token("old", force=True) == "new"
        assert store.load_accounts()[0]["last_token_refresh_at"] == "2026-09-08T00:00:01+08:00"
        service.add_accounts(["invalid"])
        with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", side_effect=InvalidAccessTokenError("controlled invalid token")):
            with pytest.raises(InvalidAccessTokenError):
                service.fetch_remote_info("invalid")
        row = next(item for item in store.load_accounts() if item["access_token"] == "invalid")
        assert row["last_invalid_at"] == row["last_refresh_error_at"] == "2026-09-08T00:00:01+08:00"


def test_account_http_export_filename_and_jwt_instants(tmp_path):
    from api import accounts, support
    from services.auth_service import AuthService

    with patch("services.config.DATA_DIR", tmp_path), patch("utils.business_time.datetime", FrozenDateTime), server_timezone("UTC0"):
        store = JSONStorageBackend(tmp_path / "accounts.json")
        auth = AuthService(store)
        _, key = auth.create_key(role="admin", name="test")
        service = AccountService(store)
        token = make_jwt({"exp": 1788796801, "iat": 1788796741})
        service.add_account_items([{"access_token": token, "id_token": make_jwt({"email": "fake@example.test"}), "refresh_token": "fake"}])
        with patch.object(accounts, "account_service", service), patch.object(support, "auth_service", auth):
            app = FastAPI()
            app.include_router(accounts.create_router())
            with TestClient(app) as client:
                for format in ("json", "zip"):
                    response = client.post("/api/accounts/export", headers={"Authorization": f"Bearer {key}"}, json={"format": format})
                    assert response.status_code == 200
                    assert f'codex-accounts-20260908T000001+0800.{format}' in response.headers["content-disposition"]
                    if format == "json":
                        exported = response.json()
                    else:
                        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                            exported = json.loads(archive.read(archive.namelist()[0]))
                    assert exported["access_token"] == token
                    assert exported["expired"] == "2026-09-08T00:00:01+08:00"
                    assert exported["last_refresh"] == "2026-09-07T23:59:01+08:00"


def test_remote_import_jobs_persist_beijing_dates(tmp_path):
    from services.cpa_service import CPAConfig, CPAImportService
    from services.sub2api_service import Sub2APIConfig, Sub2APIImportService

    cpa = CPAConfig(tmp_path / "cpa.json")
    sub = Sub2APIConfig(tmp_path / "sub.json")
    pool = cpa.add_pool("test", "https://controlled.test", "fake")
    server = sub.add_server(name="test", base_url="https://controlled.test", email="", password="", api_key="fake")
    with patch("utils.business_time.datetime", FrozenDateTime), patch("curl_cffi.requests.Session.get", return_value=SimpleNamespace(ok=False, status_code=404, text="controlled missing account")), server_timezone("UTC0"):
        for config_store, service, target, ids in [(cpa, CPAImportService(cpa), pool, ["test.json"]), (sub, Sub2APIImportService(sub), server, ["1"])]:
            initial = service.start_import(target, ids)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                result = config_store.get_import_job(target["id"])
                if result["status"] == "failed":
                    break
                time.sleep(0.01)
            assert result["status"] == "failed"
            assert result["failed"] == 1
            assert initial["created_at"] == result["updated_at"] == "2026-09-08T00:00:01+08:00"
            reloaded = type(config_store)(config_store._store_file).get_import_job(target["id"])
            assert reloaded == result
