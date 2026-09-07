"""Run the approved offline suite; use only this worktree and synthetic data."""
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

import pytest

manual = {
    "test_v1_chat_completions", "test_v1_messages", "test_v1_responses",
    "test_v1_images_generations", "test_v1_images_edits", "test_codex_4k",
    "test_generations", "test_generations_url", "test_gpt_ppt", "test_gpt_psd",
    "test_gpt_search", "test_image", "test_image_output_tokens", "test_v1_models",
}
files = [str(p.relative_to(ROOT)) for p in sorted((ROOT / "test").glob("test_*.py")) if p.stem not in manual]
files.extend([
    "test/test_v1_models.py::ModelListTests::test_list_models_only_returns_image_models_backed_by_account_types",
    "test/test_v1_models.py::ModelListTests::test_list_models_does_not_return_codex_models_for_web_plus_accounts",
])
with patch("api.image_inputs.requests.get", side_effect=RuntimeError("controlled offline image download")):
    raise SystemExit(pytest.main([*files, "-q", "--tb=short"]))
