import io
import json
import sqlite3
import tarfile
from contextlib import closing

from test.test_image_conversations_http import environment, submit, wait_for_history


def test_http_poll_omits_unchanged_rows_and_preserves_failure_details(environment):
    env = environment
    response = submit(env)
    assert response.status_code == 200
    conversation = wait_for_history(env)["items"][0]
    image = conversation["turns"][0]["images"][0]
    client, headers = env["client"], env["headers"]
    params = {"ids": [image["id"]], "versions": {image["id"]: image["updatedAt"]}}
    assert client.post("/api/image-tasks/query", json=params, headers=headers).json()["items"] == []
    key = next(iter(env["service"]._tasks))
    env["service"]._record_failure(key, RuntimeError("controlled quota error Authorization: Bearer hidden-secret"))
    changed = client.post("/api/image-tasks/query", json=params, headers=headers).json()["items"]
    assert len(changed) == 1 and changed[0]["id"] == image["id"]
    detail = client.get(f"/api/image-conversations/{conversation['id']}", headers=headers).json()["turns"][0]["images"][0]
    assert detail["errorCode"] and detail["errorDetail"] and "hidden-secret" not in detail["errorDetail"]
    assert detail["canResume"] is False
    assert client.post("/api/image-tasks/query", json=params, headers=env["other"]).json()["items"] == []
    assert client.post("/api/image-tasks/query", json={"ids": [], "versions": []}, headers=headers).status_code == 422
    for invalid in ("", "   ", "x" * 129):
        assert client.post("/api/image-tasks/query", json={"ids": [invalid]}, headers=headers).status_code == 422
    assert env["service"].list_tasks(env["owner"], [" "], {})["items"] == []


def test_public_backup_includes_committed_sqlite_wal_and_import_metadata(tmp_path, monkeypatch):
    from services import backup_service as module
    from services.storage import image_rows
    captured = {}

    class Remote:
        prefix = "controlled"
        def __init__(self, _settings): pass
        def validate(self): pass
        def close(self): pass
        def upload_bytes(self, key, payload, **_kwargs):
            captured["payload"] = payload
            return {"key": key}

    monkeypatch.setattr(module, "DATA_DIR", tmp_path)
    monkeypatch.setattr(module, "IMAGE_INDEX_FILE", tmp_path / "image_index.json")
    monkeypatch.setattr(module, "CloudflareR2Client", Remote)
    monkeypatch.setattr(module.config, "get_backup_settings", lambda: {"include": {"image_tasks": True}})
    monkeypatch.setattr(module, "load_backup_state", lambda: {})
    monkeypatch.setattr(module, "save_backup_state", lambda value: None)
    (tmp_path / "image_tasks.json").write_text('{"legacy":true}')
    imports = tmp_path / "image_imports"
    imports.mkdir()
    (imports / "owner.json").write_text('{"md":{"content":"persisted"}}')
    for name in ("image_tasks", "image_index"):
        image_rows.save(tmp_path / f"{name}.json", {"tasks": {"first": {"value": 1}}})
    with closing(sqlite3.connect(tmp_path / "image_tasks.sqlite3")) as source:
        source.execute("PRAGMA journal_mode=WAL")
        source.execute("INSERT INTO image_rows VALUES ('tasks', 'committed-wal', '{\"value\":2}')")
        source.commit()
        result = module.BackupService().run_backup()
        assert result["size"] > 0
        with tarfile.open(fileobj=io.BytesIO(captured["payload"]), mode="r:gz") as archive:
            for name in ("image_tasks.sqlite3", "image_index.sqlite3"):
                destination = tmp_path / f"restored-{name}"
                destination.write_bytes(archive.extractfile(f"data/{name}").read())
            assert archive.extractfile("data/image_tasks.json").read() == b'{"legacy":true}'
            assert b"persisted" in archive.extractfile("data/image_imports/owner.json").read()
        assert image_rows.get(tmp_path / "restored-image_tasks.sqlite3", "tasks", "committed-wal") == {"value": 2}
        assert image_rows.get(tmp_path / "restored-image_index.sqlite3", "tasks", "first") == {"value": 1}
