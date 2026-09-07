"""Bounded history and gallery reads through real HTTP and temporary storage."""
import json
import time

from test.test_image_conversations_http import environment, submit, image_bytes, wait_for_history
from services.image_storage_service import image_storage_service
from services.image_tags_service import set_tags


def test_history_metadata_and_target_page_are_bounded_and_owner_scoped(environment):
    env = environment
    client, headers = env["client"], env["headers"]
    for index in range(7):
        response = submit(env, request_id=f"page-{index}", prompt=f"Round {index}")
        assert response.status_code == 200, response.text
    conversation_id = response.json()["id"]
    listing = client.get("/api/image-conversations?limit=1", headers=headers).json()
    assert listing["items"][0]["turns"] == []
    assert listing["items"][0]["turnCount"] == 7
    assert listing["pagination"]["total"] == 1
    url = f"/api/image-conversations/{conversation_id}"
    latest = client.get(url + "?limit=2", headers=headers).json()
    assert [turn["prompt"] for turn in latest["turns"]] == ["Round 6"]
    assert latest["pagination"] == {"offset": 6, "limit": 2, "total": 7, "next_offset": None, "previous_offset": 4}
    first = client.get(url + "?limit=2&offset=0", headers=headers).json()
    assert [turn["prompt"] for turn in first["turns"]] == ["Round 0", "Round 1"]
    target_id = first["turns"][1]["images"][0]["id"]
    located = client.get(url + f"?limit=2&image_id={target_id}", headers=headers).json()
    assert located["pagination"]["offset"] == 0
    assert located["target"] == {"turn_id": first["turns"][1]["id"], "image_id": target_id}
    navigation = client.get(url + "?navigation=true&limit=2&offset=0", headers=headers).json()
    assert len(navigation["turns"]) == 2
    assert len(navigation["sourceEntries"]) == 2
    assert "prompt" not in navigation["turns"][0]
    assert "referenceImages" not in navigation["turns"][0]
    assert "url" not in navigation["turns"][0]["images"][0]
    assert navigation["turns"][1]["images"][0]["id"] == target_id
    assert client.get(url + f"?image_id={target_id}", headers=env["other"]).status_code == 404
    assert client.get(url + "?image_id=missing", headers=headers).status_code == 404
    for query in ("limit=0", "limit=11", "offset=-1"):
        assert client.get(url + "?" + query, headers=headers).status_code == 422
    # Let controlled upstream threads finish before fixture storage disappears.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        page = client.get(url + "?limit=10&offset=0", headers=headers).json()
        if all(turn["status"] == "success" for turn in page["turns"]):
            break
        time.sleep(.02)
    assert all(turn["status"] == "success" for turn in page["turns"])


def test_gallery_paginates_after_identity_and_tag_filtering(environment):
    env = environment
    with image_storage_service.owner_scope(env["owner"]["id"]):
        images = [image_storage_service.save(image_bytes()) for _ in range(5)]
    with image_storage_service.owner_scope("someone-else"):
        image_storage_service.save(image_bytes())
    for image in images[1:4]:
        set_tags(image.rel, ["pick"])
    first = env["client"].get("/api/images?limit=2&tag=pick", headers=env["headers"]).json()
    assert len(first["items"]) == 2
    assert first["pagination"]["total"] == 3
    second = env["client"].get("/api/images?limit=2&offset=2&tag=pick", headers=env["headers"]).json()
    assert len(second["items"]) == 1
    assert second["pagination"]["next_offset"] is None
    assert {item["rel"] for item in first["items"] + second["items"]} == {image.rel for image in images[1:4]}
    assert env["client"].get("/api/images?limit=2", headers=env["other"]).json()["items"] == []
    assert env["client"].get("/api/images?limit=101", headers=env["headers"]).status_code == 422
    paths = env["client"].get("/api/images?limit=2&tag=pick&paths_only=true", headers=env["headers"]).json()
    assert all(set(item) == {"rel"} for item in paths["items"])
    assert paths["pagination"]["total"] == 3
    # Persisted reference metadata from ticket 04 must never become a gallery result.
    index = json.loads(image_storage_service.index_file.read_text())
    index["items"][images[1].rel]["kind"] = "reference"
    old = index["items"].pop(images[2].rel)
    reference_rel = images[2].rel.replace("/2026/", "/references/2026/")
    index["items"][reference_rel] = {**old, "rel": reference_rel, "path": reference_rel}
    image_storage_service.index_file.write_text(json.dumps(index))
    remaining = env["client"].get("/api/images?tag=pick", headers=env["headers"]).json()
    assert [item["rel"] for item in remaining["items"]] == [images[3].rel]


def test_conversation_list_continues_without_expanding_turns(environment):
    env = environment
    client, headers = env["client"], env["headers"]
    ids = {client.post("/api/image-conversations", headers=headers, json={"request_id": f"draft-{index}"}).json()["id"]
           for index in range(4)}
    seen = set()
    offset = 0
    while offset is not None:
        response = client.get(f"/api/image-conversations?offset={offset}&limit=2", headers=headers)
        assert response.status_code == 200
        page = response.json()
        assert len(page["items"]) == 2
        assert not seen.intersection(item["id"] for item in page["items"])
        seen.update(item["id"] for item in page["items"])
        offset = page["pagination"]["next_offset"]
    assert seen == ids


def test_navigation_and_image_targets_follow_saved_visibility(environment):
    env = environment
    assert submit(env).status_code == 200
    conversation = wait_for_history(env)["items"][0]
    turn = conversation["turns"][0]
    image_id = turn["images"][0]["id"]
    url = f"/api/image-conversations/{conversation['id']}"
    client, headers = env["client"], env["headers"]
    assert client.patch(url, headers=headers, json={"turns": [{"id": turn["id"], "resultsDeleted": True}]}).status_code == 200
    navigation = client.get(url + "?navigation=true", headers=headers).json()
    assert navigation["turns"][0]["images"] == []
    assert navigation["turns"][0]["resultsDeleted"] is True
    assert client.get(url + f"?image_id={image_id}", headers=headers).status_code == 404
    assert client.get(url + f"?turn_id={turn['id']}", headers=headers).status_code == 200
    assert client.patch(url, headers=headers, json={"turns": [{"id": turn["id"], "resultsDeleted": False, "promptDeleted": True}]}).status_code == 200
    assert client.get(url + f"?image_id={image_id}", headers=headers).status_code == 200
    assert len(client.get(url + "?navigation=true", headers=headers).json()["turns"][0]["images"]) == 1
    assert client.patch(url, headers=headers, json={"turns": [{"id": turn["id"], "resultsDeleted": True}]}).status_code == 200
    assert client.get(url + "?navigation=true", headers=headers).json()["turns"] == []
    assert client.get(url + f"?turn_id={turn['id']}", headers=headers).status_code == 404
