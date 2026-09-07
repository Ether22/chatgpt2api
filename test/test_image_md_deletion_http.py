"""MD upload reservations and completed-result deletion share the reference ledger."""
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from test.test_image_conversations_http import environment, wait_for_history
from test.test_image_imports_http import imports, reserve, upload
from test.test_image_import_preview_http import replace
from test.test_selected_md_generation_http import batch, document
from test.test_image_scope_deletion import wait_cleanup
from test.image_storage_faults import deny_sqlite_commits


def test_deleting_ready_md_result_preserves_another_turn_waiting_for_upload(imports):
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    accepted = batch(env, state)
    assert accepted.status_code == 200
    conversation_id = accepted.json()["id"]
    deadline = time.monotonic() + 10
    while True:
        conversation = env["client"].get(f"/api/image-conversations/{conversation_id}", headers=env["headers"]).json()
        first, waiting = conversation["turns"]
        if first["images"][0]["status"] == "success" or time.monotonic() >= deadline:
            break
        time.sleep(.02)
    image = first["images"][0]
    assert image["status"] == "success" and waiting["images"][0]["status"] == "loading"
    route = f'/api/image-conversations/{conversation_id}/turns/{first["id"]}/images/{image["id"]}'
    assert env["client"].delete(route, headers=env["headers"]).status_code == 200
    assert env["client"].get(image["url"], headers=env["headers"]).status_code == 404
    assert len(env["calls"]) == 1
    assert upload(env).status_code == 200
    restored = wait_for_history(env, 1)["items"][0]
    assert restored["turns"][0]["images"] == []
    assert restored["turns"][1]["images"][0]["status"] == "success"
    assert len(env["calls"]) == 2


@pytest.mark.parametrize("stage", ["reserved", "pending", "failed", "ready"])
@pytest.mark.parametrize("scope", ["conversation", "all"])
def test_scope_deletion_preserves_current_md_upload_for_future_turns(imports, monkeypatch, stage, scope):
    from services.image_storage_service import image_storage_service

    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    selected = [{"key": state["candidates"][1]["key"]}]
    accepted = batch(env, state, entries=selected).json()
    entered, release = Event(), Event()
    real_save = image_storage_service.save

    def controlled_save(*args, **kwargs):
        if kwargs.get("reference"):
            if stage == "pending":
                entered.set()
                assert release.wait(10)
            elif stage == "failed":
                raise OSError("controlled MD reference upload failure")
        return real_save(*args, **kwargs)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = None
        try:
            if stage in {"pending", "failed"}:
                monkeypatch.setattr(image_storage_service, "save", controlled_save)
            if stage == "pending":
                future = pool.submit(upload, env)
                assert entered.wait(5)
            elif stage == "failed":
                assert upload(env).status_code == 507
            elif stage == "ready":
                assert upload(env).status_code == 200
                wait_for_history(env)
            before = len(env["calls"])
            route = "/api/image-conversations" + (f'/{accepted["id"]}' if scope == "conversation" else "")
            response = env["client"].delete(route, headers=env["headers"])
            assert response.status_code == 200, response.text
            assert wait_cleanup(env)["stats"]["error"] == 0
            release.set()
            monkeypatch.setattr(image_storage_service, "save", real_save)
            uploaded = future.result(5) if future else upload(env)
            assert uploaded.status_code == 200, uploaded.text
            state = uploaded.json()
            assert len(state["references"]) == 1
            assert batch(env, state, entries=selected, request_id="after-scope-deletion").status_code == 200
            turn = wait_for_history(env)["items"][0]["turns"][0]
            assert turn["images"][0]["status"] == "success"
            assert len(env["calls"]) == before + 1
            assert env["client"].get(turn["referenceImages"][0]["url"], headers=env["headers"]).status_code == 200
        finally:
            release.set()
            env["service"].shutdown()


def test_failed_batch_rollback_keeps_active_md_upload_and_original_turn(imports, monkeypatch):
    from services.image_storage_service import image_storage_service

    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    selected = [{"key": state["candidates"][1]["key"]}]
    assert batch(env, state, entries=selected).status_code == 200
    entered, release = Event(), Event()
    real_save = image_storage_service.save

    def controlled_save(*args, **kwargs):
        if kwargs.get("reference"):
            entered.set()
            assert release.wait(10)
        return real_save(*args, **kwargs)

    monkeypatch.setattr(image_storage_service, "save", controlled_save)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(upload, env)
        try:
            assert entered.wait(5)
            with monkeypatch.context() as fault:
                deny_sqlite_commits(fault, env["path"], "controlled concurrent batch commit failure")
                response = batch(env, state, entries=selected, request_id="failed-second-batch")
                assert response.status_code == 507, response.text
            release.set()
            assert future.result(5).status_code == 200
            assert wait_for_history(env)["items"][0]["turns"][0]["images"][0]["status"] == "success"
            assert batch(env, state, entries=selected, request_id="failed-second-batch").status_code == 200
            assert len(wait_for_history(env, 2)["items"][0]["turns"]) == 2
            assert len(env["calls"]) == 2
        finally:
            release.set()
            env["service"].shutdown()
