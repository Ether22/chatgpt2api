"""Completed result deletion through HTTP and real isolated storage."""
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor
import threading
import pytest

from api import image_tasks
from services.image_task_service import ImageTaskService
from services import config as config_module, image_tags_service as tags
from test.test_image_conversations_http import environment, submit, wait_for_history


def test_delete_result_is_durable_owned_and_preserves_original_ordinals(environment, monkeypatch):
    env = environment
    assert submit(env, count=3).status_code == 200
    conversation = wait_for_history(env, 3)["items"][0]
    turn = conversation["turns"][0]
    first, second, third = turn["images"]
    path = urlsplit(second["url"]).path
    rel = path.removeprefix("/images/")
    thumbnail = path.replace("/images/", "/image-thumbnails/")
    assert env["client"].get(thumbnail, headers=env["headers"]).status_code == 200
    tags.set_tags(rel, ["keep-until-deleted"])
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{second["id"]}'
    assert env["client"].delete(route, headers=env["other"]).status_code == 404
    assert env["client"].get(path, headers=env["headers"]).status_code == 200
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert [(image["id"], image["ordinal"]) for image in restored["turns"][0]["images"]] == [(first["id"], 1), (third["id"], 3)]
    assert env["client"].get(path, headers=env["headers"]).status_code == 404
    assert env["client"].get(thumbnail, headers=env["headers"]).status_code == 404
    assert not (config_module.config.images_dir / rel).exists()
    assert not (config_module.config.image_thumbnails_dir / f"{rel}.png").exists()
    assert tags.get_tags(rel) == []
    task = env["client"].get(f'/api/image-tasks?ids={second["id"]}', headers=env["headers"]).json()["items"][0]
    assert task["result_deleted"] and "data" not in task
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert len(env["calls"]) == 3


@pytest.mark.parametrize("mode", ["webdav", "both"])
def test_remote_failure_hides_all_views_and_retry_cleans_remaining_copy(environment, monkeypatch, mode):
    from services import image_storage_service as storage
    env = environment
    remote = {}
    fail = True

    class Remote:
        def __init__(self, settings):
            pass
        def test(self):
            return {"ok": True}
        def put(self, rel, payload):
            remote[rel] = payload
            return f"https://synthetic.example/{rel}"
        def delete(self, rel):
            if fail:
                raise storage.ImageStorageError("controlled WebDAV deletion failure Authorization: Bearer synthetic-secret")
            return remote.pop(rel, None) is not None
        def get(self, rel):
            return remote[rel]

    monkeypatch.setattr(storage, "WebDAVClient", Remote)
    settings = {"enabled": True, "mode": mode, "webdav_url": "https://synthetic.example"}
    monkeypatch.setitem(config_module.config.data, "image_storage", settings)
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image = turn["images"][0]
    path = urlsplit(image["url"]).path
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert len(remote) == 1
    assert not (config_module.config.images_dir / path.removeprefix("/images/")).exists()
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["images"] == []
    cleanup = restored["turns"][0]["resultCleanups"][0]
    assert cleanup["state"] == "error" and "controlled WebDAV deletion failure" in cleanup["error"]
    assert "synthetic-secret" not in str(restored)
    assert env["client"].get("/api/images", headers=env["headers"]).json()["items"] == []
    assert env["client"].get(path, headers=env["headers"]).status_code == 404
    assert env["client"].get(path.replace("/images/", "/image-thumbnails/"), headers=env["headers"]).status_code == 404
    fail = False
    settings["webdav_url"] = "https://wrong-destination.example"
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert len(remote) == 1
    settings["webdav_url"] = "https://synthetic.example"
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert remote == {}
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["resultCleanups"] == []


