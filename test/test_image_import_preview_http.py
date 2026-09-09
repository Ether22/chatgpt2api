"""MD candidates are observed through imports HTTP with real temporary storage."""
from pathlib import Path
import pytest
from test.test_image_imports_http import imports, reserve, upload
from test.test_image_conversations_http import environment


def replace(env, content, request_id="md", version=0):
    response = env["client"].put("/api/image-imports/md", headers=env["headers"],
        data={"request_id": request_id, "version": version},
        files={"file": ("tasks.md", content.encode(), "text/markdown")})
    assert response.status_code == 200, response.text
    return response.json()


def test_real_documents_are_structural_candidates_with_exact_prompt_and_reference_order(imports):
    fixtures = Path(__file__).parent / "fixtures" / "image-imports"
    state = replace(imports, (fixtures / "fairness-cup.md").read_text(encoding="utf-8"))
    candidates = state["candidates"]
    assert len(candidates) == 19
    first = candidates[0]
    assert first["config"]["document_id"] == "P01"
    assert first["config"]["name"] == "主图"
    assert first["config"]["size"] == "1600x1600"
    assert first["config"]["output_name"] is None
    assert first["config"]["reference_names"] == [
        "O1CN01w9s44j20SR23dJsMi_!!2924426848-0-cib.gif",
        "O1CN01d3hcjP20SR1wM0deN_!!2924426848-0-cib.gif",
        "O1CN01N8mZJu20SR1wM0lyw_!!2924426848-0-cib.gif"]
    assert first["config"]["prompt"].startswith("Create a premium Amazon Japan main product image")
    assert "唯一参考目录" not in first["config"]["prompt"]
    assert {error["code"] for candidate in candidates for error in candidate["errors"]} == {"missing_file"}
    assert candidates[7]["config"]["size"] == "1464x600"
    assert candidates[13]["config"]["size"] == "1500x1125"
    state = replace(imports, (fixtures / "food-containers.md").read_text(encoding="utf-8"), "md-two", state["version"])
    assert len(state["candidates"]) == 19
    first = state["candidates"][0]["config"]
    assert first["reference_names"] == ["codex-clipboard-b8105061-5dd7-4492-9b23-0eabb6d76ae9.png", "1 (17).jpg", "1 (28).jpg"]
    assert first["output_name"] == "1.jpg"
    assert first["prompt"].startswith("Reference-angle discipline:")
    assert {error["code"] for candidate in state["candidates"] for error in candidate["errors"]} == {"missing_file"}
    assert imports["calls"] == []


def correct(env, state, candidate, changes, request_id="correct"):
    return env["client"].patch(f"/api/image-imports/candidates/{candidate['key']}", headers=env["headers"],
        json={"request_id": request_id, "version": state["version"], "md_version": state["md_version"], "changes": changes})


def test_model_refresh_is_admin_only_and_removed_history_migration_is_unavailable(environment, monkeypatch):
    from api import ai, support
    calls = []
    monkeypatch.setattr(ai.openai_v1_models, "list_models", lambda force_refresh=False: calls.append(force_refresh) or {"data": []})
    environment["app"].include_router(ai.create_router())
    _, key = support.auth_service.create_key(role="user", name="Model reader")
    headers = {"Authorization": f"Bearer {key}"}
    client = environment["client"]
    assert client.get("/v1/models", headers=headers).status_code == 200
    assert client.get("/v1/models?refresh=true", headers=headers).status_code == 403
    assert client.get("/v1/models?refresh=true", headers=environment["headers"]).status_code == 200
    assert calls == [False, True]
    assert client.post("/api/image-history/migrate", headers=environment["headers"], json={}).status_code == 404


