"""Scope deletion through public HTTP, real files and controlled upstream boundaries."""
import time
import threading
import pytest

from api import image_tasks
from services.image_task_service import ImageTaskService
from urllib.parse import urlsplit

from services import config as config_module, image_tags_service as tags
from test.test_image_conversations_http import environment, submit, wait_for_history


def wait_cleanup(env):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = env["client"].get("/api/image-cleanups", headers=env["headers"])
        assert response.status_code == 200, response.text
        result = response.json()
        if not result["stats"]["pending"]:
            return result
        time.sleep(.02)
    raise AssertionError(result)


def test_legacy_turn_delete_physically_cleans_and_cannot_be_unhidden(environment):
    env = environment
    assert submit(env, count=3).status_code == 200
    conversation = wait_for_history(env, 3)["items"][0]
    turn = conversation["turns"][0]
    paths = [urlsplit(image["url"]).path.removeprefix("/images/") for image in turn["images"]]
    for path in paths:
        tags.set_tags(path, ["scope"])
        assert env["client"].get(f"/image-thumbnails/{path}", headers=env["headers"]).status_code == 200
    route = f'/api/image-conversations/{conversation["id"]}'
    assert env["client"].patch(route, headers=env["headers"], json={"turns": [{"id": turn["id"], "resultsDeleted": True}]}).status_code == 200
    assert wait_cleanup(env)["stats"]["complete"] == 3
    for path in paths:
        assert not (config_module.config.images_dir / path).exists()
        assert not (config_module.config.image_thumbnails_dir / f"{path}.png").exists()
        assert tags.get_tags(path) == []
    response = env["client"].patch(route, headers=env["headers"], json={"turns": [{"id": turn["id"], "resultsDeleted": False}]}).json()
    assert response["turns"][0]["images"] == []
    assert response["turns"][0]["prompt"] == turn["prompt"]


def test_deleting_inflight_stops_unsent_and_cleans_late_result(environment, monkeypatch):
    env = environment
    sent, unsent, release, stopped = (threading.Event() for _ in range(4))
    gate = threading.Lock()
    entered = []

    def upstream(payload):
        with gate:
            entered.append(1)
            first = len(entered) == 1
        if first:
            payload["lifecycle_callback"]("sending", {"protocol": "controlled"})
            sent.set()
            assert release.wait(10)
            return env["upstream"](payload)
        unsent.set()
        assert release.wait(10)
        try:
            payload["lifecycle_callback"]("sending", {"protocol": "controlled"})
            return env["upstream"](payload)
        finally:
            stopped.set()

    monkeypatch.setattr(env["service"], "generation_handler", upstream)
    try:
        response = submit(env, count=2).json()
        assert sent.wait(5) and unsent.wait(5)
        route = f'/api/image-conversations/{response["id"]}'
        assert env["client"].delete(route, headers=env["headers"]).status_code == 200
        assert env["client"].get(route, headers=env["headers"]).status_code == 404
        release.set()
        assert stopped.wait(5)
        assert wait_cleanup(env)["stats"]["complete"] == 2
        assert len(env["calls"]) == 1
        assert list(config_module.config.images_dir.rglob("*.png")) == []
        assert submit(env, count=2).status_code == 404
    finally:
        release.set()


def test_conversation_and_identity_scope_preserve_other_history_and_current_inputs(environment, monkeypatch):
    from test.test_image_references_http import upload
    env = environment
    reference = upload(env)
    env["service"].retain_reference(env["owner"], reference["id"], scope="imports")
    first = submit(env, referenceImages=[{"id": reference["id"]}]).json()
    created = env["client"].post("/api/image-conversations", headers=env["headers"], json={"request_id": "second"}).json()
    assert submit(env, request_id="other-turn", conversation_id=created["id"]).status_code == 200
    histories = wait_for_history(env, 2)["items"]
    urls = {item["id"]: item["turns"][0]["images"][0]["url"] for item in histories}
    other = {**env, "headers": env["other"]}
    other_conversation = submit(other, request_id="other-owner").json()
    other_url = wait_for_history(other)["items"][0]["turns"][0]["images"][0]["url"]
    route = f'/api/image-conversations/{first["id"]}'
    assert env["client"].delete(route, headers=env["other"]).status_code == 404
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert wait_cleanup(env)["stats"]["complete"] == 1
    assert env["client"].get(urls[first["id"]], headers=env["headers"]).status_code == 404
    assert env["client"].get(urls[created["id"]], headers=env["headers"]).status_code == 200
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 200
    assert env["client"].delete("/api/image-conversations", headers=env["headers"]).status_code == 200
    assert wait_cleanup(env)["stats"]["complete"] == 2
    assert env["client"].get("/api/image-conversations", headers=env["headers"]).json()["items"] == []
    assert env["client"].get(other_url, headers=env["other"]).status_code == 200
    assert env["client"].get(f'/api/image-conversations/{other_conversation["id"]}', headers=env["other"]).status_code == 200
    assert env["client"].get("/api/image-cleanups", headers=env["other"]).json()["stats"]["complete"] == 0
    assert env["service"].list_references(env["owner"], scope="ordinary")["items"][0]["id"] == reference["id"]
    assert env["service"].list_references(env["owner"], scope="imports")["items"][0]["id"] == reference["id"]


