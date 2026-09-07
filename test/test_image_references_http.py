"""Reference lifecycle through HTTP, with real files and controlled generation."""
from urllib.parse import urlsplit
import io
import time

import pytest
from PIL import Image

from test.test_image_conversations_http import environment, image_bytes, submit


def upload(env, request_id="upload-one", name="original.png"):
    response = env["client"].post("/api/image-references", headers=env["headers"],
        data={"request_id": request_id}, files={"file": (name, image_bytes(), "image/png")})
    assert response.status_code == 200, response.text
    return response.json()


def test_cancel_upload_before_arrival_is_durable_and_identity_scoped(environment, monkeypatch):
    from services.image_task_service import ImageTaskService
    from api import image_tasks
    env = environment
    route = "/api/image-references/uploads/late-upload"
    assert env["client"].delete(route, headers=env["headers"]).json() == {"retained": False}
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    response = env["client"].post("/api/image-references", headers=env["headers"],
        data={"request_id": "late-upload"}, files={"file": ("original.png", image_bytes(), "image/png")})
    assert response.status_code == 400
    assert env["client"].get("/api/image-references", headers=env["headers"]).json()["items"] == []
    other = env["client"].post("/api/image-references", headers=env["other"],
        data={"request_id": "late-upload"}, files={"file": ("original.png", image_bytes(), "image/png")})
    assert other.status_code == 200


def test_cancel_upload_after_lost_confirmation_cleans_file_and_retries(environment, monkeypatch):
    from services.image_storage_service import image_storage_service
    env = environment
    reference = upload(env, "lost-confirmation")
    route = "/api/image-references/uploads/lost-confirmation"
    with monkeypatch.context() as failure:
        failure.setattr(image_storage_service, "delete", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("controlled cleanup failure")))
        assert env["client"].delete(route, headers=env["headers"]).status_code == 507
    assert env["client"].delete(route, headers=env["headers"]).json() == {"retained": False}
    assert env["client"].delete(route, headers=env["headers"]).json() == {"retained": False}
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404


def test_upload_once_ordered_snapshot_and_release_survive_reload(environment, monkeypatch):
    env = environment
    first = upload(env)
    assert upload(env) == first
    second = upload(env, "upload-two", "second.png")
    refs = [{"id": second["id"]}, {"id": first["id"]}]
    response = submit(env, referenceImages=refs, count=4)
    assert response.status_code == 200, response.text
    conversation_id = response.json()["id"]
    turn = response.json()["turns"][0]
    assert turn["referenceImages"] == [second, first]
    assert "data:" not in response.text
    for reference in (first, second):
        assert env["client"].delete(f'/api/image-references/{reference["id"]}', headers=env["headers"]).status_code == 200
        assert env["client"].get(urlsplit(reference["url"]).path, headers=env["headers"]).content == image_bytes()
        assert env["client"].get(urlsplit(reference["url"]).path, headers=env["other"]).status_code == 404
    from services.image_task_service import ImageTaskService
    from api import image_tasks
    import time
    for _ in range(500):
        history = env["client"].get(f"/api/image-conversations/{conversation_id}", headers=env["headers"]).json()
        if all(image["status"] == "success" for image in history["turns"][0]["images"]):
            break
        time.sleep(.02)
    assert len(env["calls"]) == 4
    assert all(call["images"] == [(image_bytes(), "second.png", "image/png"), (image_bytes(), "original.png", "image/png")] for call in env["calls"])
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    restored = env["client"].get(f"/api/image-conversations/{conversation_id}", headers=env["headers"]).json()
    assert restored["turns"][0]["referenceImages"] == [second, first]
    assert restored["turns"][0]["prompt"] == "a red kite"


def test_cross_identity_submit_release_and_unreferenced_cleanup(environment):
    env = environment
    reference = upload(env)
    path = urlsplit(reference["url"]).path
    denied = env["client"].post("/api/image-conversations/turns", headers=env["other"], json={
        "request_id": "stolen", "prompt": "stolen reference", "referenceImages": [{"id": reference["id"]}]})
    assert denied.status_code == 404
    assert env["client"].delete(f'/api/image-references/{reference["id"]}', headers=env["other"]).status_code == 404
    assert env["calls"] == []
    assert env["client"].get(path.replace("/images/", "/image-thumbnails/"), headers=env["headers"]).status_code == 200
    for _ in range(2):
        assert env["client"].delete(f'/api/image-references/{reference["id"]}', headers=env["headers"]).json() == {"retained": False}
    assert env["client"].get(path, headers=env["headers"]).status_code == 404
    assert env["client"].get(path.replace("/images/", "/image-thumbnails/"), headers=env["headers"]).status_code == 404
    assert submit(env, referenceImages=[{"id": reference["id"]}]).status_code == 404


