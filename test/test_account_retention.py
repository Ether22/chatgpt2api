from __future__ import annotations

import json
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from threading import Event

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

    def test_manual_delete_requires_admin_and_removes_selected_in_any_usage_mode(self):
        self.service.add_account_items([{"access_token": "monitor", "usage_mode": "monitor"}, {"access_token": "disabled", "usage_mode": "disabled"}])
        auth = AuthService(self.storage)
        _, user_key = auth.create_key(role="user", name="temporary")
        with patch("api.support.auth_service", auth):
            denied = self.client.request("DELETE", "/api/accounts", headers={"Authorization": f"Bearer {user_key}"}, json={"tokens": ["retained"]})
        self.assertEqual(denied.status_code, 403, denied.text)
        self.assertIsNotNone(self.service.get_account("retained"))
        self.assertEqual(self.client.request("DELETE", "/api/accounts", headers=self.headers, json={"tokens": []}).status_code, 400)
        response = self.client.request("DELETE", "/api/accounts", headers=self.headers,
                                       json={"tokens": ["retained", "monitor", "disabled", "retained"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["removed"], 3)
        self.assertEqual(AccountService(self.storage).list_accounts(), [])

    def test_automatic_deletion_guards_and_persistence_rollback(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}):
            for mode in ("monitor", "disabled"):
                self.service.update_account("retained", {"usage_mode": mode})
                self.service.remove_invalid_token("retained", "test")
                self.assertIsNotNone(self.service.get_account("retained"))
                self.service.mark_rate_limited("retained")
                self.assertIsNotNone(self.service.get_account("retained"))
            self.service.update_account("retained", {"usage_mode": "normal", "status": "正常", "quota": 1})
            self.service.remove_invalid_token("retained", "temporary", confirmed=False)
            self.assertIsNotNone(self.service.get_account("retained"))
            self.service._token_aliases.update({"old": "older", "older": "retained"})
            self.service._image_inflight["retained"] = 1
            with patch.object(self.storage, "save_accounts", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    self.service.remove_invalid_token("old", "confirmed")
            self.assertIsNotNone(self.service.get_account("old"))
            self.assertEqual(self.service._image_inflight["retained"], 1)
            self.service.remove_invalid_token("old", "confirmed")
            self.assertIsNone(AccountService(self.storage).get_account("retained"))
            self.assertEqual(self.service._token_aliases, {})
            self.assertEqual(self.service._image_inflight, {})
            for trigger in (lambda: self.service.mark_rate_limited("retained"), lambda: self.service.mark_image_result("retained", True)):
                self.service.add_account_items([self.original])
                trigger()
                self.assertIsNone(AccountService(self.storage).get_account("retained"))

    def test_disabled_auto_remove_flags_keep_accounts_on_refresh_update_or_image_result(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": False, "auto_remove_rate_limited_accounts": False}):
            for mode in ("normal", "monitor", "disabled"):
                self.service.update_account("retained", {"usage_mode": mode, "status": "正常", "quota": 1})
                self.original["display_order"] = self.service.get_account("retained")["display_order"]
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
        for field in ("access_token", "email", "password", "refresh_token", "id_token", "type", "proxy", "created_at", "display_order", "custom_metadata"):
            self.assertEqual(reloaded[field], self.original[field], field)

    def test_legacy_config_values_are_preserved(self):
        legacy = {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}
        path = self.directory / "config.json"
        path.write_text(json.dumps(legacy), encoding="utf-8")
        store = ConfigStore(path)
        for public_config in (store.get(), store.update(legacy), ConfigStore(path).get()):
            self.assertEqual({key: public_config[key] for key in legacy}, legacy)
        self.assertFalse(ConfigStore(self.directory / "missing.json").auto_remove_invalid_accounts)

    def test_search_failures_update_only_known_health_and_keep_accounts(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": False, "auto_remove_rate_limited_accounts": False}), \
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
                    self.assertEqual(datetime.fromisoformat(self.service.get_account("retained")["restore_at"]), datetime.fromisoformat("2099-01-01T00:00:00+00:00"))
                with patch("curl_cffi.requests.Session.post", side_effect=RuntimeError("connection timeout")):
                    with self.assertRaisesRegex(RuntimeError, "connection timeout"):
                        search()
                self.assert_retained("normal", "正常")

    def test_failed_password_login_retains_every_usage_mode(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True}):
            for mode in ("normal", "monitor", "disabled"):
                for code, expected in (("invalid_credentials", "异常"), ("account_deactivated", "异常"),
                                       ("connection_failure", "异常")):
                    self.service.update_account("retained", {"usage_mode": mode, "status": "正常", "quota": 1})
                    self.original["display_order"] = self.service.get_account("retained")["display_order"]
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

    def test_legacy_upstream_disabled_accounts_join_abnormal_without_deletion(self):
        self.storage.save_accounts([
            {**self.original, "access_token": mode, "usage_mode": mode, "status": "禁用", "quota": 99}
            for mode in ("normal", "monitor", "disabled")
        ])
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True}):
            service = AccountService(self.storage)
            accounts = service.list_accounts()
            self.assertEqual(len(accounts), 3)
            for account in accounts:
                self.assertEqual(account["status"], "异常")
                self.assertEqual(account["quota"], 0)
                self.assertEqual(account["usage_mode"], account["access_token"])
                self.assertFalse(service.is_text_account_available(account))
                self.assertFalse(service._is_image_account_available(account))
            self.assertEqual(service.get_stats()["abnormal"], 3)
            self.assertNotIn("upstream_disabled", service.get_stats())
            service.update_account("normal", {"proxy": ""})
            self.assertEqual([item["status"] for item in AccountService(self.storage).list_accounts()], ["异常"] * 3)

    def test_auto_relogin_progress_waits_for_actual_account_completion(self):
        started, release = Event(), Event()
        def login(token, email, password, event, progress_id):
            started.set()
            release.wait(5)
            self.service.update_account(token, {"status": "正常", "quota": 8})
            self.service.update_relogin_progress(progress_id, token, "正常")
        self.service.update_account("retained", {"status": "异常", "quota": 0})
        try:
            with patch.dict(config.data, {"auto_relogin_after_refresh": True}), \
                 patch.object(self.service, "fetch_remote_info", return_value=self.service.get_account("retained")), \
                 patch.object(self.service, "_password_re_login_thread", side_effect=login):
                result = self.service.refresh_accounts(["retained"])
                progress_id = result["relogin_progress_id"]
                self.addCleanup(self.service.clean_relogin_progress, progress_id)
                assert started.wait(2)
                progress = self.service.get_relogin_progress(progress_id)
                assert not progress["done"] and progress["processed"] == 0 and progress["stats"]["abnormal"] == 1
                release.set()
                deadline = time.monotonic() + 2
                while not self.service.get_relogin_progress(progress_id)["done"] and time.monotonic() < deadline:
                    time.sleep(.01)
                progress = self.service.get_relogin_progress(progress_id)
                assert progress["done"] and progress["processed"] == 1
                assert progress["stats"]["abnormal"] == 0 and progress["stats"]["total_quota"] == 8
                assert progress["total_quota"] == 8
        finally:
            release.set()

    def test_password_recovery_queries_quota_before_finishing_and_keeps_credentials_on_lookup_failure(self):
        for mode in ("normal", "monitor", "disabled"):
            for failed in (False, True):
                with self.subTest(mode=mode, failed=failed):
                    self.service.update_account("retained", {"usage_mode": mode, "status": "异常", "quota": 0})
                    progress_id = f"quota-{mode}-{failed}"
                    self.service.init_relogin_progress(progress_id, 1)
                    self.addCleanup(self.service.clean_relogin_progress, progress_id)
                    def info():
                        self.assertFalse(self.service.get_relogin_progress(progress_id)["done"])
                        if failed:
                            raise RuntimeError("controlled quota lookup timeout")
                        return {"status": "正常", "quota": 49}
                    with patch.object(self.service, "_login_with_password", return_value={
                        "ok": True, "access_token": "recovered", "refresh_token": "new-refresh", "id_token": "new-id",
                    }), patch.object(self.service, "refresh_access_token", return_value=None), \
                         patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info", side_effect=info):
                        self.service._password_re_login_thread("retained", "test@example.invalid", "fake", "test", progress_id)
                    account = self.service.get_account("retained")
                    self.assertEqual(account["access_token"], "recovered")
                    self.assertEqual(account["refresh_token"], "new-refresh")
                    self.assertEqual(account["usage_mode"], mode)
                    self.assertEqual(account["status"], "正常")
                    self.assertEqual(account["quota"], 0 if failed else 49)
                    progress = self.service.get_relogin_progress(progress_id)
                    self.assertTrue(progress["done"])
                    self.assertEqual(progress["stats"]["total_quota"], 49 if mode == "normal" and not failed else 0)
                    self.assertEqual(progress["total_quota"], 49 if mode == "normal" and not failed else 0)
                    self.assertEqual(bool(progress["results"][0]["error"]), failed)
                    self.assertEqual(bool(account["last_refresh_error"]), failed)

    def test_refresh_accumulates_only_successful_consumable_quota(self):
        self.service.add_account_items([
            {"access_token": token, "usage_mode": mode, "status": "正常", "quota": quota}
            for token, mode, quota in [("failed", "normal", 99), ("untouched", "normal", 70),
                                       ("monitor", "monitor", 13), ("disabled", "disabled", 17)]
        ])
        def fetch(token, *_):
            if token == "failed":
                raise RuntimeError("controlled network failure")
            if token == "retained":
                return self.service.update_account(token, {"quota": 20})
            return self.service.get_account(token)
        totals = [0]
        update = self.service.update_refresh_progress
        def record(*args, **kwargs):
            update(*args, **kwargs)
            totals.append(self.service.get_refresh_progress("accumulate")["total_quota"])
        self.addCleanup(self.service.clean_refresh_progress, "accumulate")
        with patch.dict(config.data, {"auto_relogin_after_refresh": False}), \
             patch.object(self.service, "fetch_remote_info", side_effect=fetch), \
             patch.object(self.service, "update_refresh_progress", side_effect=record):
            self.service.refresh_accounts(["retained", "failed", "monitor", "disabled"], "accumulate")
        progress = self.service.get_refresh_progress("accumulate")
        self.assertTrue(progress["done"])
        self.assertEqual(progress["processed"], 4)
        self.assertEqual(totals, sorted(totals))
        self.assertEqual(progress["total_quota"], 20)
        self.assertEqual(progress["monitor_quota"], 13)
        self.assertEqual(progress["stats"]["total_quota"], 189)
        self.assertEqual(self.service.get_account("failed")["quota"], 99)

    def test_text_and_image_invalid_token_errors_retain_account_and_release_capacity(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": False}), \
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
        with patch.dict(config.data, {"auto_remove_rate_limited_accounts": False}), \
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
        with patch.dict(config.data, {"auto_remove_invalid_accounts": False, "auto_remove_rate_limited_accounts": False}), \
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