def test_deleted_snapshot_releases_last_hold_after_restart(environment, monkeypatch):
    from test.test_image_references_http import upload
    env = environment
    reference = upload(env)
    assert submit(env, referenceImages=[{"id": reference["id"]}]).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    assert env["service"].release_reference(env["owner"], reference["id"]) == {"retained": True}
    env["service"].delete_conversations(env["owner"], conversation["id"])
    restored = ImageTaskService(env["path"])
    monkeypatch.setattr(image_tasks, "image_task_service", restored)
    try:
        restored.start()
        assert wait_cleanup(env)["stats"]["complete"] == 1
        assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404
        assert list(config_module.config.images_dir.rglob("*.png")) == []
        assert submit(env).status_code == 404
    finally:
        restored.shutdown()


@pytest.mark.parametrize("scope", ["turn", "conversation", "all"])
def test_scope_tombstone_commit_failure_has_no_physical_effect(environment, monkeypatch, scope):
    from test.image_storage_faults import deny_sqlite_commits
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    route = f'/api/image-conversations/{conversation["id"]}'
    with monkeypatch.context() as fault:
        deny_sqlite_commits(fault, env["path"], "scope commit failed")
        response = (env["client"].patch(route, headers=env["headers"], json={"turns": [{"id": turn["id"], "resultsDeleted": True}]})
                    if scope == "turn" else env["client"].delete(route if scope == "conversation" else "/api/image-conversations", headers=env["headers"]))
        assert response.status_code == 507
    assert env["client"].get(route, headers=env["headers"]).json()["turns"][0]["images"][0]["id"] == turn["images"][0]["id"]
    assert env["client"].get(turn["images"][0]["url"], headers=env["headers"]).status_code == 200
    assert wait_cleanup(env)["stats"]["complete"] == 0


def test_deleted_conversation_keeps_partial_failure_retry_after_reload(environment, monkeypatch):
    from services import image_storage_service as storage
    env = environment
    remote, deletions = {}, []
    failed_path = None
    class Remote:
        def __init__(self, settings): pass
        def test(self): return {"ok": True}
        def put(self, rel, data):
            remote[rel] = data
            return f"https://controlled.example/{rel}"
        def delete(self, rel):
            deletions.append(rel)
            if rel == failed_path: raise OSError("one controlled remote failure")
            return remote.pop(rel, None) is not None
    monkeypatch.setattr(storage, "WebDAVClient", Remote)
    monkeypatch.setitem(config_module.config.data, "image_storage", {"enabled": True, "mode": "both", "webdav_url": "https://controlled.example"})
    assert submit(env, count=3).status_code == 200
    conversation = wait_for_history(env, 3)["items"][0]
    failed_path = next(iter(remote))
    assert env["client"].delete(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).status_code == 200
    cleanup = wait_cleanup(env)
    assert cleanup["stats"] == {"complete": 2, "pending": 0, "retained": 0, "error": 1}
    failed_id = cleanup["items"][0]["id"]
    assert "one controlled remote failure" in cleanup["items"][0]["error"]
    assert len(remote) == 1 and len(deletions) == 3
    restored = ImageTaskService(env["path"])
    monkeypatch.setattr(image_tasks, "image_task_service", restored)
    retry = f'/api/image-cleanups/{failed_id}/retry'
    assert env["client"].post(retry, headers=env["other"]).status_code == 404
    failed_path = None
    assert env["client"].post(retry, headers=env["headers"]).status_code == 200
    assert wait_cleanup(env)["stats"]["complete"] == 3
    assert remote == {} and len(deletions) == 4
    assert env["client"].post(retry, headers=env["headers"]).status_code == 200
    assert len(deletions) == 4 and len(env["calls"]) == 3


