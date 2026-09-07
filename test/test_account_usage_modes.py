from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "ticket-15-test")

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.accounts as accounts_api
import api.support as support
import services.editable_file_task_service as editable_files
from services.account_service import AccountService
from services.config import config
from services.model_service import ModelCatalogService
from services.openai_backend_api import InvalidAccessTokenError
from services.protocol import conversation, openai_search, openai_v1_models, web_search_tool
from services.storage.json_storage import JSONStorageBackend
from test.test_account_export import make_jwt


class AccountUsageModeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.storage = JSONStorageBackend(self.directory / "accounts.json")
        self.service = AccountService(self.storage)
        self.service.add_account_items([
            {"access_token": "normal", "status": "正常", "quota": 3},
        ])
        self.addCleanup(patch.stopall)
        patch.object(accounts_api, "account_service", self.service).start()
        app = FastAPI()
        app.include_router(accounts_api.create_router())
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": f"Bearer {config.auth_key}"}

    def test_admin_saves_exclusive_usage_mode_and_it_survives_reload(self):
        for mode in ("monitor", "disabled", "normal"):
            response = self.client.post("/api/accounts/update", headers=self.headers,
                                        json={"access_token": "normal", "usage_mode": mode})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["item"]["usage_mode"], mode)
            self.assertEqual(AccountService(self.storage).get_account("normal")["usage_mode"], mode)
        invalid = self.client.post("/api/accounts/update", headers=self.headers,
                                   json={"access_token": "normal", "usage_mode": "monitor+disabled"})
        self.assertEqual(invalid.status_code, 422)
        denied = self.client.post("/api/accounts/update",
                                  json={"access_token": "normal", "usage_mode": "disabled"})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(self.service.get_account("normal")["usage_mode"], "normal")

    def test_only_normal_accounts_supply_image_and_text_requests(self):
        self.service.add_account_items([
            {"access_token": "monitor", "usage_mode": "monitor", "status": "正常", "quota": 11},
            {"access_token": "disabled", "usage_mode": "disabled", "status": "正常", "quota": 17},
        ])
        self.assertEqual({self.service.get_text_access_token() for _ in range(3)}, {"normal"})
        with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                   return_value={"status": "正常", "quota": 3}):
            for _ in range(3):
                token = self.service.get_available_access_token()
                self.service.release_image_slot(token)
                self.assertEqual(token, "normal")
        self.service.update_account("normal", {"usage_mode": "monitor"})
        self.assertEqual(self.service.get_text_access_token(), "")
        with self.assertRaisesRegex(RuntimeError, "no available image quota"):
            self.service.get_available_access_token()

    def test_available_models_drop_monitored_and_disabled_account_capabilities(self):
        self.service.update_account("normal", {"type": "Pro", "source_type": "codex"})

        class CatalogBackend:
            def __init__(self, access_token=""):
                self.token = access_token

            def list_models(self):
                return {"data": [{"id": "pro-only"}] if self.token else []}

            def close(self):
                pass

        catalog = ModelCatalogService(self.service, backend_factory=CatalogBackend)
        with patch.object(openai_v1_models, "account_service", self.service), \
             patch.object(openai_v1_models, "model_catalog_service", catalog):
            self.assertIn("pro-only", {m["id"] for m in openai_v1_models.list_models()["data"]})
            for mode in ("monitor", "disabled"):
                self.service.update_account("normal", {"usage_mode": mode})
                self.assertEqual(openai_v1_models.list_models()["data"], [])
                self.assertEqual(catalog.route_for_model("pro-only").account_types, frozenset())
            self.service.update_account("normal", {"usage_mode": "normal"})
            self.assertIn("pro-codex-gpt-image-2", {m["id"] for m in openai_v1_models.list_models()["data"]})

    def test_watcher_maintains_unhealthy_monitor_and_disabled_accounts_without_changing_mode(self):
        self.service.add_account_items([
            {"access_token": "monitor", "usage_mode": "monitor", "status": "禁用", "refresh_token": "rt-monitor", "created_at": "2000-01-01"},
            {"access_token": "disabled", "usage_mode": "disabled", "status": "异常", "refresh_token": "rt-disabled", "created_at": "2000-01-01"},
        ])
        seen = set()
        complete = Event()
        stop = Event()

        def user_info(backend):
            seen.add(backend.access_token)
            if seen == {"normal", "monitor", "disabled"}:
                complete.set()
                stop.set()
            return {"status": "正常", "quota": 7, "usage_mode": "normal"}

        def oauth_response(*args, **kwargs):
            token = kwargs["data"]["refresh_token"].removeprefix("rt-") + "-rotated"
            return SimpleNamespace(status_code=200, text="ok", json=lambda: {"access_token": token})

        with patch.object(support, "account_service", self.service), \
             patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", autospec=True, side_effect=user_info), \
             patch("curl_cffi.requests.Session.post", side_effect=oauth_response):
            worker = support.start_limited_account_watcher(stop)
            try:
                self.assertTrue(complete.wait(5), seen)
            finally:
                stop.set()
                worker.join(5)
            self.assertFalse(worker.is_alive())
            for mode in ("monitor", "disabled"):
                account = self.service.get_account(mode)
                self.assertEqual(account["usage_mode"], mode)
                self.assertEqual(account["status"], "正常")
                self.assertEqual(account["quota"], 7)
                self.assertEqual(account["access_token"], mode + "-rotated")
                self.assertEqual(AccountService(self.storage).get_account(mode + "-rotated")["usage_mode"], mode)

    def test_stats_and_refresh_progress_separate_monitor_quota_from_consumable_quota(self):
        self.service.add_account_items([
            {"access_token": "monitor", "usage_mode": "monitor", "status": "正常", "quota": 11},
            {"access_token": "monitor-limited", "usage_mode": "monitor", "status": "限流", "quota": 5},
            {"access_token": "disabled", "usage_mode": "disabled", "status": "正常", "quota": 17},
        ])
        stats = self.service.get_stats()
        self.assertEqual(stats["total_quota"], 3)
        self.assertEqual(stats["monitor_quota"], 16)
        self.assertEqual(stats["active"], 1)
        self.assertEqual(stats["disabled"], 1)
        self.service.init_refresh_progress("quota", 4)
        self.addCleanup(self.service.clean_refresh_progress, "quota")
        for token in self.service.list_tokens():
            self.service.update_refresh_progress("quota", token)
        progress = self.service.get_refresh_progress("quota")
        self.assertEqual(progress["total_quota"], 3)
        self.assertEqual(progress["monitor_quota"], 16)
        self.service.update_account("normal", {"usage_mode": "monitor"})
        self.assertFalse(self.service.account_health()["healthy"])

    def test_automatic_removal_settings_do_not_remove_maintained_accounts(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}):
            for mode in ("monitor", "disabled"):
                self.service.add_account_items([{"access_token": mode, "usage_mode": mode, "quota": 1}])
                with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", return_value={"status": "限流", "quota": 0}):
                    self.service.refresh_accounts([mode])
                self.assertIsNotNone(self.service.get_account(mode))
                with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", side_effect=InvalidAccessTokenError("invalid test token")):
                    self.service.refresh_accounts([mode], defer_invalid_removal=False)
                self.assertEqual(self.service.get_account(mode)["usage_mode"], mode)
                self.service.update_account(mode, {"status": "正常", "quota": 1})
                self.service.mark_image_result(mode, True)  # An already-started image may finish after a mode change.
                self.assertEqual(self.service.get_account(mode)["usage_mode"], mode)

    def test_search_and_editable_file_requests_only_consume_normal_accounts(self):
        self.service.update_account("normal", {"type": "Plus", "last_used_at": "2030-01-01"})
        self.service.add_account_items([
            {"access_token": mode, "usage_mode": mode, "type": "Pro", "quota": 9}
            for mode in ("monitor", "disabled")
        ])
        consumed = []

        def search(backend, query):
            consumed.append(backend.access_token)
            return {"text": "controlled search"}

        def export(backend, *args):
            consumed.append(backend.access_token)
            raise RuntimeError("controlled export reached")

        with patch.object(openai_search, "account_service", self.service), \
             patch.object(web_search_tool, "account_service", self.service), \
             patch.object(editable_files, "account_service", self.service), \
             patch("services.openai_backend_api.OpenAIBackendAPI.search", autospec=True, side_effect=search), \
             patch("services.openai_backend_api.OpenAIBackendAPI.export_ppt_zip", autospec=True, side_effect=export), \
             patch("services.openai_backend_api.OpenAIBackendAPI.export_psd_zip", autospec=True, side_effect=export):
            for _ in range(3):
                openai_search.handle({"prompt": "test"})
                web_search_tool.run_web_search("test")
            tasks = editable_files.EditableFileTaskService(self.directory / "tasks.json")
            identity = {"id": "test-owner"}
            for submit in (tasks.submit_ppt, tasks.submit_psd):
                task = submit(identity, prompt="test", base64_images=["test-image"])
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    item = tasks.list_tasks(identity, [task["id"]])["items"][0]
                    if item["status"] == "error":
                        break
                    time.sleep(0.01)
                self.assertEqual(item.get("error"), "controlled export reached")
            self.assertEqual(consumed, ["normal"] * 8)

    def test_mode_changed_during_token_refresh_takes_effect_before_allocation(self):
        token = make_jwt({"exp": 1})
        self.service.update_account("normal", {"usage_mode": "disabled"})
        self.service.add_account_items([{"access_token": token, "refresh_token": "test-refresh", "quota": 1}])

        def rotate(*args, **kwargs):
            self.service.update_account(token, {"usage_mode": "monitor"})
            return SimpleNamespace(status_code=200, text="ok", json=lambda: {"access_token": "rotated"})

        with patch("curl_cffi.requests.Session.post", side_effect=rotate):
            self.assertEqual(self.service.get_text_access_token(), "")

    def test_account_removed_during_token_refresh_is_not_allocated(self):
        token = make_jwt({"exp": 1})
        self.service.update_account("normal", {"usage_mode": "disabled"})
        self.service.add_account_items([{"access_token": token, "refresh_token": "test-refresh"}])

        def rotate(*args, **kwargs):
            self.service.delete_accounts([token])
            return SimpleNamespace(status_code=200, text="ok", json=lambda: {"access_token": "rotated"})

        with patch("curl_cffi.requests.Session.post", side_effect=rotate):
            self.assertEqual(self.service.get_text_access_token(), "")

    def test_text_retry_does_not_consume_an_account_changed_to_monitor_or_disabled(self):
        consumed = []

        def stream(backend, **kwargs):
            if backend.access_token.startswith("retry-") and not backend.access_token.endswith("-rotated"):
                raise RuntimeError("token_invalidated")
            consumed.append(backend.access_token)
            yield json.dumps({"message": {"author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["ok"]}}})

        with patch.object(conversation, "account_service", self.service), \
             patch("services.openai_backend_api.OpenAIBackendAPI.stream_conversation", autospec=True, side_effect=stream):
            for mode in ("monitor", "disabled"):
                token = "retry-" + mode
                self.service.add_account_items([{"access_token": token, "refresh_token": "rt-test"}])

                def rotate(*args, **kwargs):
                    self.service.update_account(token, {"usage_mode": mode})
                    return SimpleNamespace(status_code=200, text="ok", json=lambda: {"access_token": token + "-rotated"})

                with patch("curl_cffi.requests.Session.post", side_effect=rotate):
                    result = list(conversation.stream_text_deltas(SimpleNamespace(access_token=token), conversation.ConversationRequest(prompt="test")))
                self.assertEqual(result, ["ok"])
            self.assertEqual(consumed, ["normal", "normal"])


if __name__ == "__main__":
    unittest.main()
