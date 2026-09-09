from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.accounts as accounts_api
from services.account_service import AccountService
from services.config import config
from services.storage.json_storage import JSONStorageBackend
from services.storage.database_storage import DatabaseStorageBackend


class AccountVisibilityOrderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.storage = JSONStorageBackend(Path(temporary.name) / "accounts.json")
        self.service = AccountService(self.storage)
        self.service.add_account_items([
            {"access_token": "a", "quota": 3},
            {"access_token": "b", "usage_mode": "disabled", "quota": 5},
            {"access_token": "m", "usage_mode": "monitor", "quota": 7},
            {"access_token": "n", "usage_mode": "monitor", "quota": 11},
        ])
        self.addCleanup(patch.stopall)
        patch.object(accounts_api, "account_service", self.service).start()
        app = FastAPI()
        app.include_router(accounts_api.create_router())
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": f"Bearer {config.auth_key}"}

    def test_legacy_hidden_is_ignored_and_keeps_accounts_and_statistics(self):
        before = self.service.get_stats()
        for token, mode in (("a", "normal"), ("b", "disabled"), ("m", "monitor")):
            response = self.client.post("/api/accounts/update", headers=self.headers,
                                        json={"access_token": token, "hidden": True})
            self.assertEqual(response.status_code, 400, response.text)
            item = AccountService(self.storage).get_account(token)
            self.assertNotIn("hidden", item)
            self.assertEqual(item["usage_mode"], mode)
        self.assertEqual(self.service.get_stats(), before)
        self.assertEqual(self.service.get_text_access_token(), "a")
        self.assertEqual(set(self.service.list_tokens()), {"a", "b", "m", "n"})
        with patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                   return_value={"status": "正常", "quota": 3}):
            self.assertEqual(self.service.refresh_accounts(["a", "b", "m", "n"])["refreshed"], 4)
            token = self.service.get_available_access_token()
            self.assertEqual(token, "a")
            self.service.release_image_slot(token)
        response = self.client.post("/api/accounts/update", headers=self.headers,
                                    json={"access_token": "a", "hidden": False})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertNotIn("hidden", AccountService(self.storage).get_account("a"))

    def test_hiding_limited_accounts_keeps_order_when_legacy_removal_flags_are_enabled(self):
        with patch.dict(config.data, {"auto_remove_invalid_accounts": True, "auto_remove_rate_limited_accounts": True}):
            for mode in ("normal", "monitor", "disabled"):
                self.service.add_account_items([{"access_token": mode, "usage_mode": mode, "status": "限流", "quota": 0}])
                previous = self.service.get_account(mode)
                response = self.client.post("/api/accounts/update", headers=self.headers,
                                            json={"access_token": mode, "hidden": True})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(AccountService(self.storage).get_account(mode), previous)

    def test_group_moves_survive_reload_and_reject_cross_group_or_missing_targets(self):
        def move(source, target, position="before"):
            return self.client.post("/api/accounts/move", headers=self.headers,
                                    json={"access_token": source, "target_token": target, "position": position})

        self.assertEqual(move("b", "a").status_code, 200)
        self.assertEqual(move("n", "m").status_code, 200)
        self.assertEqual([a["access_token"] for a in AccountService(self.storage).list_accounts()],
                         ["n", "m", "b", "a"])
        self.assertEqual(move("a", "m").status_code, 400)
        self.assertEqual(move("a", "missing").status_code, 400)
        self.assertEqual(move("a", "b", "invalid").status_code, 422)
        denied = self.client.post("/api/accounts/move", json={"access_token": "a", "target_token": "b"})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(move("b", "a", "after").status_code, 200)
        self.assertEqual([a["access_token"] for a in AccountService(self.storage).list_accounts()],
                         ["n", "m", "a", "b"])

    def test_switching_group_appends_and_refresh_rotation_keeps_hidden_order_and_export(self):
        self.service.move_account("n", "m")
        self.service.update_account("a", {"usage_mode": "monitor", "hidden": True,
                                         "refresh_token": "fake-refresh", "id_token": "fake-id"})
        self.assertEqual([a["access_token"] for a in self.service.list_accounts()], ["n", "m", "a", "b"])
        with patch("curl_cffi.requests.Session.post", return_value=SimpleNamespace(
            status_code=200, text="ok", json=lambda: {"access_token": "a-rotated"}
        )), patch("services.openai_backend_api.OpenAIBackendAPI.get_user_info",
                  return_value={"quota": 13, "status": "正常", "hidden": False, "display_order": 99}):
            self.service.refresh_access_token("a", force=True)
            self.service.fetch_remote_info("a")
        reloaded = AccountService(self.storage)
        self.assertEqual([a["access_token"] for a in reloaded.list_accounts()], ["n", "m", "a-rotated", "b"])
        self.assertNotIn("hidden", reloaded.get_account("a-rotated"))
        self.assertEqual(reloaded.get_account("a-rotated")["quota"], 13)
        self.assertEqual([a["access_token"] for a in reloaded.build_export_items(["a-rotated"])], ["a-rotated"])
        reloaded.update_account("a-rotated", {"usage_mode": "disabled", "hidden": False})
        self.assertEqual([a["access_token"] for a in AccountService(self.storage).list_accounts()], ["n", "m", "b", "a-rotated"])

    def test_legacy_sqlite_records_get_stable_order_without_schema_changes(self):
        storage = DatabaseStorageBackend(f"sqlite:///{self.storage.file_path.with_suffix('.db').as_posix()}")
        self.addCleanup(storage.engine.dispose)
        storage.save_accounts([
            {"access_token": "first", "refresh_token": "rt"},
            {"access_token": "second"},
            {"access_token": "third"},
        ])
        service = AccountService(storage)
        self.assertEqual([a["access_token"] for a in service.list_accounts()], ["first", "second", "third"])
        service.move_account("third", "first")
        service.update_account("first", {"hidden": True})
        with patch("curl_cffi.requests.Session.post", return_value=SimpleNamespace(
            status_code=200, text="ok", json=lambda: {"access_token": "rotated"}
        )):
            service.refresh_access_token("first", force=True)
        reloaded = AccountService(storage)
        self.assertEqual([a["access_token"] for a in reloaded.list_accounts()], ["third", "rotated", "second"])
        self.assertNotIn("hidden", reloaded.get_account("rotated"))


if __name__ == "__main__":
    unittest.main()