def test_real_pool_waiter_exits_before_sent_sibling_returns(environment, monkeypatch, tmp_path):
    from services import openai_backend_api as backend
    from services.protocol import conversation, openai_v1_image_generations
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    from test.test_reference_protocol import ControlledHTTP
    env = environment
    account_store = JSONStorageBackend(tmp_path / "pool.json")
    account_store.save_accounts([{"access_token": "controlled", "status": "正常", "quota": 100}])
    pool = AccountService(account_store)
    monkeypatch.setattr(backend, "account_service", pool)
    monkeypatch.setattr(conversation, "account_service", pool)
    monkeypatch.setitem(config_module.config.data, "image_account_concurrency", 1)
    monkeypatch.setitem(config_module.config.data, "image_check_before_hit_enabled", False)
    monkeypatch.setitem(config_module.config.data, "image_remove_conversation_after_result", False)
    remote = ControlledHTTP()
    sent, release = threading.Event(), threading.Event()
    make_session = remote.session
    def transport(**kwargs):
        client = make_session(**kwargs)
        post = client.post
        def send(url, **arguments):
            response = post(url, **arguments)
            if url.endswith("/f/conversation"):
                sent.set()
                assert release.wait(10)
            return response
        client.post = send
        return client
    monkeypatch.setattr(backend.requests, "Session", transport)
    monkeypatch.setattr(env["service"], "generation_handler", openai_v1_image_generations.handle)
    try:
        result = submit(env, count=2).json()
        assert sent.wait(5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            tasks = env["client"].get("/api/image-tasks", headers=env["headers"]).json()["items"]
            waiting = next((task for task in tasks if task.get("waiting")), None)
            if waiting: break
            time.sleep(.02)
        assert waiting is not None
        assert env["client"].delete(f'/api/image-conversations/{result["id"]}', headers=env["headers"]).status_code == 200
        worker_name = f'image-task-{waiting["id"][-16:]}'
        deadline = time.monotonic() + 3
        while any(thread.name == worker_name for thread in threading.enumerate()) and time.monotonic() < deadline:
            time.sleep(.02)
        assert not any(thread.name == worker_name for thread in threading.enumerate()), "Deleted waiter must actually exit before the busy account is available"
        assert len(remote.generations) == 1
        release.set()
        assert wait_cleanup(env)["stats"]["complete"] == 2
        assert len(remote.generations) == 1
        assert list(config_module.config.images_dir.rglob("*.png")) == []
    finally:
        release.set()


@pytest.mark.parametrize("source", ["b64", "protocol_url"])
def test_late_storage_intent_survives_data_commit_failure_and_remains_retryable(environment, monkeypatch, source):
    import json
    import sqlite3
    from pathlib import Path
    from services import image_storage_service as storage
    from services.protocol.conversation import format_image_result
    env = environment
    sent, release, failed = (threading.Event() for _ in range(3))
    fault_active = False
    original_connect = sqlite3.connect
    original_unlink = Path.unlink

    class FailingCommit(sqlite3.Connection):
        def execute(self, statement, parameters=(), /):
            nonlocal fault_active
            if statement.startswith("INSERT INTO main.image_rows") and parameters[0] == "tasks":
                record = json.loads(parameters[2])
                if record.get("data"):
                    fault_active = True
                    failed.set()
            return super().execute(statement, parameters)
        def __exit__(self, error_type, error, traceback):
            if error_type is None and self.in_transaction and fault_active:
                self.rollback()
                raise PermissionError("controlled late data checkpoint failure")
            return super().__exit__(error_type, error, traceback)

    def connect(database, *args, **kwargs):
        if Path(database) == env["path"]:
            kwargs["factory"] = FailingCommit
        return original_connect(database, *args, **kwargs)

    def no_delete(path, *args, **kwargs):
        if path.is_relative_to(config_module.config.images_dir):
            raise PermissionError("controlled remaining original")
        return original_unlink(path, *args, **kwargs)

    def upstream(payload):
        payload["lifecycle_callback"]("sending", {"protocol": "controlled"})
        sent.set()
        assert release.wait(10)
        result = env["upstream"](payload)
        if source == "protocol_url":
            return format_image_result(result["data"], "test", "url", "", int(time.time()))
        return result

    monkeypatch.setattr(env["service"], "generation_handler", upstream)
    try:
        conversation = submit(env).json()
        assert sent.wait(5)
        task_id = conversation["turns"][0]["images"][0]["id"]
        route = f'/api/image-conversations/{conversation["id"]}'
        assert env["client"].delete(route, headers=env["headers"]).status_code == 200
        with monkeypatch.context() as fault:
            fault.setattr(sqlite3, "connect", connect)
            fault.setattr(Path, "unlink", no_delete)
            release.set()
            assert failed.wait(5)
            cleanup = wait_cleanup(env)
            assert cleanup["stats"]["error"] == 1
            assert "controlled late data checkpoint failure" in cleanup["items"][0]["error"]
            originals = list(config_module.config.images_dir.rglob("*.png"))
            assert len(originals) == 1
            rel = originals[0].relative_to(config_module.config.images_dir).as_posix()
            assert env["client"].get(f"/images/{rel}", headers=env["headers"]).status_code == 404
            assert env["client"].get("/api/images", headers=env["headers"]).json()["items"] == []
            env["service"].shutdown()
        restored = ImageTaskService(env["path"])
        monkeypatch.setattr(image_tasks, "image_task_service", restored)
        retry = env["client"].post(f"/api/image-cleanups/{task_id}/retry", headers=env["headers"])
        assert retry.status_code == 200
        deadline = time.monotonic() + 5
        while originals[0].exists() and time.monotonic() < deadline:
            time.sleep(.02)
        assert not originals[0].exists()
        assert env["client"].get(route, headers=env["headers"]).status_code == 404
        assert len(env["calls"]) == 1
        restored.shutdown()
    finally:
        release.set()