def test_v1_edits_resolves_only_owned_local_file_ids(environment, monkeypatch):
    from api import ai
    env = environment
    reference = upload(env)
    monkeypatch.setattr(ai, "image_task_service", env["service"])
    monkeypatch.setattr(ai.openai_v1_image_edit, "handle", env["upstream"])
    env["app"].include_router(ai.create_router())
    for key, status in (("other", 404), ("headers", 200)):
        response = env["client"].post("/v1/images/edits", headers=env[key], json={
            "prompt": "edit saved file", "images": [{"file_id": reference["id"]}]})
        assert response.status_code == status, response.text
    assert env["calls"][0]["images"] == [(image_bytes(), "original.png", "image/png")]


def test_upload_confirmation_failure_keeps_retryable_record_after_reload(environment, monkeypatch):
    from pathlib import Path
    from services.image_task_service import ImageTaskService
    from api import image_tasks
    env = environment
    replace = Path.replace
    saves = 0

    def fail_confirmation(source, target):
        nonlocal saves
        if Path(target) == env["path"]:
            saves += 1
            if saves > 1:
                raise PermissionError("controlled upload confirmation failure")
        return replace(source, target)

    with monkeypatch.context() as failure:
        failure.setattr(Path, "replace", fail_confirmation)
        response = env["client"].post("/api/image-references", headers=env["headers"],
            data={"request_id": "recover-upload"}, files={"file": ("original.png", image_bytes(), "image/png")})
        assert response.status_code == 507, response.text
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    pending = env["client"].get("/api/image-references", headers=env["headers"]).json()["items"]
    assert len(pending) == 1 and pending[0]["error"]
    assert submit(env, referenceImages=[{"id": pending[0]["id"]}]).status_code == 400
    reference = upload(env, "recover-upload")
    assert reference["id"] == pending[0]["id"]
    assert env["client"].get(urlsplit(reference["url"]).path, headers=env["headers"]).content == image_bytes()


def test_independent_scopes_and_retain_protect_last_snapshot_until_final_release(environment):
    env = environment
    reference = upload(env)
    service = env["service"]
    owner = env["owner"]
    ref_id = reference["id"]
    service.retain_reference(owner, ref_id, scope="imports")
    assert env["client"].delete(f"/api/image-references/{ref_id}", headers=env["headers"]).json() == {"retained": True}
    assert env["client"].get("/api/image-references", headers=env["headers"]).json()["items"] == []
    assert service.list_references(owner, scope="imports")["items"] == [reference]
    conversation = submit(env, referenceImages=[{"id": ref_id}]).json()
    turn = conversation["turns"][0]
    with pytest.raises(ValueError, match="快照仍存在"):
        service.release_turn_reference(owner, ref_id, turn["id"])
    assert env["client"].post(f"/api/image-references/{ref_id}/retain", headers=env["headers"]).json() == reference
    assert service.release_reference(owner, ref_id, scope="imports") == {"retained": True}
    for _ in range(500):
        result = service.get_conversation(owner, conversation["id"])
        if result["turns"][0]["status"] == "success":
            break
        time.sleep(.01)
    assert result["turns"][0]["status"] == "success"
    service.delete_conversations(owner, conversation["id"])
    assert service.release_turn_reference(owner, ref_id, turn["id"]) == {"retained": True}
    assert env["client"].get(reference["url"], headers=env["headers"]).content == image_bytes()
    assert env["client"].delete(f"/api/image-references/{ref_id}", headers=env["headers"]).json() == {"retained": False}
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404


