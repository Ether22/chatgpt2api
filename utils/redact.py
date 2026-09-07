"""Credential redaction for diagnostic text and structured logs."""
import re
from typing import Any

_SECRET_KEY = re.compile(r"(?i)(?:token|authorization|password|cookie|secret|oauth.?code|auth.?code|api.?key|auth.?key)|^code$")
_SECRET_VALUE = re.compile(r"(?i)(\b(?:access[_ -]?token|refresh[_ -]?token|authorization|password|oauth[_ -]?code|auth[_ -]?code|code|api[_ -]?key|auth[_ -]?key)\b[\"']?\s*[:=]\s*[\"']?)(?:Bearer\s+)?[^\s\"'&,;}]+")
_URL = re.compile(r"https?://[^\s\"'<>]+", re.I)


def redact(value: Any, secrets=()) -> Any:
    if isinstance(value, dict):
        return {key: "[REDACTED]" if isinstance(item, str) and _SECRET_KEY.search(str(key)) else redact(item, secrets)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item, secrets) for item in value]
    if not isinstance(value, str):
        return value
    for secret in secrets:
        if isinstance(secret, str) and secret:
            value = value.replace(secret, "[REDACTED]")
    value = _URL.sub(lambda match: "[REDACTED_URL]" if re.search(
        r"(?i)(?:/authorize|/oauth|auth\.|[?&](?:code|token|access_token|client_id)=|://[^/]+@)", match[0]) else match[0], value)
    value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
    value = _SECRET_VALUE.sub(r"\1[REDACTED]", value)
    value = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9_-]+", "[REDACTED]", value)
    return value