def test_shared_results_remain_available_until_last_result_is_deleted(environment, monkeypatch):
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    first = conversation["turns"][0]
    image = first["images"][0]
    monkeypatch.setattr(env["service"], "generation_handler", lambda payload: {"data": [{"url": image["url"]}]})
    assert submit(env, request_id="same-result", conversation_id=conversation["id"]).status_code == 200
    second = wait_for_history(env, 2)["items"][0]["turns"][1]
    for turn, expected in ((first, 200), (second, 404)):
        route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{turn["images"][0]["id"]}'
        assert env["client"].delete(route, headers=env["headers"]).status_code == 200
        assert env["client"].get(image["url"], headers=env["headers"]).status_code == expected
        assert len(env["client"].get("/api/images", headers=env["headers"]).json()["items"]) == (1 if expected == 200 else 0)


def test_prompt_hide_and_result_delete_preserve_input_scopes_and_snapshot(environment, monkeypatch):
    from test.test_image_references_http import upload
    env = environment
    reference = upload(env)
    env["service"].retain_reference(env["owner"], reference["id"], scope="imports")
    monkeypatch.setattr(env["service"], "edit_handler", lambda payload: {"data": [{"url": reference["url"]}]})
    assert submit(env, referenceImages=[{"id": reference["id"]}]).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    response = env["client"].patch(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"],
        json={"turns": [{"id": turn["id"], "promptDeleted": True}]})
    assert response.status_code == 200
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 200
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{turn["images"][0]["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["prompt"] == turn["prompt"]
    assert restored["turns"][0]["referenceImages"] == [reference]
    assert env["client"].get("/api/images", headers=env["headers"]).json()["items"] == []
    assert env["service"].release_reference(env["owner"], reference["id"]) == {"retained": True}
    assert env["service"].release_reference(env["owner"], reference["id"], scope="imports") == {"retained": True}
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 200
    env["service"].delete_conversations(env["owner"], conversation["id"])
    assert env["service"].release_turn_reference(env["owner"], reference["id"], turn["id"]) == {"retained": False}
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404


def test_releasing_input_does_not_delete_another_live_generated_result(environment, monkeypatch):
    from test.test_image_references_http import upload
    env = environment
    reference = upload(env)
    monkeypatch.setattr(env["service"], "generation_handler", lambda payload: {"data": [{"url": reference["url"]}]})
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    assert env["service"].release_reference(env["owner"], reference["id"]) == {"retained": True}
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 200
    assert env["client"].get("/api/image-references", headers=env["headers"]).json()["items"] == []
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{turn["images"][0]["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404


def test_slow_remote_cleanup_does_not_block_history_and_survives_reload(environment, monkeypatch):
    from services import image_storage_service as storage
    env = environment
    entered, release = threading.Event(), threading.Event()

    class Remote:
        def __init__(self, settings):
            pass
        def test(self):
            return {"ok": True}
        def put(self, rel, payload):
            return f"https://synthetic.example/{rel}"
        def delete(self, rel):
            entered.set()
            assert release.wait(5)
            return True

    monkeypatch.setattr(storage, "WebDAVClient", Remote)
    monkeypatch.setitem(config_module.config.data, "image_storage", {"enabled": True, "mode": "both", "webdav_url": "https://synthetic.example"})
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{turn["images"][0]["id"]}'
    with ThreadPoolExecutor(2) as pool:
        deletion = pool.submit(env["client"].delete, route, headers=env["headers"])
        try:
            assert entered.wait(5)
            result = pool.submit(env["client"].get, f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).result(1).json()
            assert result["turns"][0]["images"] == []
            assert result["turns"][0]["resultCleanups"][0]["state"] == "pending"
            restored = ImageTaskService(env["path"]).get_conversation(env["owner"], conversation["id"])
            assert restored["turns"][0]["images"] == []
            assert restored["turns"][0]["resultCleanups"][0]["state"] == "pending"
        finally:
            release.set()
        assert deletion.result(5).status_code == 200


@pytest.mark.parametrize("component", ["thumbnail", "tags"])
def test_local_cleanup_failure_remains_retryable_after_original_is_gone(environment, monkeypatch, component):
    from pathlib import Path
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image = turn["images"][0]
    rel = urlsplit(image["url"]).path.removeprefix("/images/")
    thumbnail = config_module.config.image_thumbnails_dir / f"{rel}.png"
    assert env["client"].get(f"/image-thumbnails/{rel}", headers=env["headers"]).status_code == 200
    tags.set_tags(rel, ["original"])
    target = thumbnail if component == "thumbnail" else tags.TAGS_FILE
    operation = "unlink" if component == "thumbnail" else "read_text"
    original = getattr(Path, operation)
    def fail(path, *args, **kwargs):
        if path == target:
            raise OSError(f"controlled {component} failure")
        return original(path, *args, **kwargs)
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}'
    with monkeypatch.context() as fault:
        fault.setattr(Path, operation, fail)
        assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["resultCleanups"][0]["state"] == "error"
    assert not (config_module.config.images_dir / rel).exists()
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert not thumbnail.exists() and tags.get_tags(rel) == []


def test_persisted_delete_before_background_start_is_retryable_after_restart(environment, monkeypatch):
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image = turn["images"][0]
    query = {"ids": [image["id"]], "versions": {image["id"]: image["updatedAt"]}}
    assert env["client"].post("/api/image-tasks/query", headers=env["headers"], json=query).json()["items"] == []
    env["service"].delete_result(env["owner"], conversation["id"], turn["id"], image["id"])
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    changed = env["client"].post("/api/image-tasks/query", headers=env["headers"], json=query).json()["items"]
    assert len(changed) == 1 and changed[0]["result_deleted"] and "data" not in changed[0]
    query["versions"][image["id"]] = changed[0]["updated_at"]
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["images"] == []
    assert restored["turns"][0]["resultCleanups"][0]["state"] == "pending"
    assert env["client"].get("/api/images", headers=env["headers"]).json()["items"] == []
    assert env["client"].get(image["url"], headers=env["headers"]).status_code == 404
    assert env["client"].get(image["url"].replace("/images/", "/image-thumbnails/"), headers=env["headers"]).status_code == 404
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    completed = env["client"].post("/api/image-tasks/query", headers=env["headers"], json=query).json()["items"]
    assert len(completed) == 1 and completed[0]["result_cleanup"]["state"] == "complete"
    query["versions"][image["id"]] = completed[0]["updated_at"]
    assert env["client"].post("/api/image-tasks/query", headers=env["headers"], json=query).json()["items"] == []
    assert env["client"].get(image["url"], headers=env["headers"]).status_code == 404


def test_failed_tombstone_commit_never_starts_physical_cleanup(environment, monkeypatch):
    from test.image_storage_faults import deny_sqlite_commits
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image = turn["images"][0]
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}'
    with monkeypatch.context() as failure:
        deny_sqlite_commits(failure, env["path"], "controlled deletion commit failure")
        assert env["client"].delete(route, headers=env["headers"]).status_code == 507
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["images"][0]["id"] == image["id"]
    assert env["client"].get(image["url"], headers=env["headers"]).status_code == 200


def test_simultaneous_single_deletions_do_not_restore_each_others_tags(environment, monkeypatch):
    from pathlib import Path
    import time
    env = environment
    assert submit(env, count=3).status_code == 200
    conversation = wait_for_history(env, 3)["items"][0]
    turn = conversation["turns"][0]
    paths = [urlsplit(image["url"]).path.removeprefix("/images/") for image in turn["images"]]
    for rel in paths:
        tags.set_tags(rel, ["original"])
    entered, release = threading.Event(), threading.Event()
    original = Path.replace
    def slow_first_write(path, *args, **kwargs):
        if path == tags.TAGS_FILE.with_suffix(".tmp") and not entered.is_set():
            entered.set()
            assert release.wait(5)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "replace", slow_first_write)
    routes = [f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}' for image in turn["images"][:2]]
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(env["client"].delete, routes[0], headers=env["headers"])
        try:
            assert entered.wait(5)
            second = pool.submit(env["client"].delete, routes[1], headers=env["headers"])
            time.sleep(.1)
        finally:
            release.set()
        assert first.result(5).status_code == second.result(5).status_code == 200
    assert [tags.get_tags(rel) for rel in paths] == [[], [], ["original"]]


@pytest.mark.parametrize("failure", ["index_write", "tasks_wal", "index_wal", "tags_replace"])
def test_atomic_deletion_and_tag_failures_preserve_retry_data(environment, monkeypatch, failure):
    from pathlib import Path
    import sqlite3
    from services.image_storage_service import image_storage_service
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image = turn["images"][0]
    rel = urlsplit(image["url"]).path.removeprefix("/images/")
    tags.set_tags(rel, ["original"])
    before = tags.TAGS_FILE.read_bytes()
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}'
    index_path = image_storage_service.index_file.with_suffix(".sqlite3")
    if failure.endswith("wal"):
        with sqlite3.connect(env["path"] if failure == "tasks_wal" else index_path) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
    elif failure == "index_write":
        with sqlite3.connect(index_path) as connection:
            connection.execute("CREATE TRIGGER fail_visibility BEFORE UPDATE ON image_rows BEGIN SELECT RAISE(ABORT, 'controlled index failure'); END")
    else:
        original = Path.replace
        def fail_replace(path, target):
            if target == tags.TAGS_FILE:
                raise OSError("controlled tag replacement failure")
            return original(path, target)
        monkeypatch.setattr(Path, "replace", fail_replace)
    response = env["client"].delete(route, headers=env["headers"])
    assert response.status_code == (200 if failure == "tags_replace" else 507)
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert tags.TAGS_FILE.read_bytes() == before
    if failure == "tags_replace":
        assert restored["turns"][0]["resultCleanups"][0]["state"] == "error"
    else:
        assert restored["turns"][0]["images"][0]["id"] == image["id"]
        assert len(env["client"].get("/api/images", headers=env["headers"]).json()["items"]) == 1
        assert env["client"].get(image["url"], headers=env["headers"]).status_code == 200


