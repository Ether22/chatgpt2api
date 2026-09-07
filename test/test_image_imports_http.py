"""Current imports through HTTP with real identity and temporary file storage."""
import pytest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import time
from test.test_image_conversations_http import environment, image_bytes, submit


@pytest.fixture
def imports(environment, tmp_path, monkeypatch):
    from api import image_imports
    from services.image_import_service import ImageImportService
    monkeypatch.setattr(image_imports, "image_import_service", ImageImportService(tmp_path / "imports", environment["service"]))
    environment["app"].include_router(image_imports.create_router())
    return environment


def reserve(env, request_id="ref-one", name="first.png", version=0):
    return env["client"].post("/api/image-imports/references", headers=env["headers"],
        json={"request_id": request_id, "name": name, "size": len(image_bytes()), "version": version})


def upload(env, request_id="ref-one", name="first.png"):
    return env["client"].put(f"/api/image-imports/references/{request_id}", headers=env["headers"],
        files={"file": (name, image_bytes(), "image/png")})


def test_references_append_merge_but_same_name_conflicts_and_clear_protects_snapshots(imports):
    env = imports
    assert reserve(env).status_code == 200
    assert reserve(env).json()["version"] == 1
    assert reserve(env, "ref-two", "second.png").status_code == 200
    assert reserve(env, "duplicate", "first.png").status_code == 409
    first = upload(env)
    assert first.status_code == 200, first.text
    reference = first.json()["references"][0]["reference"]
    assert upload(env).json()["references"][0]["reference"] == reference
    second = upload(env, "ref-two", "second.png").json()["references"][1]["reference"]
    assert env["client"].post(f'/api/image-references/{reference["id"]}/retain', headers=env["headers"]).status_code == 200
    turn = submit(env, referenceImages=[{"id": second["id"]}, {"id": reference["id"]}]).json()
    clear = {"request_id": "clear-one", "version": 2, "upload_ids": ["not-arrived"]}
    result = env["client"].request("DELETE", "/api/image-imports", headers=env["headers"], json=clear)
    assert result.status_code == 200, result.text
    assert result.json()["references"] == []
    assert reserve(env, "late", "late.png", 0).status_code == 409
    assert reserve(env, "not-arrived", "late.png", 3).status_code == 409
    assert upload(env).status_code == 404
    assert env["client"].get(reference["url"], headers=env["headers"]).content == image_bytes()
    assert env["client"].get(second["url"], headers=env["headers"]).content == image_bytes()
    assert env["client"].get("/api/image-references", headers=env["headers"]).json()["items"] == [reference]
    assert env["client"].get(f'/api/image-conversations/{turn["id"]}', headers=env["headers"]).json()["turns"][0]["referenceImages"] == [second, reference]
    assert env["client"].request("DELETE", "/api/image-imports", headers=env["headers"], json=clear).json()["version"] == 3


def test_md_replacement_is_shared_versioned_and_idempotent(environment, tmp_path, monkeypatch):
    from api import image_imports
    from services.image_import_service import ImageImportService
    env = environment
    service = ImageImportService(tmp_path / "imports", env["service"])
    monkeypatch.setattr(image_imports, "image_import_service", service)
    env["app"].include_router(image_imports.create_router())
    client, headers = env["client"], env["headers"]
    assert client.get("/api/image-imports", headers=headers).json()["version"] == 0
    def replace(request_id, version, content):
        return client.put("/api/image-imports/md", headers=headers,
            data={"request_id": request_id, "version": version},
            files={"file": ("任务.md", content.encode(), "text/markdown")})
    first = replace("md-one", 0, "# 一")
    assert first.status_code == 200, first.text
    assert first.json()["md"]["content"] == "# 一"
    assert replace("md-one", 0, "# 一").json()["version"] == 1
    assert replace("md-two", 0, "# 过期").status_code == 409
    assert replace("md-two", 1, "# 二").json()["version"] == 2
    assert replace("md-one", 0, "# 一").json()["md"]["content"] == "# 二"
    monkeypatch.setattr(image_imports, "image_import_service", ImageImportService(tmp_path / "imports", env["service"]))
    restored = client.get("/api/image-imports", headers=headers).json()
    assert restored["md"]["content"] == "# 二"
    assert restored["updated_at"].endswith("+08:00")
    assert client.get("/api/image-imports", headers=env["other"]).json()["md"] is None
    assert env["calls"] == []


