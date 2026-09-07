"""Public HTTP checks: real temporary storage/auth, controlled image upstream."""
from __future__ import annotations

import base64
import io
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from api import image_tasks, support, system
from services import config as config_module, image_storage_service as storage_module
from services import image_tags_service as tags_module
from services.auth_service import AuthService
from services.image_task_service import ImageTaskService
from services.storage.json_storage import JSONStorageBackend
from services.image_service import delete_to_target
from urllib.parse import urlsplit
from test.image_storage_faults import deny_sqlite_commits


def image_bytes():
    output = io.BytesIO()
    Image.new("RGB", (24, 16), "red").save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def environment(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "DATA_DIR", tmp_path)
    monkeypatch.setattr(storage_module.image_storage_service, "index_file", tmp_path / "image_index.json")
    monkeypatch.setattr(tags_module, "TAGS_FILE", tmp_path / "image_tags.json")
    auth = AuthService(JSONStorageBackend(tmp_path / "accounts.json"))
    monkeypatch.setattr(support, "auth_service", auth)
    owner, key = auth.create_key(role="admin", name="Owner")
    _, other_key = auth.create_key(role="admin", name="Other")
    calls = []

    def upstream(payload):
        calls.append(payload)
        return {"data": [{"b64_json": base64.b64encode(image_bytes()).decode()}]}

    path = tmp_path / "tasks.sqlite3"
    service = ImageTaskService(path, generation_handler=upstream, edit_handler=upstream)
    monkeypatch.setattr(image_tasks, "image_task_service", service)
    app = FastAPI()
    app.include_router(image_tasks.create_router())
    app.include_router(system.create_router("test"))
    return {
        "client": TestClient(app), "app": app, "path": path, "service": service,
        "headers": {"Authorization": f"Bearer {key}"},
        "other": {"Authorization": f"Bearer {other_key}"},
        "owner": owner, "calls": calls, "upstream": upstream,
    }


def submit(env, **overrides):
    return env["client"].post("/api/image-conversations/turns", headers=env["headers"], json={
        "request_id": "round-one", "prompt": "a red kite", "model": "gpt-image-2",
        "size": "1024x1024", "count": 1, "quality": "high", **overrides,
    })


def read_history(client, headers):
    history = client.get("/api/image-conversations", headers=headers).json()
    history["items"] = [client.get(f"/api/image-conversations/{item['id']}?offset=0&limit=10", headers=headers).json()
                        for item in history["items"]]
    return history


def wait_for_history(env, count=1):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        history = read_history(env["client"], env["headers"])
        images = [image for conv in history["items"] for turn in conv["turns"] for image in turn["images"]]
        # List metadata and detail pages are separate snapshots; both must be terminal.
        settled = all(item["stats"] == {"queued": 0, "running": 0} for item in [history, *history["items"]])
        if settled and len(images) == count and all(image["status"] != "loading" for image in images):
            return history
        time.sleep(0.02)
    raise AssertionError(f"Tasks did not finish: {history}")


def test_wait_for_history_retries_when_tasks_finish_between_list_and_detail(environment, monkeypatch):
    env = environment
    entered, release = threading.Event(), threading.Event()

    def upstream(payload):
        payload["lifecycle_callback"]("sending", {"protocol": "controlled"})
        entered.set()
        assert release.wait(10)
        return env["upstream"](payload)

    monkeypatch.setattr(env["service"], "generation_handler", upstream)
    get = env["client"].get
    list_reads = 0

    def finish_after_list(url, **kwargs):
        nonlocal list_reads
        response = get(url, **kwargs)
        if url == "/api/image-conversations":
            list_reads += 1
            if list_reads == 1:
                assert response.json()["stats"] == {"queued": 0, "running": 1}
                release.set()
                detail_url = f"/api/image-conversations/{response.json()['items'][0]['id']}"
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if get(detail_url, **kwargs).json()["turns"][0]["images"][0]["status"] == "success":
                        break
                    time.sleep(0.02)
                else:
                    raise AssertionError("Controlled upstream did not finish before the detail read")
        return response

    try:
        assert submit(env).status_code == 200
        assert entered.wait(10)
        monkeypatch.setattr(env["client"], "get", finish_after_list)
        history = wait_for_history(env)
        assert history["stats"] == {"queued": 0, "running": 0}
        assert list_reads >= 2
        assert history == read_history(env["client"], env["headers"])
    finally:
        release.set()