@pytest.mark.parametrize("mode", ["webdav", "both"])
def test_pending_upload_and_remote_delete_failure_keep_original_target_and_retry(environment, monkeypatch, mode):
    from api import image_tasks
    from services import image_storage_service as storage, config as config_module
    from services.image_task_service import ImageTaskService
    from pathlib import Path
    env = environment
    remote = {}
    fail_delete = True

    class Remote:
        def __init__(self, _settings):
            pass
        def test(self):
            return {"ok": True}
        def put(self, rel, payload, content_type="image/png"):
            remote[rel] = payload
            return f"https://synthetic.example/{rel}"
        def get(self, rel):
            return remote[rel]
        def delete(self, rel):
            if fail_delete:
                raise storage.ImageStorageError("controlled remote deletion failure")
            return remote.pop(rel, None) is not None

    monkeypatch.setattr(storage, "WebDAVClient", Remote)
    settings = {"enabled": True, "mode": mode, "webdav_url": "https://synthetic.example/"}
    monkeypatch.setitem(config_module.config.data, "image_storage", settings)
    replace = Path.replace
    saves = 0
    def fail_confirmation(source, target):
        nonlocal saves
        if Path(target) == env["path"]:
            saves += 1
            if saves > 1:
                raise PermissionError("controlled confirmation failure")
        return replace(source, target)
    with monkeypatch.context() as failure:
        failure.setattr(Path, "replace", fail_confirmation)
        response = env["client"].post("/api/image-references", headers=env["headers"], data={"request_id": "pending-remote"},
            files={"file": ("original.png", image_bytes(), "image/png")})
        assert response.status_code == 507
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    pending = env["client"].get("/api/image-references", headers=env["headers"]).json()["items"][0]
    assert len(remote) == 1
    # A retry may not silently replace the original bytes or destination.
    changed = env["client"].post("/api/image-references", headers=env["headers"], data={"request_id": "pending-remote"},
        files={"file": ("original.png", b"different", "image/png")})
    assert changed.status_code == 400
    settings["webdav_url"] = "https://another.example/"
    changed = env["client"].post("/api/image-references", headers=env["headers"], data={"request_id": "pending-remote"},
        files={"file": ("original.png", image_bytes(), "image/png")})
    assert changed.status_code == 507 and "位置已变更" in changed.text
    settings["webdav_url"] = "https://synthetic.example/"
    route = f'/api/image-references/{pending["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 507
    assert len(remote) == 1
    monkeypatch.setattr(image_tasks, "image_task_service", ImageTaskService(env["path"]))
    retryable = env["client"].get("/api/image-references", headers=env["headers"]).json()["items"][0]
    assert "释放未完成" in retryable["error"]
    fail_delete = False
    assert env["client"].delete(route, headers=env["headers"]).json() == {"retained": False}
    assert not remote
    assert env["client"].get(pending["url"], headers=env["headers"]).status_code == 404


@pytest.mark.parametrize("format,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp"), ("GIF", "image/gif")])
def test_reference_preserves_original_bytes_and_real_format(environment, format, mime):
    env = environment
    output = io.BytesIO()
    Image.new("RGB", (20, 10), "blue").save(output, format=format)
    payload = output.getvalue()
    response = env["client"].post("/api/image-references", headers=env["headers"], data={"request_id": format},
        files={"file": ("misnamed.png", payload, "application/octet-stream")})
    assert response.status_code == 200, response.text
    reference = response.json()
    assert reference["type"] == mime
    original = env["client"].get(reference["url"], headers=env["headers"])
    assert original.content == payload
    assert original.headers["content-type"].split(";")[0] == mime


def test_shared_conversations_and_inflight_task_keep_snapshot_until_settled(environment):
    import threading
    env = environment
    reference = upload(env)
    service = env["service"]
    owner = env["owner"]
    first = submit(env, referenceImages=[{"id": reference["id"]}]).json()
    for _ in range(500):
        if service.get_conversation(owner, first["id"])["turns"][0]["status"] == "success":
            break
        time.sleep(.01)
    entered, finish = threading.Event(), threading.Event()
    def slow_upstream(payload):
        entered.set()
        assert finish.wait(5)
        return env["upstream"](payload)
    service.edit_handler = slow_upstream
    second = service.create_conversation(owner, "another-conversation")
    try:
        second = submit(env, request_id="another-turn", conversation_id=second["id"], prompt="new prompt", referenceImages=[{"id": reference["id"]}]).json()
        assert entered.wait(2)
        assert service.release_reference(owner, reference["id"]) == {"retained": True}
        service.delete_conversations(owner, first["id"])
        assert service.release_turn_reference(owner, reference["id"], first["turns"][0]["id"]) == {"retained": True}
        service.delete_conversations(owner, second["id"])
        with pytest.raises(ValueError, match="在途任务"):
            service.release_turn_reference(owner, reference["id"], second["turns"][0]["id"])
        assert env["client"].get(reference["url"], headers=env["headers"]).content == image_bytes()
    finally:
        finish.set()
    task_id = second["turns"][0]["images"][0]["taskId"]
    for _ in range(500):
        if service.list_tasks(owner, [task_id])["items"][0]["status"] == "success":
            break
        time.sleep(.01)
    assert service.release_turn_reference(owner, reference["id"], second["turns"][0]["id"]) == {"retained": False}
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404


def test_failed_turn_save_rolls_back_reference_pin_without_consumption(environment, monkeypatch):
    from pathlib import Path
    env = environment
    reference = upload(env)
    replace = Path.replace
    def fail_save(source, target):
        if Path(target) == env["path"]:
            raise PermissionError("controlled turn snapshot failure")
        return replace(source, target)
    with monkeypatch.context() as failure:
        failure.setattr(Path, "replace", fail_save)
        assert submit(env, referenceImages=[{"id": reference["id"]}]).status_code == 507
    assert env["calls"] == []
    assert env["client"].delete(f'/api/image-references/{reference["id"]}', headers=env["headers"]).json() == {"retained": False}
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 404