def test_local_result_synced_to_new_webdav_deletes_the_actual_added_copy(environment, monkeypatch):
    from services import image_storage_service as storage
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image = turn["images"][0]
    remote = {}
    class Remote:
        def __init__(self, settings):
            pass
        def put(self, rel, data):
            remote[rel] = data
            return f"https://new.example/{rel}"
        def delete(self, rel):
            return remote.pop(rel, None) is not None
    monkeypatch.setattr(storage, "WebDAVClient", Remote)
    monkeypatch.setitem(config_module.config.data, "image_storage", {"enabled": True, "mode": "both", "webdav_url": "https://new.example", "webdav_username": "user/"})
    assert storage.image_storage_service.sync_all()["uploaded"] == 1
    assert len(remote) == 1
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["resultCleanups"] == []
    assert remote == {}


@pytest.mark.parametrize("invalid_tags", ["{broken", "[]"])
def test_corrupt_tags_keep_cleanup_retry_without_repeating_removed_remote_copy(environment, monkeypatch, invalid_tags):
    from services import image_storage_service as storage
    env = environment
    remote = {}
    deletions = []
    class Remote:
        def __init__(self, settings):
            pass
        def test(self):
            return {"ok": True}
        def put(self, rel, data):
            remote[rel] = data
            return f"https://synthetic.example/{rel}"
        def delete(self, rel):
            deletions.append(rel)
            return remote.pop(rel, None) is not None
    monkeypatch.setattr(storage, "WebDAVClient", Remote)
    monkeypatch.setitem(config_module.config.data, "image_storage", {"enabled": True, "mode": "both", "webdav_url": "https://synthetic.example"})
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image = turn["images"][0]
    tags.TAGS_FILE.write_text(invalid_tags, encoding="utf-8")
    route = f'/api/image-conversations/{conversation["id"]}/turns/{turn["id"]}/images/{image["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert remote == {} and len(deletions) == 1
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["resultCleanups"][0]["state"] == "error"
    assert "标签" in restored["turns"][0]["resultCleanups"][0]["error"]
    assert tags.TAGS_FILE.read_text(encoding="utf-8") == invalid_tags
    tags.TAGS_FILE.write_text("{}", encoding="utf-8")
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert len(deletions) == 1
    restored = env["client"].get(f'/api/image-conversations/{conversation["id"]}', headers=env["headers"]).json()
    assert restored["turns"][0]["resultCleanups"] == []
