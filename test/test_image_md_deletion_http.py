"""MD upload reservations and completed-result deletion share the reference ledger."""
import time

from test.test_image_conversations_http import environment, wait_for_history
from test.test_image_imports_http import imports, reserve, upload
from test.test_image_import_preview_http import replace
from test.test_selected_md_generation_http import batch, document


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