def test_roundtrip_restores_configuration_tasks_and_current_conversation(environment, monkeypatch):
    env = environment
    response = submit(env)
    assert response.status_code == 200, response.text
    history = wait_for_history(env)
    conversation = history["items"][0]
    turn = conversation["turns"][0]
    assert history["current_conversation_id"] == conversation["id"]
    assert turn["prompt"] == "a red kite"
    assert (turn["quality"], turn["size"], turn["count"]) == ("high", "1024x1024", 1)
    assert turn["sourceEntryId"]
    assert turn["images"][0]["status"] == "success"
    assert len(env["calls"]) == 1
    reloaded = ImageTaskService(env["path"], generation_handler=env["upstream"])
    monkeypatch.setattr(image_tasks, "image_task_service", reloaded)
    with TestClient(env["app"]) as second_browser:
        assert read_history(second_browser, env["headers"]) == history
        assert second_browser.get("/api/image-conversations", headers=env["other"]).json()["items"] == []
        assert second_browser.get(f"/api/image-conversations/{conversation['id']}", headers=env["other"]).status_code == 404
        task_id = turn["images"][0]["taskId"]
        assert second_browser.get(f"/api/image-tasks?ids={task_id}", headers=env["other"]).json()["missing_ids"] == [task_id]


def test_concurrent_first_submissions_and_network_retries_share_one_target(environment):
    env = environment
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda index: submit(env, request_id=f"request-{index % 4}"), range(8)))
    assert all(response.status_code == 200 for response in responses), [response.text for response in responses]
    assert len({response.json()["id"] for response in responses}) == 1
    history = wait_for_history(env, 4)
    assert len(history["items"]) == 1
    assert len(history["items"][0]["turns"]) == 4
    assert all(turn["images"][0]["status"] == "success" for turn in history["items"][0]["turns"])
    assert len(env["calls"]) == 4
    replay = submit(env, request_id="request-0")
    assert replay.status_code == 200
    assert len(env["calls"]) == 4


def test_failed_initial_save_is_not_visible_or_consumed_and_retry_can_start(environment, monkeypatch):
    env = environment
    with monkeypatch.context() as failure:
        deny_sqlite_commits(failure, env["path"], "controlled destination sharing violation")
        response = submit(env)
        assert response.status_code == 507, response.text
        assert "controlled destination sharing violation" in response.text
        assert env["client"].get("/api/image-conversations", headers=env["headers"]).json()["items"] == []
        assert env["client"].get("/api/image-tasks", headers=env["headers"]).json()["items"] == []
        assert env["calls"] == []
    assert submit(env).status_code == 200
    assert wait_for_history(env)["items"][0]["turns"][0]["images"][0]["status"] == "success"
    assert len(env["calls"]) == 1


def test_failure_saving_running_state_is_terminal_without_upstream_consumption(environment, monkeypatch):
    env = environment
    with monkeypatch.context() as failure:
        deny_sqlite_commits(failure, env["path"], "controlled running state save failure", after=1)
        assert submit(env).status_code == 200
        image = wait_for_history(env)["items"][0]["turns"][0]["images"][0]
        assert image["status"] == "error"
        assert "controlled running state save failure" in image["error"]
        assert env["calls"] == []
    reloaded = ImageTaskService(env["path"], generation_handler=env["upstream"])
    monkeypatch.setattr(image_tasks, "image_task_service", reloaded)
    reloaded.start()
    assert wait_for_history(env)["items"][0]["turns"][0]["images"][0]["status"] == "success"
    assert len(env["calls"]) == 1


@pytest.mark.parametrize("count", [1, 4, 100])
def test_all_requested_images_finish_with_real_temporary_storage(environment, count):
    env = environment
    response = submit(env, count=count)
    assert response.status_code == 200, response.text
    turn = wait_for_history(env, count)["items"][0]["turns"][0]
    assert len(turn["images"]) == count
    assert all(image["status"] == "success" for image in turn["images"]), [image for image in turn["images"] if image["status"] != "success"]
    assert len(env["calls"]) == count


def test_original_and_thumbnail_require_the_stable_owner_even_for_identical_pixels(environment):
    env = environment
    assert submit(env).status_code == 200
    image = wait_for_history(env)["items"][0]["turns"][0]["images"][0]
    assert "b64_json" not in image
    original = urlsplit(image["url"]).path
    for alias in ("managed.", "managed%20", "MANAGED."):
        assert env["client"].get(original.replace("/managed/", f"/{alias}/")).status_code == 404
    thumbnail = original.replace("/images/", "/image-thumbnails/", 1)
    for path in (original, thumbnail):
        assert env["client"].get(path).status_code == 401
        assert env["client"].get(path, headers=env["other"]).status_code == 404
        response = env["client"].get(path, headers=env["headers"])
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store"
        assert Image.open(io.BytesIO(response.content)).size == (24, 16)
    other_submission = env["client"].post("/api/image-conversations/turns", headers=env["other"], json={
        "request_id": "other-round", "prompt": "identical pixels", "count": 1,
    })
    assert other_submission.status_code == 200
    other_env = {**env, "headers": env["other"]}
    other_image = wait_for_history(other_env)["items"][0]["turns"][0]["images"][0]
    assert other_image["url"] != image["url"]
    assert env["client"].get(urlsplit(other_image["url"]).path, headers=env["headers"]).status_code == 404


