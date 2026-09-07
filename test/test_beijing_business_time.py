"""Business dates at public service boundaries; all storage is temporary."""
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from urllib.parse import unquote
import time
import json
import os
import subprocess
import sys

from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend
from services.log_service import LoggedCall, LogService
from services.backup_service import BackupService
from services.config import DEFAULT_BACKUP_INCLUDE, config
from services.editable_file_task_service import EditableFileTaskService


class FrozenDateTime(datetime):
    instant = datetime(2026, 9, 7, 16, 0, 1, tzinfo=UTC)

    @classmethod
    def now(cls, tz=None):
        return cls.instant.astimezone(tz) if tz else cls.instant.replace(tzinfo=None)


def test_key_dates_keep_instant_and_sixty_second_flush(tmp_path: Path):
    storage = JSONStorageBackend(tmp_path / "accounts.json")
    service = AuthService(storage)
    with patch("services.auth_service.datetime", FrozenDateTime):
        item, key = service.create_key(role="user", name="clock-test")
        assert item["created_at"] == "2026-09-08T00:00:01+08:00"
        first = service.authenticate(key)
        assert first["last_used_at"] == "2026-09-08T00:00:01+08:00"
        with patch.object(FrozenDateTime, "instant", FrozenDateTime.instant + timedelta(seconds=59)):
            assert service.authenticate(key)["last_used_at"] == "2026-09-08T00:01:00+08:00"
            assert AuthService(storage).list_keys()[0]["last_used_at"] == first["last_used_at"]
        with patch.object(FrozenDateTime, "instant", FrozenDateTime.instant + timedelta(seconds=60)):
            service.authenticate(key)
            assert AuthService(storage).list_keys()[0]["last_used_at"] == "2026-09-08T00:01:01+08:00"


def test_log_midnight_filter_and_duration(tmp_path: Path):
    service = LogService(tmp_path / "logs.jsonl")
    started = datetime(2026, 9, 7, 15, 59, 59, tzinfo=UTC).timestamp()
    with patch("utils.business_time.datetime", FrozenDateTime), patch("time.time", return_value=started + 2), patch("services.log_service.log_service", service):
        LoggedCall({"id": "test"}, "/test", "test", "midnight", started=started).log("done")
    items = service.list(start_date="2026-09-08", end_date="2026-09-08")
    assert len(items) == 1
    assert items[0]["time"] == "2026-09-08T00:00:01+08:00"
    assert items[0]["detail"]["started_at"] == "2026-09-07T23:59:59+08:00"
    assert items[0]["detail"]["ended_at"] == "2026-09-08T00:00:01+08:00"
    assert items[0]["detail"]["duration_ms"] == 2000
    assert service.list(end_date="2026-09-07") == []


def test_backup_file_metadata_api_and_utc_signature(tmp_path: Path):
    objects = {}
    requests = []

    def transport(_session, method, url, **kwargs):
        requests.append((method, kwargs["headers"]))
        if method == "PUT":
            objects[url] = kwargs["data"]
        if method == "GET" and "list-type" in url:
            key = unquote(next(iter(objects)).split("/bucket/", 1)[1])
            body = f"<ListBucketResult><Contents><Key>{key}</Key><Size>123</Size><LastModified>2026-09-07T16:00:01Z</LastModified></Contents></ListBucketResult>"
            return SimpleNamespace(status_code=200, text=body)
        return SimpleNamespace(status_code=200, headers={}, content=objects.get(url, b""))

    settings = dict(enabled=True, account_id="test", access_key_id="test", secret_access_key="test", bucket="bucket", prefix="backups", encrypt=False, include={key: False for key in DEFAULT_BACKUP_INCLUDE}, rotation_keep=0, interval_minutes=360)
    with patch.dict(config.data, {"backup": settings}), patch("services.config.BACKUP_STATE_FILE", tmp_path / "state.json"), patch("services.backup_service.datetime", FrozenDateTime), patch("utils.business_time.datetime", FrozenDateTime), patch("services.backup_service.requests.Session.request", transport):
        service = BackupService()
        result = service.run_backup()
        assert "/backup-20260908T000001+0800-" in result["key"]
        status = service.get_status()
        assert status["last_started_at"] == status["last_finished_at"] == "2026-09-08T00:00:01+08:00"
        assert service.list_backups()[0]["updated_at"] == "2026-09-08T00:00:01+08:00"
        assert service.get_backup_detail(result["key"])["created_at"] == "2026-09-08T00:00:01+08:00"
        service.run_scheduled_backup_if_needed()
    puts = [headers for method, headers in requests if method == "PUT"]
    assert len(puts) == 1
    assert puts[0]["x-amz-date"] == "20260907T160001Z"
    assert "Credential=test/20260907/auto/s3/aws4_request" in puts[0]["authorization"]
    assert puts[0]["x-amz-meta-created-at"] == "2026-09-08T00:00:01+08:00"