@pytest.mark.parametrize("failure_stage", ["reserve", "upload-intent", "upload-confirm", "clear-intent", "clear-confirm"])
def test_metadata_failure_never_reports_success_and_same_request_recovers(imports, tmp_path, monkeypatch, failure_stage):
    from api import image_imports
    from services.image_import_service import ImageImportService
    from services.image_task_service import ImageTaskService
    env = imports
    if failure_stage != "reserve":
        assert reserve(env).status_code == 200
    if failure_stage.startswith("clear"):
        assert upload(env).status_code == 200
    clear = {"request_id": "clear-failure", "version": 1}
    def action():
        if failure_stage == "reserve":
            return reserve(env)
        if failure_stage.startswith("upload"):
            return upload(env)
        return env["client"].request("DELETE", "/api/image-imports", headers=env["headers"], json=clear)
    original_replace = Path.replace
    calls = 0
    def fail_metadata_replace(path, target):
        nonlocal calls
        if Path(target).parent == tmp_path / "imports":
            calls += 1
            if calls == (2 if failure_stage.endswith("confirm") else 1):
                raise OSError("controlled import metadata disk failure")
        return original_replace(path, target)
    with monkeypatch.context() as fault:
        fault.setattr(Path, "replace", fail_metadata_replace)
        response = action()
        assert response.status_code == 507, response.text
    references = ImageTaskService(env["path"], generation_handler=env["upstream"], edit_handler=env["upstream"])
    monkeypatch.setattr(image_imports, "image_import_service", ImageImportService(tmp_path / "imports", references))
    observed = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    if failure_stage == "reserve":
        assert observed["version"] == 0
        assert observed["references"] == []
    elif failure_stage.startswith("upload"):
        assert observed["references"][0]["reference"] is None
        assert observed["references"][0]["error"]
    elif failure_stage == "clear-confirm":
        assert observed["pending"]["request_id"] == "clear-failure"
        assert observed["references"][0]["reference"] is None
        assert reserve(env, "blocked", "blocked.png", 2).status_code == 409
    response = action()
    assert response.status_code == 200, response.text
    if failure_stage.startswith("clear"):
        assert response.json()["references"] == []
        assert references.list_references(env["owner"], scope="imports")["items"] == []
    elif failure_stage.startswith("upload"):
        assert len(references.list_references(env["owner"], scope="imports")["items"]) == 1
    assert env["calls"] == []


def test_failed_physical_clear_is_visible_and_retryable_across_reload(imports, tmp_path, monkeypatch):
    from api import image_imports
    from services.image_import_service import ImageImportService
    env = imports
    reserve(env)
    reference = upload(env).json()["references"][0]["reference"]
    original_unlink = Path.unlink
    def fail_image_unlink(path, *args, **kwargs):
        if str(path).replace("\\", "/").endswith(reference["url"].removeprefix("/images/")):
            raise OSError("controlled image disk removal failure")
        return original_unlink(path, *args, **kwargs)
    clear = {"request_id": "physical-clear", "version": 1}
    with monkeypatch.context() as fault:
        fault.setattr(Path, "unlink", fail_image_unlink)
        result = env["client"].request("DELETE", "/api/image-imports", headers=env["headers"], json=clear)
        assert result.status_code == 507, result.text
    monkeypatch.setattr(image_imports, "image_import_service", ImageImportService(tmp_path / "imports", env["service"]))
    state = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    assert state["pending"]["request_id"] == "physical-clear"
    assert state["references"][0]["reference"] is None
    assert env["client"].request("DELETE", "/api/image-imports", headers=env["headers"], json=clear).json()["references"] == []
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404