def test_managed_originals_thumbnails_and_tasks_survive_expiry_and_low_disk_cleanup(environment, monkeypatch):
    env = environment
    assert submit(env).status_code == 200
    history = wait_for_history(env)
    image = history["items"][0]["turns"][0]["images"][0]
    path = urlsplit(image["url"]).path
    thumb = path.replace("/images/", "/image-thumbnails/", 1)
    assert env["client"].get(thumb, headers=env["headers"]).status_code == 200
    for directory in (config_module.config.images_dir, config_module.config.image_thumbnails_dir):
        for file in directory.rglob("*"):
            if file.is_file():
                os.utime(file, (1, 1))
    monkeypatch.setattr("services.image_service.shutil.disk_usage", lambda _path: type("Usage", (), {"free": 0})())
    config_module.config.cleanup_old_images()
    assert delete_to_target(500)["removed"] == 0
    assert env["client"].get(path, headers=env["headers"]).status_code == 200
    assert env["client"].get(thumb, headers=env["headers"]).status_code == 200
    assert wait_for_history(env) == history


def test_insufficient_disk_space_rejects_submission_before_consumption(environment, monkeypatch):
    env = environment
    monkeypatch.setattr(storage_module.shutil, "disk_usage", lambda _path: type("Usage", (), {"free": 0})())
    response = submit(env)
    assert response.status_code == 507, response.text
    assert "空间不足" in response.text
    assert env["calls"] == []
    assert env["client"].get("/api/image-conversations", headers=env["headers"]).json()["items"] == []


def test_unwritable_image_index_is_reported_before_consumption(environment, monkeypatch):
    env = environment
    deny_sqlite_commits(monkeypatch, storage_module.image_storage_service.index_file, "controlled image index save failure")
    response = submit(env)
    assert response.status_code == 507, response.text
    assert "controlled image index save failure" in response.text
    assert env["calls"] == []


def test_legacy_gallery_and_tag_endpoints_cannot_bypass_managed_ownership(environment):
    env = environment
    assert submit(env).status_code == 200
    image = wait_for_history(env)["items"][0]["turns"][0]["images"][0]
    path = urlsplit(image["url"]).path
    rel = path.removeprefix("/images/")
    assert env["client"].get("/api/images", headers=env["other"]).json()["items"] == []
    assert len(env["client"].get("/api/images", headers=env["headers"]).json()["items"]) == 1
    assert env["client"].post("/api/images/tags", headers=env["headers"], json={"path": rel, "tags": ["private label"]}).status_code == 200
    assert env["client"].get("/api/images/tags", headers=env["other"]).json()["tags"] == []
    assert env["client"].post("/api/images/tags", headers=env["other"], json={"path": rel, "tags": ["changed"]}).status_code == 404
    assert env["client"].delete("/api/images/tags/private%20label", headers=env["other"]).json()["removed_from"] == 0
    assert env["client"].get("/api/images/tags", headers=env["headers"]).json()["tags"] == ["private label"]
    assert env["client"].post("/api/images/delete", headers=env["other"], json={"paths": [rel]}).status_code == 404
    assert env["client"].post("/api/images/delete", headers=env["headers"], json={"paths": [rel]}).status_code == 409
    assert env["client"].post("/api/images/delete", headers=env["other"], json={"all_matching": True}).json()["removed"] == 0
    assert env["client"].post("/api/images/storage/compress", headers=env["other"]).json()["compressed"] == 0
    assert env["client"].get(f"/api/images/download/{rel}", headers=env["other"]).status_code == 404
    assert env["client"].post("/api/images/download", headers=env["other"], json={"paths": [rel]}).status_code == 404
    assert env["client"].get(path, headers=env["headers"]).content == image_bytes()


@pytest.mark.parametrize("reference", [{}, {"dataUrl": "broken"}, {"name": "x.png", "type": "image/png", "dataUrl": "data:image/png;base64,!!!"}])
def test_invalid_reference_inputs_are_rejected_before_consumption(environment, reference):
    env = environment
    response = submit(env, referenceImages=[reference])
    assert response.status_code == 422, response.text
    assert env["calls"] == []


