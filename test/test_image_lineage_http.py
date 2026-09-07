"""Rerun/reuse through HTTP; real snapshots/storage and controlled upstream."""
import pytest
from test.test_image_conversations_http import environment, submit, wait_for_history
from test.test_image_imports_http import imports, reserve, upload
from test.test_image_import_preview_http import replace
from test.test_selected_md_generation_http import document, batch


def test_md_rerun_uses_original_snapshot_and_reuse_keeps_flat_lineage(imports):
    env = imports
    state = replace(env, document())
    first = batch(env, state, entries=[{"key": state["candidates"][0]["key"]}]).json()
    original = wait_for_history(env)["items"][0]["turns"][0]
    state = replace(env, document().replace("first prompt", "future prompt").replace("main.jpg", "future.png"),
                    request_id="future", version=state["version"])
    rerun = submit(env, request_id="rerun", conversation_id=first["id"], source_turn_id=original["id"],
                   rerun=True, prompt="must not replace snapshot", count=2)
    assert rerun.status_code == 200, rerun.text
    turns = wait_for_history(env, 3)["items"][0]["turns"]
    assert turns[1]["md"] == original["md"]
    assert turns[1]["prompt"] == "first prompt"
    assert turns[1]["size"] == "1200x800"
    assert turns[0] == original
    reused = submit(env, request_id="reuse", conversation_id=first["id"], source_turn_id=turns[1]["id"],
                    prompt="edited prompt", size="900x700")
    assert reused.status_code == 200, reused.text
    turns = wait_for_history(env, 4)["items"][0]["turns"]
    assert len({turn["sourceEntryId"] for turn in turns}) == 1
    assert turns[2]["md"]["output_name"] == "main.jpg"
    assert (turns[2]["prompt"], turns[2]["size"]) == ("edited prompt", "900x700")
    assert len(env["calls"]) == 4


def test_hidden_ordinary_reuse_is_flat_idempotent_and_isolated(environment):
    env = environment
    first = submit(env).json()
    original = wait_for_history(env)["items"][0]["turns"][0]
    assert env["client"].patch(f'/api/image-conversations/{first["id"]}', headers=env["headers"],
        json={"turns": [{"id": original["id"], "promptDeleted": True}]}).status_code == 200
    for number, source in enumerate([original["id"], None]):
        response = submit(env, request_id=f"reuse-{number}", conversation_id=first["id"],
                          source_turn_id=source or reused["id"], prompt=f"edited {number}")
        assert response.status_code == 200, response.text
        reused = wait_for_history(env, number + 2)["items"][0]["turns"][-1]
        assert reused["sourceEntryId"] == original["sourceEntryId"]
    replay = submit(env, request_id="reuse-1", conversation_id=first["id"], source_turn_id=reused["id"])
    assert replay.status_code == 200
    turns = wait_for_history(env, 3)["items"][0]["turns"]
    assert len(turns) == 3
    assert len(env["calls"]) == 3
    hidden = turns[0]
    assert hidden["promptDeleted"] and hidden["prompt"] == original["prompt"]
    new = env["client"].post("/api/image-conversations", headers=env["headers"], json={"request_id": "new"}).json()
    assert submit(env, request_id="cross-conversation", conversation_id=new["id"], source_turn_id=original["id"]).status_code == 404
    assert submit(env, request_id="implicit-source", source_turn_id=original["id"]).status_code == 400
    assert submit(env, request_id="mismatch", conversation_id=first["id"], source_turn_id=original["id"], source_entry_id="fake").status_code == 400
    assert env["client"].post("/api/image-conversations/turns", headers=env["other"], json={
        "request_id": "foreign", "prompt": "x", "conversation_id": first["id"], "source_turn_id": original["id"]}).status_code == 404
    independent = submit(env, request_id="independent", conversation_id=new["id"]).json()["turns"][0]
    assert independent["sourceEntryId"] != original["sourceEntryId"]
    wait_for_history(env, 4)


def test_pending_rerun_waits_for_exact_original_upload(imports):
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    first = batch(env, state, entries=[{"key": state["candidates"][1]["key"]}]).json()
    original = first["turns"][0]
    rerun = submit(env, request_id="pending-rerun", conversation_id=first["id"], source_turn_id=original["id"], rerun=True)
    assert rerun.status_code == 200, rerun.text
    assert rerun.json()["turns"][1]["referenceImages"] == original["referenceImages"]
    assert env["calls"] == []
    assert upload(env).status_code == 200
    turns = wait_for_history(env, 2)["items"][0]["turns"]
    assert all(turn["images"][0]["status"] == "success" for turn in turns)
    assert turns[0]["referenceImages"] == turns[1]["referenceImages"]
    assert len(env["calls"]) == 2


def test_cancelled_pending_snapshot_cannot_read_new_same_name_upload(imports):
    env = imports
    state = replace(env, document())
    state = reserve(env, version=state["version"]).json()
    first = batch(env, state, entries=[{"key": state["candidates"][1]["key"]}]).json()
    original = first["turns"][0]
    assert submit(env, request_id="rerun-before-clear", conversation_id=first["id"], source_turn_id=original["id"], rerun=True).status_code == 200
    cleared = env["client"].request("DELETE", "/api/image-imports", headers=env["headers"],
        json={"request_id": "clear", "version": state["version"]}).json()
    assert reserve(env, "replacement", version=cleared["version"]).status_code == 200
    assert upload(env, "replacement").status_code == 200
    turns = wait_for_history(env, 2)["items"][0]["turns"]
    assert all(turn["images"][0]["status"] == "error" for turn in turns)
    assert env["calls"] == []
    assert submit(env, request_id="rerun-after-clear", conversation_id=first["id"], source_turn_id=original["id"], rerun=True).status_code == 400


@pytest.mark.parametrize("count", [0, 101, -1, 1.5, True, "2", "1e2"])
def test_rerun_count_validation_prevents_consumption(environment, count):
    env = environment
    original = submit(env).json()
    wait_for_history(env)
    assert submit(env, request_id="invalid", conversation_id=original["id"], source_turn_id=original["turns"][0]["id"],
                  rerun=True, count=count).status_code == 422
    assert len(env["calls"]) == 1