def test_corrections_survive_reference_progress_reload_but_not_md_replacement(imports, tmp_path, monkeypatch):
    from api import image_imports
    from services.image_import_service import ImageImportService, ImportConflict
    env = imports
    state = replace(env, "## [P01] 主图\n### Prompt\n~~~text\nPaint 无需生成 literally.\n~~~")
    candidate = state["candidates"][0]
    assert {e["code"] for e in candidate["errors"]} == {"invalid_size", "missing_declaration"}
    response = correct(env, state, candidate, {"size": "1600x1600", "reference_names": ["first.png"]})
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["candidates"][0]["errors"][0]["code"] == "missing_file"
    assert correct(env, state, candidate, {"size": "1x1"}).status_code == 409  # reused request identity
    assert reserve(env, version=state["version"]).status_code == 200
    state = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    assert state["candidates"][0]["status"] == "pending"
    keys = [candidate["key"]]
    service = image_imports.image_import_service
    with pytest.raises(ValueError):
        service.validated_candidates(env["owner"], state["version"], state["md_version"], keys)
    snapshot = service.validated_candidates(env["owner"], state["version"], state["md_version"], keys, allow_pending=True)
    assert snapshot["candidates"][0]["matches"][0]["upload_id"] == "ref-one"
    prior_version = state["version"]
    state = upload(env).json()
    assert state["version"] == prior_version
    assert state["candidates"][0]["status"] == "ready"
    assert state["candidates"][0]["config"]["size"] == "1600x1600"
    reference = state["candidates"][0]["matches"][0]["reference"]
    assert env["client"].get(reference["url"], headers=env["headers"]).status_code == 200
    service = ImageImportService(tmp_path / "imports", env["service"])
    monkeypatch.setattr(image_imports, "image_import_service", service)
    restored = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    assert restored == state
    assert env["client"].get("/api/image-imports", headers=env["other"]).json()["candidates"] == []
    skipped = correct(env, state, candidate, {"skipped": True}, "skip").json()
    with pytest.raises(ValueError):
        service.validated_candidates(env["owner"], skipped["version"], skipped["md_version"], keys)
    replaced = replace(env, "## [P01] 新文档\n参考图：无\n### Prompt\n```\nnew\n```", "new-md", skipped["version"])
    assert replaced["candidates"][0]["skipped"] is False
    assert replaced["candidates"][0]["config"]["size"] == ""
    assert replaced["candidates"][0]["key"] != candidate["key"]
    assert correct(env, replaced, candidate, {"size": "1x1"}, "stale-key").status_code == 404
    with pytest.raises(ImportConflict):
        service.validated_candidates(env["owner"], replaced["version"], state["md_version"], keys)
    assert env["calls"] == []


def test_identifier_families_double_main_and_controls_are_scoped_outside_prompt(imports):
    identities = ["MAIN", "MAIN02", "SUB", "SUB03", "A-D", "A-D09", "A-M", "A-M27", "P01", "D01", "M01", "P01-A", "P01-B"]
    content = "# Global\nDo not prepend this to prompts.\n"
    for index, identity in enumerate(identities):
        fence = "~~~" if index % 2 else "```"
        label = f"[{identity}]" if index % 2 else identity
        content += f"## {label} 名称｜1200×800 px\n参考图：无\n### Prompt\n{fence}text\n无需生成 is literal prompt text.\n## [INNER] is also literal.\n{fence}\n"
    content += "## [PASS] 无需生成\n参考图：无\n## [PASS2] 原图\n生成方式：直通\n"
    state = replace(imports, content)
    candidates = state["candidates"]
    assert [c["config"]["document_id"] for c in candidates] == identities
    assert all(c["status"] == "ready" for c in candidates)
    assert all(c["config"]["prompt"] == "无需生成 is literal prompt text.\n## [INNER] is also literal." for c in candidates)
    assert all(c["config"]["reference_names"] == [] for c in candidates)


