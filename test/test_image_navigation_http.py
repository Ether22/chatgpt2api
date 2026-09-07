"""Navigation keeps source attempt numbers across pages and deletion."""
from test.test_image_conversations_http import environment, submit, wait_for_history


def test_navigation_attempt_numbers_survive_interleaving_and_deleted_rounds(environment):
    env = environment
    first = submit(env, prompt="Ordinary title " + "x" * 100).json()
    cid, original = first["id"], first["turns"][0]
    submit(env, request_id="other", conversation_id=cid, prompt="Other source")
    for number in (2, 3):
        submit(env, request_id=f"reuse-{number}", conversation_id=cid,
               source_turn_id=original["id"], prompt=f"changed {number}")
    wait_for_history(env, 4)
    client, headers = env["client"], env["headers"]
    url = f"/api/image-conversations/{cid}"
    rounds = client.get(url + "?offset=0&limit=10", headers=headers).json()["turns"]
    assert client.patch(url, headers=headers, json={"turns": [{"id": rounds[2]["id"],
        "promptDeleted": True, "resultsDeleted": True}]}).status_code == 200
    early = client.get(url + "?navigation=true&offset=0&limit=2", headers=headers).json()
    late = client.get(url + "?navigation=true&offset=2&limit=2", headers=headers).json()
    assert [t["sourceOrdinal"] for t in early["turns"]] == [1, 1]
    assert [(t["id"], t["sourceOrdinal"]) for t in late["turns"]] == [(rounds[3]["id"], 3)]
    assert late["sourceEntries"][0]["name"] == "Ordinary title xxxxxxxxx"
    for turn in early["turns"] + late["turns"]:
        assert not {"prompt", "referenceImages", "md"}.intersection(turn)
        assert all(not {"url", "b64_json", "errorDetail"}.intersection(image) for image in turn["images"])
    target = client.get(url + f'?turn_id={rounds[3]["id"]}&image_id={rounds[3]["images"][0]["id"]}', headers=headers).json()
    assert target["pagination"]["offset"] == 2
    assert client.get(url + "?navigation=true", headers=env["other"]).status_code == 404