def test_reference_entry_still_submits_once_and_restores_its_config(environment):
    env = environment
    uploaded = env["client"].post("/api/image-references", headers=env["headers"],
        data={"request_id": "reference"}, files={"file": ("reference.png", image_bytes(), "image/png")})
    assert uploaded.status_code == 200, uploaded.text
    reference = uploaded.json()
    assert submit(env, referenceImages=[{"id": reference["id"]}]).status_code == 200
    turn = wait_for_history(env)["items"][0]["turns"][0]
    assert turn["mode"] == "edit"
    assert turn["referenceImages"] == [reference]
    assert env["calls"][0]["images"] == [(image_bytes(), "reference.png", "image/png")]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows file sharing semantics")
def test_real_windows_reader_does_not_lose_an_accepted_task(environment):
    import ctypes
    from ctypes import wintypes

    env = environment
    created = env["client"].post("/api/image-conversations", headers=env["headers"], json={"request_id": "empty"})
    assert created.status_code == 200
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    # A real reader allows other reads/writes, but withholds FILE_SHARE_DELETE.
    handle = kernel.CreateFileW(str(env["path"]), 0x80000000, 3, None, 3, 0, None)
    assert handle != wintypes.HANDLE(-1).value, ctypes.get_last_error()
    try:
        response = submit(env)
        assert response.status_code == 200, response.text
    finally:
        kernel.CloseHandle(handle)
    image = wait_for_history(env)["items"][0]["turns"][0]["images"][0]
    assert image["status"] == "success", image
    assert len(env["calls"]) == 1


def test_snapshot_cannot_be_overwritten_and_explicit_new_conversation_is_restored(environment):
    env = environment
    assert submit(env).status_code == 200
    first = wait_for_history(env)["items"][0]
    turn = first["turns"][0]
    route = f"/api/image-conversations/{first['id']}"
    assert env["client"].patch(route, headers=env["other"], json={"title": "stolen"}).status_code == 404
    assert env["client"].put("/api/image-conversations/current", headers=env["other"], json={"conversation_id": first["id"]}).status_code == 404
    assert submit(env, request_id="foreign", conversation_id="missing").status_code == 404
    assert env["client"].patch(route, headers=env["headers"], json={"turns": [{"id": turn["id"], "prompt": "overwritten"}]}).status_code == 422
    hidden = env["client"].patch(route, headers=env["headers"], json={"turns": [{"id": turn["id"], "promptDeleted": True}]}).json()
    assert hidden["turns"][0]["prompt"] == "a red kite"
    new = env["client"].post("/api/image-conversations", headers=env["headers"], json={"request_id": "new-product"}).json()
    assert new["id"] != first["id"]
    assert new["turns"] == []
    assert env["client"].post("/api/image-conversations", headers=env["headers"], json={"request_id": "new-product"}).json()["id"] == new["id"]
    assert env["client"].get("/api/image-conversations", headers=env["headers"]).json()["current_conversation_id"] == new["id"]


@pytest.mark.parametrize("mode", ["webdav", "both"])
def test_remote_copies_stay_behind_owned_routes(environment, monkeypatch, mode):
    env = environment
    remote = {}

    class ControlledWebDAV:
        def __init__(self, _settings):
            pass

        def test(self):
            return {"ok": True}

        def put(self, rel, payload):
            remote[rel] = payload
            return f"https://private-storage.example.test/{rel}"

        def get(self, rel):
            return remote[rel]

    monkeypatch.setattr(storage_module, "WebDAVClient", ControlledWebDAV)
    monkeypatch.setitem(config_module.config.data, "image_storage", {
        "enabled": True, "mode": mode, "webdav_url": "https://private-storage.example.test",
        "public_base_url": "https://public-cdn.example.test",
    })
    assert submit(env).status_code == 200
    image = wait_for_history(env)["items"][0]["turns"][0]["images"][0]
    assert image["url"].startswith("http://testserver/images/managed/")
    rel = urlsplit(image["url"]).path.removeprefix("/images/")
    assert remote[rel] == image_bytes()
    assert env["client"].get(image["url"], headers=env["headers"]).content == image_bytes()
    assert env["client"].get(image["url"], headers=env["other"]).status_code == 404
    gallery = env["client"].get("/api/images", headers=env["headers"])
    assert "private-storage.example.test" not in gallery.text
    assert "public-cdn.example.test" not in gallery.text


def test_unavailable_remote_storage_blocks_consumption(environment, monkeypatch):
    env = environment

    class UnavailableWebDAV:
        def __init__(self, _settings):
            pass

        def test(self):
            return {"ok": False, "error": "controlled remote write denied"}

    monkeypatch.setattr(storage_module, "WebDAVClient", UnavailableWebDAV)
    monkeypatch.setitem(config_module.config.data, "image_storage", {"enabled": True, "mode": "both", "webdav_url": "https://private-storage.example.test"})
    response = submit(env)
    assert response.status_code == 507, response.text
    assert "controlled remote write denied" in response.text
    assert env["calls"] == []