def test_remove_and_clear_reject_stale_versions_and_other_identity(imports):
    env = imports
    reserve(env)
    upload(env)
    client, headers = env["client"], env["headers"]
    assert client.put("/api/image-imports/references/ref-one", headers=env["other"],
        files={"file": ("first.png", image_bytes(), "image/png")}).status_code == 404
    assert client.request("DELETE", "/api/image-imports/references/ref-one", headers=headers,
        json={"request_id": "remove-stale", "version": 0}).status_code == 409
    assert client.request("DELETE", "/api/image-imports", headers=headers,
        json={"request_id": "clear-stale", "version": 0}).status_code == 409
    assert client.request("DELETE", "/api/image-imports/references/ref-one", headers=env["other"],
        json={"request_id": "remove-other", "version": 0}).status_code == 200
    assert len(client.get("/api/image-imports", headers=headers).json()["references"]) == 1
    assert client.request("DELETE", "/api/image-imports/references/ref-one", headers=headers,
        json={"request_id": "remove-own", "version": 1}).json()["references"] == []
    assert reserve(env, "unrelated-add", "unrelated.png", 0).status_code == 200
    assert reserve(env).status_code == 409


def test_invalid_files_and_changed_retry_bytes_are_rejected(imports):
    env = imports
    client, headers = env["client"], env["headers"]
    for name, data in [("bad.txt", b"text"), ("bad.md", b"\xff"), ("empty.md", b""), ("../bad.md", b"text")]:
        assert client.put("/api/image-imports/md", headers=headers, data={"request_id": name, "version": 0},
            files={"file": (name, data)}).status_code == 400
    assert reserve(env, name="../bad.png").status_code == 400
    assert client.post("/api/image-imports/references", headers=headers,
        json={"request_id": "huge", "version": 0, "name": "big.png", "size": 50 * 1024 * 1024 + 1}).status_code == 422
    reserve(env)
    assert client.put("/api/image-imports/references/ref-one", headers=headers,
        files={"file": ("first.png", b"x" * len(image_bytes()))}).status_code == 400
    assert upload(env).status_code == 409
    assert client.get("/api/image-imports", headers=headers).json()["references"][0]["reference"] is None


def test_slow_upload_does_not_block_get_md_or_clear_intent_and_cannot_revive(imports, monkeypatch):
    env = imports
    reserve(env)
    upload(env)
    reserve(env, "slow", "slow.png", 1)
    entered, finish = Event(), Event()
    original_write = Path.write_bytes
    def slow_write(path, data):
        if "references" in path.parts:
            entered.set()
            assert finish.wait(5), "test must release controlled disk upload"
        return original_write(path, data)
    monkeypatch.setattr(Path, "write_bytes", slow_write)
    with ThreadPoolExecutor(max_workers=4) as workers:
        try:
            transferring = workers.submit(upload, env, "slow", "slow.png")
            assert entered.wait(2)
            read = workers.submit(env["client"].get, "/api/image-imports", headers=env["headers"])
            state = read.result(timeout=.75).json()
            assert state["references"][0]["reference"] is not None
            assert state["references"][1]["reference"] is None
            replaced = workers.submit(env["client"].put, "/api/image-imports/md", headers=env["headers"],
                data={"request_id": "md-during-upload", "version": 2}, files={"file": ("live.md", b"# live")})
            assert replaced.result(timeout=.75).status_code == 200
            clearing = workers.submit(env["client"].request, "DELETE", "/api/image-imports", headers=env["headers"],
                json={"request_id": "clear-during-upload", "version": 3})
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                state = env["client"].get("/api/image-imports", headers=env["headers"]).json()
                if state["pending"]:
                    break
                time.sleep(.01)
            assert state["pending"]["request_id"] == "clear-during-upload"
        finally:
            finish.set()
        assert transferring.result(timeout=2).status_code in {404, 409}
        assert clearing.result(timeout=2).status_code == 200
    state = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    assert state["md"] is None and state["references"] == []
    assert env["service"].list_references(env["owner"], scope="imports")["items"] == []