def test_conflicting_fields_duplicate_ids_and_missing_fields_can_be_corrected_individually(imports):
    content = """## [P01-A] Main｜`one.jpg`｜1600×1600
尺寸：1200x800
输出文件名：two.jpg
参考图：无
参考图：one.png
### Prompt
```text
first
```
### Prompt
~~~text
second
~~~
## [P01-A] Other
参考图：
## [SUB99] Third
"""
    state = replace(imports, content)
    first, second, third = state["candidates"]
    assert len({c["key"] for c in state["candidates"]}) == 3
    assert {e["field"] for e in first["errors"] if e["code"] == "conflicting_field"} == {"size", "output_name", "reference_names", "prompt"}
    assert any(e["code"] == "duplicate_id" for e in first["errors"])
    assert any(e["code"] == "duplicate_id" for e in second["errors"])
    assert {e["code"] for e in third["errors"]} == {"invalid_size", "missing_prompt", "missing_declaration"}
    state = correct(imports, state, first, {"document_id": "P01-B", "size": "1600×1600", "output_name": None,
                                          "prompt": "corrected", "reference_names": []}).json()
    assert state["candidates"][0]["status"] == "ready"
    assert state["candidates"][1]["config"] == second["config"]
    assert not any(e["code"] == "duplicate_id" for e in state["candidates"][1]["errors"])
    state = correct(imports, state, third, {"skipped": True}, "skip-invalid").json()
    assert state["candidates"][2]["status"] == "error"
    assert state["candidates"][2]["skipped"] is True


def test_ordered_nested_and_inline_reference_lists_are_exact_and_per_row_ready(imports):
    env = imports
    content = """## MAIN-A Main｜640x480
参考图：
  1. `Second (2).png`
  2. first.png
### Prompt
```
first
```
## MAIN-B Second｜640x480
参考图：1、`first.png`；2、`Second (2).png`
### Prompt
~~~
second
~~~
## SUB01 Third｜640x480
参考图：first.png
### Prompt
~~~
third
~~~
"""
    state = replace(env, content)
    assert state["candidates"][0]["config"]["reference_names"] == ["Second (2).png", "first.png"]
    assert state["candidates"][1]["config"]["reference_names"] == ["first.png", "Second (2).png"]
    state = reserve(env, version=state["version"]).json()
    state = upload(env).json()
    assert [c["status"] for c in state["candidates"]] == ["error", "error", "ready"]
    assert reserve(env, "case-sensitive", "second (2).png", state["version"]).status_code == 200
    state = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    assert state["candidates"][0]["errors"][0]["message"] == "缺少参考图：Second (2).png"
    state = reserve(env, "second", "Second (2).png", state["version"]).json()
    assert [c["status"] for c in state["candidates"]] == ["pending", "pending", "ready"]
    assert reserve(env, "duplicate", "Second (2).png", state["version"]).status_code == 409
    state = upload(env, "second", "Second (2).png").json()
    assert [m["upload_id"] for m in state["candidates"][0]["matches"]] == ["second", "ref-one"]
    assert all(c["status"] == "ready" for c in state["candidates"])


@pytest.mark.parametrize("changes", [{"status": "ready"}, {"prompt": None}, {"size": 123}, {"skipped": "true"}, {"reference_names": [1]}, {"reference_names": [""]}])
def test_invalid_correction_dto_cannot_bypass_server_validation(imports, changes):
    state = replace(imports, "## [P01] First")
    assert correct(imports, state, state["candidates"][0], changes).status_code == 400


def test_empty_list_is_not_explicit_no_references_and_unclosed_prompt_is_an_error(imports):
    state = replace(imports, "## [MAIN] First｜640x480\n参考图：1、\n### Prompt\n```text\nactual prompt")
    candidate = state["candidates"][0]
    assert candidate["config"]["reference_names"] is None
    assert {e["code"] for e in candidate["errors"]} == {"empty_declaration", "missing_declaration", "unclosed_prompt"}


