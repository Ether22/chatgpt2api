"""Final integrated MD/lineage/cleanup dates across real server timezone settings."""
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

import pytest

from api import image_tasks
from services.config import config
from services.image_task_service import ImageTaskService
from test.test_beijing_business_time import FrozenDateTime
from test.test_beijing_business_time_stage_b import server_timezone
from test.test_image_conversations_http import environment, submit, wait_for_history
from test.test_image_imports_http import imports, reserve, upload
from test.test_image_import_preview_http import replace
from test.test_selected_md_generation_http import batch, document


@pytest.mark.parametrize("zone", ["UTC0", "PST8", "CST-8"])
def test_midnight_md_upload_rerun_and_cleanup_keep_beijing_dates(imports, monkeypatch, zone):
    env = imports
    before = datetime(2026, 9, 7, 15, 59, 59, tzinfo=UTC)
    after = before + timedelta(seconds=2)
    restored = None
    with server_timezone(zone), patch("utils.business_time.datetime", FrozenDateTime), \
            patch.object(FrozenDateTime, "instant", before):
        try:
            state = replace(env, document())
            state = reserve(env, version=state["version"]).json()
            assert state["updated_at"] == "2026-09-07T23:59:59+08:00"
            accepted = batch(env, state, entries=[{"key": state["candidates"][1]["key"]}]).json()
            assert accepted["createdAt"] == accepted["turns"][0]["createdAt"] == "2026-09-07T23:59:59+08:00"
            FrozenDateTime.instant = after
            state = upload(env).json()
            assert state["updated_at"] == "2026-09-08T00:00:01+08:00"
            original = wait_for_history(env)["items"][0]["turns"][0]
            image = original["images"][0]
            assert image["status"] == "success"
            assert original["createdAt"] == "2026-09-07T23:59:59+08:00"
            assert image["updatedAt"] == "2026-09-08T00:00:01+08:00"
            assert "/2026/09/08/" in image["url"] and "/2026/09/08/" in original["referenceImages"][0]["url"]
            result = submit(env, request_id="midnight-rerun", conversation_id=accepted["id"],
                            source_turn_id=original["id"], rerun=True)
            assert result.status_code == 200, result.text
            turns = wait_for_history(env, 2)["items"][0]["turns"]
            assert turns[1]["createdAt"] == "2026-09-08T00:00:01+08:00"
            assert turns[1]["sourceEntryId"] == original["sourceEntryId"]
            navigation = env["client"].get(f'/api/image-conversations/{accepted["id"]}?navigation=true', headers=env["headers"]).json()
            assert [turn["createdAt"] for turn in navigation["turns"]] == [turn["createdAt"] for turn in turns]

            target = config.images_dir / urlsplit(image["url"]).path.removeprefix("/images/")
            unlink = Path.unlink

            def deny_result(path, *args, **kwargs):
                if path == target:
                    raise PermissionError("controlled midnight deletion failure")
                return unlink(path, *args, **kwargs)

            route = f'/api/image-conversations/{accepted["id"]}/turns/{original["id"]}/images/{image["id"]}'
            with patch.object(Path, "unlink", deny_result):
                deleted = env["client"].delete(route, headers=env["headers"])
                assert deleted.status_code == 200, deleted.text
                assert deleted.json()["updated_at"] == "2026-09-08T00:00:01+08:00"
                cleanup = env["client"].get("/api/image-cleanups", headers=env["headers"]).json()
                assert cleanup["stats"]["error"] == 1
                assert cleanup["items"][0]["updated_at"] == "2026-09-08T00:00:01+08:00"
            env["service"].shutdown()
            restored = ImageTaskService(env["path"], generation_handler=env["upstream"], edit_handler=env["upstream"])
            monkeypatch.setattr(image_tasks, "image_task_service", restored)
            FrozenDateTime.instant = after + timedelta(seconds=2)
            retry = env["client"].post(f'/api/image-cleanups/{image["id"]}/retry', headers=env["headers"])
            assert retry.status_code == 200, retry.text
            task = env["client"].get(f'/api/image-tasks?ids={image["id"]}', headers=env["headers"]).json()["items"][0]
            assert task["result_cleanup"]["state"] == "complete"
            assert task["result_cleanup"]["updated_at"] == "2026-09-08T00:00:03+08:00"
            assert not target.exists() and len(env["calls"]) == 2
        finally:
            (restored or env["service"]).shutdown()
