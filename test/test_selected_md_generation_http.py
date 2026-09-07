"""Selected MD batches through HTTP, real storage and a controlled upstream."""
import time
import sqlite3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from test.test_image_conversations_http import environment, read_history, wait_for_history
from test.test_image_imports_http import imports, reserve, upload
from test.test_image_import_preview_http import replace
from test.image_storage_faults import deny_sqlite_commits


def document():
    return """## [P01] 主图｜1200x800
参考图：无
输出文件名：main.jpg
### Prompt
```
first prompt
```
## [SUB01] 细节｜800x600
参考图：first.png
### Prompt
```
second prompt
```
## [SUB02] 不选｜800x600
参考图：无
### Prompt
```
unselected prompt
```
"""


def batch(env, state, **changes):
    body = {"request_id": "batch-one", "version": state["version"], "md_version": state["md_version"],
            "model": "gpt-image-2", "quality": "high", "count": 1,
            "entries": [{"key": c["key"]} for c in state["candidates"][:2]], **changes}
    return env["client"].post("/api/image-imports/batches", headers=env["headers"], json=body)


def test_selected_ready_entry_runs_while_own_pending_reference_survives_restart(imports, monkeypatch):
    from api import image_imports, image_tasks
    from services.image_import_service import ImageImportService
    from services.image_task_service import ImageTaskService

    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    response = batch(env, state)
    assert response.status_code == 200, response.text
    conversation_id = response.json()["id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        history = read_history(env["client"], env["headers"])
        turns = history["items"][0]["turns"]
        if turns[0]["images"][0]["status"] == "success":
            break
        time.sleep(.02)
    assert len(turns) == 2
    assert turns[0]["images"][0]["status"] == "success"
    assert turns[1]["images"][0]["status"] == "loading"
    assert len(env["calls"]) == 1
    assert batch(env, state).json()["id"] == conversation_id
    assert turns[0]["md"]["document_id"] == "P01"
    assert turns[1]["md"]["reference_names"] == ["first.png"]
    before_upload = env["client"].get(f"/api/image-conversations/{conversation_id}/metadata", headers=env["headers"]).json()["updatedAt"]
    env["service"].shutdown()
    restored = ImageTaskService(env["path"], generation_handler=env["upstream"], edit_handler=env["upstream"])
    monkeypatch.setattr(image_tasks, "image_task_service", restored)
    monkeypatch.setattr(image_imports, "image_import_service", ImageImportService(image_imports.image_import_service.directory, restored))
    restored.start()
    try:
        assert upload(env).status_code == 200
        history = wait_for_history(env, 2)
        assert len(env["calls"]) == 2
        assert all(t["images"][0]["status"] == "success" for t in history["items"][0]["turns"])
        assert history["items"][0]["turns"][1]["referenceImages"][0]["name"] == "first.png"
        assert env["client"].get(f"/api/image-conversations/{conversation_id}/metadata", headers=env["headers"]).json()["updatedAt"] != before_upload
    finally:
        restored.shutdown()


@pytest.mark.parametrize("count", [0, 101, -1, 1.5, True, "2", "1e2"])
def test_batch_and_per_entry_counts_reject_non_integer_or_out_of_range(imports, count):
    state = replace(imports, document())
    entry = {"key": state["candidates"][0]["key"]}
    assert batch(imports, state, entries=[entry], count=count).status_code == 422
    assert batch(imports, state, entries=[{**entry, "count": count}]).status_code == 422
    assert read_history(imports["client"], imports["headers"])["items"] == []
    assert imports["calls"] == []


def test_exact_count_100_and_override_one_with_idempotent_concurrent_first_submit(imports):
    env = imports
    state = replace(env, document().replace("参考图：first.png", "参考图：无"))
    entries = [{"key": state["candidates"][0]["key"], "count": 1}, {"key": state["candidates"][1]["key"]}]
    with ThreadPoolExecutor(3) as pool:
        responses = list(pool.map(lambda _: batch(env, state, count=100, entries=entries), range(3)))
    assert [r.status_code for r in responses] == [200, 200, 200]
    assert len({r.json()["id"] for r in responses}) == 1
    history = wait_for_history(env, 101)
    assert len(history["items"]) == 1
    assert [t["count"] for t in history["items"][0]["turns"]] == [1, 100]
    assert len(env["calls"]) == 101
    assert batch(env, state, count=99, entries=entries).status_code == 400


def test_failed_atomic_acceptance_has_no_turns_no_consumption_and_same_request_can_retry(imports, monkeypatch):
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    with monkeypatch.context() as fault:
        deny_sqlite_commits(fault, env["path"], "controlled batch save failure")
        response = batch(env, state)
        assert response.status_code == 507, response.text
    assert read_history(env["client"], env["headers"])["items"] == []
    assert env["calls"] == []
    assert batch(env, state).status_code == 200
    assert upload(env).status_code == 200
    assert len(wait_for_history(env, 2)["items"]) == 1
    assert len(env["calls"]) == 2


def test_clear_cancels_original_unreceived_upload_and_new_same_name_cannot_replace_it(imports):
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    accepted = batch(env, state)
    assert accepted.status_code == 200
    clear = env["client"].request("DELETE", "/api/image-imports", headers=env["headers"],
        json={"request_id": "clear", "version": state["version"]})
    assert clear.status_code == 200, clear.text
    assert reserve(env, "new-upload", version=clear.json()["version"]).status_code == 200
    assert upload(env, "new-upload").status_code == 200
    history = wait_for_history(env, 2)
    turns = history["items"][0]["turns"]
    assert turns[0]["images"][0]["status"] == "success"
    assert turns[1]["images"][0]["status"] == "error"
    assert "原始参考图上传已取消" in turns[1]["images"][0]["error"]
    assert len(env["calls"]) == 1
    assert batch(env, state).json()["id"] == accepted.json()["id"]


def test_md_replacement_keeps_frozen_old_turn_and_same_source_only_in_same_conversation(imports):
    env = imports
    state = replace(env, document())
    entries = [{"key": state["candidates"][0]["key"]}]
    accepted = batch(env, state, entries=entries).json()
    original = wait_for_history(env)["items"][0]["turns"][0]
    state = replace(env, document().replace("first prompt", "changed prompt").replace("主图", "新名称"), "new-md", state["version"])
    entries = [{"key": state["candidates"][0]["key"]}]
    response = batch(env, state, request_id="batch-two", entries=entries, conversation_id=accepted["id"], quality="low")
    assert response.status_code == 200, response.text
    turns = wait_for_history(env, 2)["items"][0]["turns"]
    assert turns[0] == original
    assert turns[1]["sourceEntryId"] == original["sourceEntryId"]
    assert turns[1]["prompt"] == "changed prompt" and turns[1]["quality"] == "low"
    assert turns[1]["md"]["name"] == "新名称"
    fresh = env["client"].post("/api/image-conversations", headers=env["headers"], json={"request_id": "fresh"}).json()
    response = batch(env, state, request_id="batch-three", entries=entries, conversation_id=fresh["id"])
    assert response.status_code == 200, response.text
    assert response.json()["turns"][0]["sourceEntryId"] != original["sourceEntryId"]
    assert env["client"].get(f'/api/image-conversations/{accepted["id"]}', headers=env["other"]).status_code == 404
    wait_for_history(env, 3)


def test_selected_skipped_missing_size_missing_file_and_raw_prompt_are_rejected(imports):
    from test.test_image_import_preview_http import correct
    env = imports
    state = replace(env, document())
    assert batch(env, state).status_code == 400  # Missing, not registered, file.
    first = state["candidates"][0]
    state = correct(env, state, first, {"size": ""}).json()
    assert batch(env, state, entries=[{"key": first["key"]}]).status_code == 400
    state = correct(env, state, first, {"size": "100x100", "skipped": True}, "skip").json()
    assert batch(env, state, entries=[{"key": first["key"]}]).status_code == 400
    assert batch(env, state, entries=[{"key": first["key"], "valid": True, "prompt": "bypass"}]).status_code == 422
    assert env["calls"] == []
    assert read_history(env["client"], env["headers"])["items"] == []


def test_upload_already_being_saved_is_held_across_clear_and_never_restores_current_materials(imports, monkeypatch):
    from services.image_storage_service import image_storage_service
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    assert batch(env, state).status_code == 200
    entered, release = Event(), Event()
    original_save = image_storage_service.save
    def slow_save(*args, **kwargs):
        if kwargs.get("reference"):
            entered.set()
            assert release.wait(10)
        return original_save(*args, **kwargs)
    monkeypatch.setattr(image_storage_service, "save", slow_save)
    with ThreadPoolExecutor(2) as pool:
        uploading = pool.submit(upload, env)
        assert entered.wait(5)
        clearing = pool.submit(env["client"].request, "DELETE", "/api/image-imports", headers=env["headers"],
            json={"request_id": "clear-during-upload", "version": state["version"]})
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if env["client"].get("/api/image-imports", headers=env["headers"]).json()["pending"]:
                    break
                time.sleep(.02)
        finally:
            release.set()
        assert clearing.result().status_code == 200
        assert uploading.result().status_code == 409
    history = wait_for_history(env, 2)
    assert all(t["images"][0]["status"] == "success" for t in history["items"][0]["turns"])
    assert len(env["calls"]) == 2
    current = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    assert current["md"] is None and current["references"] == []
    reference = history["items"][0]["turns"][1]["referenceImages"][0]
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 200


def test_nineteen_selected_entries_with_count_100_remain_durably_waiting_without_consumption(imports):
    env = imports
    content = "\n".join(f"## [SUB{i:02}] 图{i}｜800x600\n参考图：first.png\n### Prompt\n```\nDraw {i}\n```" for i in range(1, 20))
    state = replace(env, content)
    state = reserve(env, version=state["version"]).json()
    started = time.monotonic()
    try:
        response = batch(env, state, count=100, entries=[{"key": c["key"]} for c in state["candidates"]])
        assert response.status_code == 200, response.text
        cid = response.json()["id"]
        turns = []
        for offset in (0, 10):
            turns.extend(env["client"].get(f"/api/image-conversations/{cid}?offset={offset}&limit=10", headers=env["headers"]).json()["turns"])
        assert len(turns) == 19
        assert sum(len(t["images"]) for t in turns) == 1900
        assert all(image["status"] == "loading" for turn in turns for image in turn["images"])
        assert env["calls"] == []
        print(f"1900 accepted/waiting tasks: {time.monotonic() - started:.3f}s")
    finally:
        env["service"].shutdown(5)


@pytest.mark.parametrize("scope", ["turn", "conversation"])
def test_removing_waiting_turn_or_conversation_settles_without_upload_or_consumption(imports, scope):
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    accepted = batch(env, state, entries=[{"key": state["candidates"][1]["key"]}]).json()
    turn = accepted["turns"][0]
    if scope == "turn":
        response = env["client"].patch(f'/api/image-conversations/{accepted["id"]}', headers=env["headers"],
            json={"turns": [{"id": turn["id"], "resultsDeleted": True}]})
    else:
        response = env["client"].delete(f'/api/image-conversations/{accepted["id"]}', headers=env["headers"])
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        tasks = env["client"].post('/api/image-tasks/query', headers=env["headers"], json={"ids": [turn["images"][0]["id"]]}).json()["items"]
        if tasks and tasks[0]["status"] == "error":
            break
        time.sleep(.02)
    assert tasks[0]["status"] == "error"
    assert env["calls"] == []
    assert env["client"].get('/api/image-imports', headers=env["headers"]).json()["references"][0]["reference"] is None
    env["service"].shutdown()


def test_completed_reference_snapshot_save_failure_never_consumes(imports, monkeypatch):
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    selected = [{"key": state["candidates"][1]["key"]}]
    accepted = batch(env, state, entries=selected).json()
    original_connect = sqlite3.connect
    fail_next = True
    class SnapshotDiskFailure(sqlite3.Connection):
        snapshot_write = False
        def execute(self, sql, parameters=()):
            if sql.startswith("INSERT INTO image_rows") and parameters[0] == "conversations":
                self.snapshot_write = True
            return super().execute(sql, parameters)
        def __exit__(self, error_type, error, traceback):
            nonlocal fail_next
            if error_type is None and self.snapshot_write and fail_next:
                fail_next = False
                self.rollback()
                raise OSError("controlled completed snapshot save failure")
            return super().__exit__(error_type, error, traceback)
    def connect(database, *args, **kwargs):
        if Path(database) == env["path"]:
            kwargs["factory"] = SnapshotDiskFailure
        return original_connect(database, *args, **kwargs)
    with monkeypatch.context() as fault:
        fault.setattr(sqlite3, "connect", connect)
        assert upload(env).status_code == 200
        history = wait_for_history(env)
        assert history["items"][0]["turns"][0]["images"][0]["status"] == "error"
    assert fail_next is False
    assert env["calls"] == []
    failed = history["items"][0]["turns"][0]
    assert failed["referenceImages"][0]["url"] == ""
    assert "controlled completed snapshot save failure" in failed["images"][0]["error"]
    assert batch(env, state, entries=selected).json()["id"] == accepted["id"]
    assert batch(env, state, entries=selected, request_id="retry-new-turn").status_code == 200
    history = wait_for_history(env, 2)
    assert history["items"][0]["turns"][1]["images"][0]["status"] == "success"
    assert len(env["calls"]) == 1


def test_ready_entry_preserves_ordered_reference_bytes_while_another_original_upload_waits(imports):
    env = imports
    state = replace(env, document().replace("参考图：无", "参考图：first.png、second.png", 1).replace("参考图：first.png\n### Prompt\n```\nsecond", "参考图：third.png\n### Prompt\n```\nsecond"))
    for request_id, name in [("second", "second.png"), ("ref-one", "first.png"), ("third", "third.png")]:
        state = reserve(env, request_id, name, state["version"]).json()
        if request_id != "third":
            state = upload(env, request_id, name).json()
    accepted = batch(env, state)
    assert accepted.status_code == 200, accepted.text
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            turns = read_history(env["client"], env["headers"])["items"][0]["turns"]
            if turns[0]["images"][0]["status"] == "success":
                break
            time.sleep(.02)
        assert turns[0]["images"][0]["status"] == "success"
        assert turns[1]["images"][0]["status"] == "loading"
        assert [ref["name"] for ref in turns[0]["referenceImages"]] == ["first.png", "second.png"]
        assert [image[1] for image in env["calls"][0]["images"]] == ["first.png", "second.png"]
        assert len(env["calls"]) == 1
    finally:
        env["service"].shutdown()


def test_failed_original_upload_then_clear_reports_terminal_failure_instead_of_permanent_wait(imports, monkeypatch):
    from services.image_storage_service import image_storage_service
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    accepted = batch(env, state, entries=[{"key": state["candidates"][1]["key"]}]).json()
    real_save = image_storage_service.save
    def fail_reference(*args, **kwargs):
        if kwargs.get("reference"):
            raise OSError("controlled original upload failure")
        return real_save(*args, **kwargs)
    try:
        with monkeypatch.context() as fault:
            fault.setattr(image_storage_service, "save", fail_reference)
            assert upload(env).status_code == 507
        response = env["client"].request("DELETE", "/api/image-imports", headers=env["headers"],
            json={"request_id": "clear-failed-upload", "version": state["version"]})
        assert response.status_code == 200, response.text
        assert upload(env).status_code == 404
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            turn = env["client"].get(f'/api/image-conversations/{accepted["id"]}', headers=env["headers"]).json()["turns"][0]
            if turn["images"][0]["status"] == "error":
                break
            time.sleep(.02)
        assert turn["images"][0]["status"] == "error"
        assert env["calls"] == []
    finally:
        env["service"].shutdown()


def test_unconfirmed_upload_after_service_restart_is_explicit_failure_and_original_upload_can_retry(imports, monkeypatch):
    from api import image_imports, image_tasks
    from services.image_import_service import ImageImportService
    from services.image_task_service import ImageTaskService
    from services.image_storage_service import image_storage_service
    from test.test_image_conversations_http import image_bytes
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    selected = [{"key": state["candidates"][1]["key"]}]
    assert batch(env, state, entries=selected).status_code == 200
    env["service"].shutdown()
    def interrupted(*args, **kwargs):
        raise SystemExit("controlled process loss during reference persistence")
    with monkeypatch.context() as fault:
        fault.setattr(image_storage_service, "save", interrupted)
        with pytest.raises(SystemExit):
            env["service"].upload_reference(env["owner"], "ref-one", image_bytes(), "first.png", scope="imports")
    restored = ImageTaskService(env["path"], generation_handler=env["upstream"], edit_handler=env["upstream"])
    monkeypatch.setattr(image_tasks, "image_task_service", restored)
    monkeypatch.setattr(image_imports, "image_import_service", ImageImportService(image_imports.image_import_service.directory, restored))
    restored.start()
    try:
        first = wait_for_history(env)["items"][0]["turns"][0]
        assert first["images"][0]["status"] == "error"
        assert "服务已重启" in first["images"][0]["error"]
        assert env["calls"] == []
        assert upload(env).status_code == 200
        assert batch(env, state, entries=selected, request_id="after-original-upload-retry").status_code == 200
        turns = wait_for_history(env, 2)["items"][0]["turns"]
        assert turns[0]["images"][0]["status"] == "error"
        assert turns[1]["images"][0]["status"] == "success"
        assert len(env["calls"]) == 1
    finally:
        restored.shutdown()