def test_preview_correction_is_atomic_retryable_and_rejects_cross_identity(imports, tmp_path, monkeypatch):
    env = imports
    state = replace(env, "## [MAIN] First｜640x480\n参考图：无\n### Prompt\n```text\nactual prompt\n```")
    candidate = state["candidates"][0]
    original_replace = Path.replace
    def fail_metadata(path, target):
        if Path(target).parent == tmp_path / "imports":
            raise OSError("controlled preview metadata failure")
        return original_replace(path, target)
    with monkeypatch.context() as fault:
        fault.setattr(Path, "replace", fail_metadata)
        assert correct(env, state, candidate, {"prompt": "updated"}).status_code == 507
    assert env["client"].get("/api/image-imports", headers=env["headers"]).json() == state
    corrected = correct(env, state, candidate, {"prompt": "updated"}).json()
    assert corrected["candidates"][0]["config"]["prompt"] == "updated"
    assert correct(env, state, candidate, {"prompt": "updated"}).json() == corrected
    assert correct(env, state, candidate, {"name": "stale"}, "stale").status_code == 409
    response = env["client"].patch(f"/api/image-imports/candidates/{candidate['key']}", headers=env["other"],
        json={"request_id": "other", "version": 0, "md_version": 0, "changes": {"prompt": "attacker"}})
    assert response.status_code == 404
    assert env["client"].get("/api/image-imports", headers=env["headers"]).json() == corrected


def test_repeated_corrections_keep_only_current_prompt_not_prompt_history_in_receipts(imports, tmp_path, monkeypatch):
    from api import image_imports
    from services.image_import_service import ImageImportService
    env = imports
    state = replace(env, "## [MAIN] First｜640x480\n参考图：无\n### Prompt\n```text\noriginal document prompt\n```")
    candidate = state["candidates"][0]
    previous = "only present in the first correction; must not become history"
    first = correct(env, state, candidate, {"prompt": previous, "name": "corrected name"}).json()
    assert correct(env, state, candidate, {"name": "corrected name", "prompt": previous}).json() == first
    latest = correct(env, first, candidate, {"prompt": "latest correction"}, "second-correction").json()
    monkeypatch.setattr(image_imports, "image_import_service", ImageImportService(tmp_path / "imports", env["service"]))
    restored = env["client"].get("/api/image-imports", headers=env["headers"]).json()
    assert restored == latest
    assert restored["candidates"][0]["config"]["prompt"] == "latest correction"
    assert "original document prompt" in restored["md"]["content"]
    assert previous not in next((tmp_path / "imports").glob("*.json")).read_text(encoding="utf-8")
    assert correct(env, state, candidate, {"prompt": "different"}).status_code == 409


@pytest.mark.parametrize("dimension", ["-1600x800", "1600.5x800", "1600x800.5", "1e3x800"])
def test_invalid_dimension_is_not_silently_truncated_to_a_valid_size(imports, dimension):
    state = replace(imports, f"## [MAIN] First｜{dimension}\n参考图：无\n### Prompt\n```text\nactual prompt\n```")
    candidate = state["candidates"][0]
    assert candidate["status"] == "error"
    assert any(e["code"] == "invalid_size" for e in candidate["errors"])


def test_numeric_filenames_are_not_list_markers_or_rewritten_before_matching(imports):
    env = imports
    state = replace(env, """## MAIN First｜640x480
参考图：1.png、image 1.png、`Second, (2).png`
### Prompt
```
actual prompt
```
## SUB01 Second｜640x480
参考图：
  1. 1.png
  2. image 1.png
  3. `Second, (2).png`
### Prompt
~~~
actual prompt
~~~
""")
    expected = ["1.png", "image 1.png", "Second, (2).png"]
    assert all(c["config"]["reference_names"] == expected for c in state["candidates"])
    for index, name in enumerate(expected):
        state = reserve(env, f"numeric-{index}", name, state["version"]).json()
        state = upload(env, f"numeric-{index}", name).json()
    assert all(c["status"] == "ready" for c in state["candidates"])
    assert all([m["upload_id"] for m in c["matches"]] == ["numeric-0", "numeric-1", "numeric-2"] for c in state["candidates"])
