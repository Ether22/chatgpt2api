from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services.openai_backend_api import OpenAIBackendAPI
from services.protocol import openai_v1_models
from utils.helper import (
    IMAGE_MODELS,
    WEB_IMAGE_MODELS,
    is_codex_image_model,
    is_image_chat_request,
    is_supported_image_model,
    split_image_model,
)

# [image-2.5]
IMAGE_25_MODELS = ("gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst")


def _model_settings(model: str) -> tuple[str, str]:
    # 跳过 __init__，避免创建真实网络会话
    backend = object.__new__(OpenAIBackendAPI)
    return backend._image_model_settings(model)


class Image25ModelTests(unittest.TestCase):
    def test_web_image_models_include_25_series(self) -> None:
        self.assertEqual(WEB_IMAGE_MODELS[0], "gpt-image-2")
        for model in IMAGE_25_MODELS:
            self.assertIn(model, WEB_IMAGE_MODELS)
            self.assertIn(model, IMAGE_MODELS)

    def test_split_and_support_recognize_25_series(self) -> None:
        for model in IMAGE_25_MODELS:
            self.assertEqual(split_image_model(model), (None, model))
            self.assertEqual(split_image_model(f"  {model.upper()} "), (None, model))
            self.assertTrue(is_supported_image_model(model))
            self.assertFalse(is_codex_image_model(model))

    def test_25_series_has_no_plan_prefixed_variants(self) -> None:
        for model in IMAGE_25_MODELS:
            for plan_type in ("plus", "team", "pro"):
                self.assertEqual(split_image_model(f"{plan_type}-{model}"), (None, None))

    def test_25_series_is_treated_as_image_chat_request(self) -> None:
        for model in IMAGE_25_MODELS:
            self.assertTrue(is_image_chat_request({"model": model, "messages": []}))

    def test_25_series_routes_to_web_auto(self) -> None:
        for model in IMAGE_25_MODELS:
            self.assertEqual(_model_settings(model), ("auto", ""))

    def test_existing_image_models_keep_their_routing(self) -> None:
        self.assertEqual(split_image_model("gpt-image-2"), (None, "gpt-image-2"))
        self.assertEqual(split_image_model("codex-gpt-image-2"), (None, "codex-gpt-image-2"))
        self.assertEqual(split_image_model("plus-codex-gpt-image-2"), ("plus", "codex-gpt-image-2"))
        self.assertNotEqual(_model_settings("gpt-image-2")[0], "auto")
        self.assertEqual(_model_settings("codex-gpt-image-2")[0], "codex-gpt-image-2")
        self.assertEqual(_model_settings("not-an-image-model"), ("auto", ""))


class Image25ModelListTests(unittest.TestCase):
    def _list_model_ids(self, accounts: list[dict]) -> set[str]:
        with (
            mock.patch.object(
                openai_v1_models.model_catalog_service,
                "list_models",
                return_value={"object": "list", "data": []},
            ),
            mock.patch.object(openai_v1_models.account_service, "list_accounts", return_value=accounts),
            mock.patch.object(openai_v1_models.account_service, "is_text_account_available", return_value=True),
        ):
            result = openai_v1_models.list_models()
        return {item["id"] for item in result["data"]}

    def test_list_models_returns_25_series_for_web_accounts(self) -> None:
        ids = self._list_model_ids([{"access_token": "token-web-plus", "type": "Plus", "source_type": "web"}])
        for model in WEB_IMAGE_MODELS:
            self.assertIn(model, ids)
        self.assertNotIn("codex-gpt-image-2", ids)

    def test_list_models_omits_25_series_without_accounts(self) -> None:
        ids = self._list_model_ids([])
        for model in WEB_IMAGE_MODELS:
            self.assertNotIn(model, ids)


if __name__ == "__main__":
    unittest.main()
