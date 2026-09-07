from __future__ import annotations

import json
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.accounts as accounts_api
from services.account_service import AccountService
from services.auth_service import AuthService
from services.config import ConfigStore, config
from services.openai_backend_api import InvalidAccessTokenError
from services import openai_backend_api
from services.protocol import conversation, openai_search, web_search_tool
from services.storage.json_storage import JSONStorageBackend
from utils.helper import UpstreamHTTPError


class AccountRetentionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.storage = JSONStorageBackend(self.directory / "accounts.json")
        self.service = AccountService(self.storage)
        self.service.add_account_items([{
            "access_token": "retained", "email": "test@example.invalid", "password": "fake-password",
            "refresh_token": "fake-refresh", "id_token": "fake-id", "type": "Plus", "status": "正常", "quota": 1,
            "usage_mode": "normal", "proxy": "", "hidden": False, "display_order": 17,
            "custom_metadata": {"label": "keep"},
        }])
        self.original = self.service.get_account("retained")
        patcher = patch.object(accounts_api, "account_service", self.service)
        patcher.start()
        self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(accounts_api.create_router())
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": f"Bearer {config.auth_key}"}
        network = patch("curl_cffi.requests.Session.request", side_effect=RuntimeError("controlled upstream unavailable"))
        network.start()
        self.addCleanup(network.stop)

    def test_legacy_delete_is_rejected_and_other_objects_can_still_be_deleted(self):
        response = self.client.request("DELETE", "/api/accounts", headers=self.headers,
                                       json={"tokens": ["retained"]})
        self.assertEqual(response.status_code, 405, response.text)
        self.assertIn("disabled", response.json()["detail"]["error"])
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.service.delete_accounts(["retained"])
        self.assertEqual(AccountService(self.storage).get_account("retained"), self.original)
        self.assertEqual(self.client.get("/api/accounts", headers=self.headers).json()["items"][0]["access_token"], "retained")

        auth = AuthService(self.storage)
        key, _ = auth.create_key(role="user", name="temporary")
        with patch.object(accounts_api, "auth_service", auth):
            deleted = self.client.delete(f"/api/auth/users/{key['id']}", headers=self.headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(AuthService(self.storage).list_keys(role="user"), [])
        self.assertEqual(AccountService(self.storage).get_account("retained"), self.original)

    def test_old_auto_remove_flags_cannot_delete_on_refresh_update_or_image_result(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}):
            for mode in ("normal", "monitor", "disabled"):
                self.service.update_account("retained", {"usage_mode": mode, "status": "正常", "quota": 1})
                with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                           return_value={"status": "限流", "quota": 0}):
                    self.service.refresh_accounts(["retained"])
                self.assert_retained(mode, "限流")
                # Hidden/display metadata maintenance uses the same update path.
                self.service.update_account("retained", {"custom_metadata": {"label": "keep"}})
                self.assert_retained(mode, "限流")
                self.service.update_account("retained", {"status": "正常", "quota": 1})
                self.service.mark_image_result("retained", True)
                self.assert_retained(mode, "限流")
                self.service.mark_image_result("retained", False)
                self.assert_retained(mode, "限流")
                with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                           side_effect=InvalidAccessTokenError("token invalidated")):
                    self.service.refresh_accounts(["retained"], defer_invalid_removal=False)
                self.assert_retained(mode, "异常")
                with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                           return_value={"status": "正常", "quota": 7}):
                    self.service.refresh_accounts(["retained"])
                self.assert_retained(mode, "正常")

    def assert_retained(self, mode, status):
        reloaded = AccountService(self.storage).get_account("retained")
        self.assertIsNotNone(reloaded)
        self.assertEqual(reloaded["usage_mode"], mode)
        self.assertEqual(reloaded["status"], status)
        for field in ("access_token", "email", "password", "refresh_token", "id_token", "type", "proxy", "created_at", "hidden", "display_order", "custom_metadata"):
            self.assertEqual(reloaded[field], self.original[field], field)

    def test_legacy_config_file_and_updates_do_not_advertise_deletion(self):
        legacy = {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}
        path = self.directory / "config.json"
        path.write_text(json.dumps(legacy), encoding="utf-8")
        store = ConfigStore(path)
        for public_config in (store.get(), store.update(legacy), ConfigStore(path).get()):
            self.assertTrue(legacy.keys().isdisjoint(public_config))

    def test_search_failures_update_only_known_health_and_keep_accounts(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}), \
             patch.object(openai_backend_api, "account_service", self.service), \
             patch.object(openai_search, "account_service", self.service), \
             patch.object(web_search_tool, "account_service", self.service):
            for search in (lambda: openai_search.handle({"prompt": "test"}),
                           lambda: web_search_tool.run_web_search("test")):
                for code, error, expected in ((401, "unauthorized", "异常"), (429, "rate limited", "限流"),
                                              (403, "token_invalidated", "异常"), (503, "unavailable", "正常")):
                    self.service.update_account("retained", {"status": "正常", "quota": 1, "restore_at": "2099-01-01T00:00:00+00:00"})
                    response = SimpleNamespace(status_code=code, text=error, headers={})
                    with patch("curl_cffi.requests.Session.post", return_value=response):
                        with self.assertRaises(UpstreamHTTPError):
                            search()
                    self.assert_retained("normal", expected)
                    self.assertEqual(self.service.get_account("retained")["restore_at"], "2099-01-01T00:00:00+00:00")
                with patch("curl_cffi.requests.Session.post", side_effect=RuntimeError("connection timeout")):
                    with self.assertRaisesRegex(RuntimeError, "connection timeout"):
                        search()
                self.assert_retained("normal", "正常")

    def test_failed_password_login_retains_every_usage_mode(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True}):
            for mode in ("normal", "monitor", "disabled"):
                for code, expected in (("invalid_credentials", "异常"), ("account_deactivated", "禁用"),
                                       ("connection_failure", "异常")):
                    self.service.update_account("retained", {"usage_mode": mode, "status": "正常", "quota": 1})
                    authorized = SimpleNamespace(status_code=200, text="ok", url="https://auth.openai.com/login")
                    refused = SimpleNamespace(status_code=403, text="error", json=lambda: {"error": {"code": code}})
                    with patch("curl_cffi.requests.Session.get", return_value=authorized,
                               side_effect=RuntimeError("controlled login failure") if code == "connection_failure" else None), \
                         patch("curl_cffi.requests.Session.post", return_value=refused):
                        progress_id = f"login-{mode}-{code}"
                        self.addCleanup(self.service.clean_relogin_progress, progress_id)
                        result = self.service.re_login_accounts(["retained"], progress_id)
                        self.assertEqual(result["relogined"], 1)
                        deadline = time.monotonic() + 5
                        while not self.service.get_relogin_progress(progress_id)["done"] and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertTrue(self.service.get_relogin_progress(progress_id)["done"])
                    self.assert_retained(mode, expected)

    def test_text_and_image_invalid_token_errors_retain_account_and_release_capacity(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True}), \
             patch.object(conversation, "account_service", self.service), \
             patch.object(openai_backend_api, "account_service", self.service), \
             patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", return_value={"status": "正常", "quota": 1}), \
             patch("services.openai_backend_api.OpenAIBackendAPI.stream_conversation", side_effect=RuntimeError("token_invalidated")):
            with self.assertRaisesRegex(RuntimeError, "token_invalidated"):
                list(conversation.stream_text_deltas(SimpleNamespace(access_token="retained"),
                                                     conversation.ConversationRequest(prompt="test")))
            self.assert_retained("normal", "异常")
            self.service.update_account("retained", {"status": "正常", "quota": 1})
            with self.assertRaisesRegex(conversation.ImageGenerationError, "no available image quota"):
                list(conversation.stream_image_outputs_with_pool(conversation.ConversationRequest(model="gpt-image-2", prompt="test")))
            self.assert_retained("normal", "异常")
            self.assertEqual(self.service.list_accounts()[0]["image_inflight"], 0)

    def test_search_polling_rate_limit_keeps_retrying_and_retains_account(self):
        polls = []

        def upstream(method, url, **kwargs):
            payload = {"conduit_token": "test-conduit", "token": "test-sentinel"}
            status = 200
            if url.endswith("/backend-api/conversation/test-search"):
                polls.append(url)
                if len(polls) == 1:
                    status = 429
                    payload = {"error": "rate limited"}
                else:
                    payload = {"mapping": {"answer": {"message": {
                        "author": {"role": "assistant"}, "content": {"parts": ["controlled result"]},
                        "metadata": {"status": "finished_successfully"},
                    }}}}
            return SimpleNamespace(status_code=status, text=json.dumps(payload), json=lambda: payload,
                                   headers={"Retry-After": "60"}, close=lambda: None,
                                   iter_lines=lambda: iter([b'data: {"conversation_id":"test-search"}', b'data: [DONE]']))

        started = time.time()
        with patch.dict(config.data, {"auto_remove_rate_limited_accounts": True}), \
             patch.object(openai_backend_api, "account_service", self.service), \
             patch("curl_cffi.requests.Session.request", side_effect=upstream):
            with openai_backend_api.OpenAIBackendAPI("retained") as backend:
                result = backend.search("test", timeout_secs=2, poll_interval_secs=0)
        self.assertEqual(result["answer"], "controlled result")
        self.assertEqual(len(polls), 2)
        self.assert_retained("normal", "限流")
        restore_at = datetime.fromisoformat(self.service.get_account("retained")["restore_at"]).timestamp()
        self.assertGreaterEqual(restore_at, started + 60)
        self.assertLessEqual(restore_at, time.time() + 60)

    def test_text_and_image_http_auth_and_rate_errors_update_health(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}), \
             patch.object(conversation, "account_service", self.service), \
             patch.object(openai_backend_api, "account_service", self.service), \
             patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", return_value={"status": "正常", "quota": 1}):
            for image in (False, True):
                for status, expected in ((401, "异常"), (429, "限流")):
                    with self.subTest(image=image, status=status):
                        self.service.update_account("retained", {"status": "正常", "quota": 1})
                        started = time.time()
                        error = UpstreamHTTPError("conversation", status, "unauthorized" if status == 401 else "rate limited", retry_after=90)
                        with patch("services.openai_backend_api.OpenAIBackendAPI.stream_conversation", side_effect=error):
                            with self.assertRaises((UpstreamHTTPError, conversation.ImageGenerationError)):
                                if image:
                                    list(conversation.stream_image_outputs_with_pool(conversation.ConversationRequest(model="gpt-image-2", prompt="test")))
                                else:
                                    list(conversation.stream_text_deltas(SimpleNamespace(access_token="retained"), conversation.ConversationRequest(prompt="test")))
                        self.assert_retained("normal", expected)
                        self.assertEqual(self.service.list_accounts()[0]["image_inflight"], 0)
                        if status == 429:
                            restore_at = datetime.fromisoformat(self.service.get_account("retained")["restore_at"]).timestamp()
                            self.assertGreaterEqual(restore_at, started + 90)
                            self.assertLessEqual(restore_at, time.time() + 90)


if __name__ == "__main__":
    unittest.main()