def test_editable_task_and_failure_log_dates(tmp_path: Path):
    service = EditableFileTaskService(tmp_path / "tasks.json")
    logs = LogService(tmp_path / "logs.jsonl")
    with patch("utils.business_time.datetime", FrozenDateTime), patch("time.time", return_value=FrozenDateTime.instant.timestamp()), patch("services.editable_file_task_service.log_service", logs):
        task = service.submit_psd({"id": "test"}, client_task_id="clock-test", base64_images=[])
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if logs.list():
                break
            time.sleep(0.01)
        current = service.list_tasks({"id": "test"}, [task["id"]])["items"][0]
        assert task["created_at"] == current["updated_at"] == "2026-09-08T00:00:01+08:00"
        assert current["status"] == "error"
        assert current["elapsed_seconds"] == 0
        assert logs.list()[0]["detail"]["started_at"] == "2026-09-08T00:00:01+08:00"
        assert logs.list()[0]["detail"]["ended_at"] == "2026-09-08T00:00:01+08:00"


def test_utc_input_filter_does_not_migrate_stored_dates(tmp_path: Path):
    path = tmp_path / "logs.jsonl"
    raw = json.dumps({"id": "utc", "time": "2026-09-07T16:00:01Z", "detail": {"started_at": "2026-09-07T15:59:59Z"}}) + "\n"
    path.write_text(raw, encoding="utf-8")
    service = LogService(path)
    item = service.list(start_date="2026-09-08", end_date="2026-09-08")[0]
    assert item["time"] == "2026-09-08T00:00:01+08:00"
    assert item["detail"]["started_at"] == "2026-09-07T23:59:59+08:00"
    assert path.read_text(encoding="utf-8") == raw
    service.delete(["unrelated"])
    assert json.loads(path.read_text(encoding="utf-8"))["time"] == "2026-09-07T16:00:01Z"


def test_business_output_under_three_actual_server_local_timezones():
    script = '''
import ctypes, os, tempfile, time
from pathlib import Path
from unittest.mock import patch
from services.log_service import LogService
from test.test_beijing_business_time import FrozenDateTime
if hasattr(time, "tzset"):
    time.tzset()
else:
    crt = ctypes.CDLL("ucrtbase")
    crt._putenv_s(b"TZ", os.environ["TZ"].encode())
    crt._tzset()
with tempfile.TemporaryDirectory() as root, patch("utils.business_time.datetime", FrozenDateTime):
    service = LogService(Path(root) / "logs.jsonl")
    service.add("call", "server timezone")
    assert service.list()[0]["time"] == "2026-09-08T00:00:01+08:00"
print(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(1788796801)))
'''
    for zone, local in [("UTC0", "2026-09-07 16:00:01"), ("PST8", "2026-09-07 08:00:01"), ("CST-8", "2026-09-08 00:00:01")]:
        result = subprocess.run([sys.executable, "-c", script], env={**os.environ, "TZ": zone}, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip().splitlines()[-1] == local
