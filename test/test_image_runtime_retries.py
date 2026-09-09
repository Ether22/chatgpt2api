"""Bounded runtime retries and durable upstream cleanup, with no external calls."""
from types import SimpleNamespace

import pytest

from services.config import config
from services.image_task_service import ImageTaskService, TaskServiceStopped
from services.openai_backend_api import ImageContentPolicyError, ImagePollTimeoutError
from services.protocol import conversation, openai_v1_image_generations
from services.storage import image_rows
from test.test_image_conversations_http import environment, submit


@pytest.fixture
def runtime(environment, monkeypatch):
    from services import openai_backend_api
    calls, removed, clients = [], [], []
    pool = SimpleNamespace(get_available_access_token=lambda **_: "controlled-token",
        get_account=lambda _: {"email": "controlled@example.test"}, mark_image_result=lambda *_: None,
        image_recovery_token=lambda _: "controlled-token", list_tokens=lambda: ["controlled-token"])
    monkeypatch.setattr(conversation, "account_service", pool)
    monkeypatch.setattr(openai_backend_api, "account_service", pool)
    monkeypatch.setattr(conversation.time, "sleep", lambda _: None)
    for name in ("image_remove_conversation_always", "image_remove_conversation_after_result"):
        monkeypatch.setitem(config.data, name, False)

    class Backend:
        base_url = "https://controlled.test"
        def __init__(self, access_token):
            self.closed = False
            clients.append(self)
        def close(self):
            self.closed = True
        def delete_conversation(self, cid):
            assert not self.closed
            removed.append(cid)

    monkeypatch.setattr(conversation, "OpenAIBackendAPI", Backend)
    monkeypatch.setattr(openai_backend_api, "OpenAIBackendAPI", Backend)
    environment["service"].generation_handler = openai_v1_image_generations.handle
    environment.update(sent=calls, removed=removed, clients=clients)

    def send(backend, request):
        number = len(calls) + 1
        cid = f"conversation-{number}"
        checkpoint = {"account_ref": "opaque-account", "base_url": backend.base_url,
                      "protocol": "web", "request_id": f"request-{number}"}
        request.lifecycle_callback("sending", checkpoint)
        backend.image_request_sent = True
        calls.append(checkpoint)
        request.lifecycle_callback("conversation", {"conversation_id": cid})
        return cid

    environment["send"] = send
    yield environment
    environment["service"].shutdown(timeout=5)


def finish(env):
    for thread in list(env["service"]._workers.values()):
        thread.join(5)
        assert not thread.is_alive()
    return next(iter(image_rows.load(env["path"], "tasks").values()))


@pytest.mark.parametrize("kind,limit", [("poll_timeout", 4), ("text_reply", 3), ("tls", 3),
                                       ("connection_timeout", 3), ("policy", 0), ("arbitrary", 0)])
def test_exact_retry_classes_and_limits(runtime, monkeypatch, kind, limit):
    env = runtime
    def stream(backend, request, index, total):
        cid = env["send"](backend, request)
        errors = {"poll_timeout": ImagePollTimeoutError("poll exhausted", cid),
                  "text_reply": conversation.ImageGenerationError('{"size":"1024x1024","n":1}', conversation_id=cid),
                  "tls": ConnectionError("curl: (35) TLS connect error"),
                  "connection_timeout": TimeoutError("curl: (28) connection timed out"),
                  "policy": ImageContentPolicyError("policy rejected", cid),
                  "arbitrary": RuntimeError("controlled program failure")}
        raise errors[kind]
        yield
    monkeypatch.setattr(conversation, "stream_image_outputs", stream)
    assert submit(env).status_code == 200
    task = finish(env)
    assert len(env["sent"]) == limit + 1
    assert len(task.get("attempts", [])) == limit
    assert task.get("retry_counts", {}) == ({kind: limit} if limit else {})
    assert task["status"] == "error" and task["dispatch_state"] == "unknown"
    assert env["removed"] == [] and all(client.closed for client in env["clients"])
    assert "controlled-token" not in str(task)


@pytest.mark.parametrize("mode", ["always", "after_result", "off"])
@pytest.mark.parametrize("success", [True, False])
def test_cleanup_gates_cover_abandoned_and_final_attempts(runtime, monkeypatch, mode, success):
    env = runtime
    monkeypatch.setitem(config.data, "image_remove_conversation_always", mode == "always")
    monkeypatch.setitem(config.data, "image_remove_conversation_after_result", mode == "after_result")
    def stream(backend, request, index, total):
        cid = env["send"](backend, request)
        if len(env["sent"]) == 1:
            raise ImagePollTimeoutError("poll exhausted", cid)
        if not success:
            raise RuntimeError("controlled program failure")
        yield conversation.ImageOutput(kind="result", model=request.model, index=index, total=total,
                                       data=[{"url": "https://controlled.test/result.png"}], conversation_id=cid)
    monkeypatch.setattr(conversation, "stream_image_outputs", stream)
    submit(env)
    task = finish(env)
    expected = ["conversation-1", "conversation-2"] if mode == "always" else (
        ["conversation-2"] if mode == "after_result" and success else [])
    assert env["removed"] == expected
    assert len(env["sent"]) == 2 and all(client.closed for client in env["clients"])
    if expected:
        assert task["upstream_cleanup"]["state"] == "complete" and task["can_resume"] is False
    if mode == "always" and not success:
        assert task["dispatch_state"] == "removed"
        with pytest.raises(ValueError):
            env["service"].resume_poll(env["owner"], task["id"])


@pytest.mark.parametrize("boundary", ["retry", "ready", "sending"])
def test_deleted_task_never_crosses_retry_send_boundary(runtime, monkeypatch, boundary):
    env = runtime
    monkeypatch.setitem(config.data, "image_remove_conversation_always", True)
    def handler(payload):
        callback = payload["lifecycle_callback"]
        def lifecycle(event, checkpoint):
            if event == boundary and len(env["sent"]) == 1:
                cid = next(iter(env["service"]._conversations))
                response = env["client"].delete(f"/api/image-conversations/{cid}", headers=env["headers"])
                assert response.status_code == 200, response.text
            callback(event, checkpoint)
        return openai_v1_image_generations.handle({**payload, "lifecycle_callback": lifecycle})
    env["service"].generation_handler = handler
    def stream(backend, request, index, total):
        cid = env["send"](backend, request)
        raise ImagePollTimeoutError("poll exhausted", cid)
        yield
    monkeypatch.setattr(conversation, "stream_image_outputs", stream)
    submit(env)
    task = finish(env)
    assert len(env["sent"]) == 1 and env["removed"] == ["conversation-1"]
    assert task["result_deleted"] and task["dispatch_state"] == "cancelled"
    assert task["result_cleanup"]["state"] == "complete"


@pytest.mark.parametrize("crash", [True, False])
def test_retry_checkpoint_survives_restart_or_blocks_send_on_commit_failure(runtime, monkeypatch, crash):
    env = runtime
    def stream(backend, request, index, total):
        cid = env["send"](backend, request)
        raise ImagePollTimeoutError("poll exhausted", cid)
        yield
    monkeypatch.setattr(conversation, "stream_image_outputs", stream)
    first = env["service"]
    save = first._save_locked
    def checkpoint(**changes):
        if any(task.get("retry_counts") for task in first._tasks.values()):
            if not crash:
                raise OSError("controlled retry checkpoint commit failure")
            save(**changes)
            first._stopping.set()
            raise TaskServiceStopped()
        save(**changes)
    monkeypatch.setattr(first, "_save_locked", checkpoint)
    submit(env)
    task = finish(env)
    assert len(env["sent"]) == 1
    if not crash:
        assert task["dispatch_state"] == "unknown" and task.get("attempts", []) == []
        return
    assert task["dispatch_state"] == "pending" and task["retry_counts"] == {"poll_timeout": 1}
    restored = ImageTaskService(env["path"], generation_handler=openai_v1_image_generations.handle)
    env["service"] = restored
    restored.start()
    task = finish(env)
    assert len(env["sent"]) == 5 and len(task["attempts"]) == 4


def test_cleanup_pending_restart_only_finishes_removal_and_never_polls(runtime, monkeypatch):
    env = runtime
    monkeypatch.setitem(config.data, "image_remove_conversation_always", True)
    def stream(backend, request, index, total):
        env["send"](backend, request)
        raise RuntimeError("controlled program failure")
        yield
    monkeypatch.setattr(conversation, "stream_image_outputs", stream)
    original = env["service"]
    save = original._save_locked
    def fail_completion(**changes):
        if any((task.get("upstream_cleanup") or {}).get("state") == "complete" for task in original._tasks.values()):
            raise OSError("controlled cleanup completion commit failure")
        save(**changes)
    monkeypatch.setattr(original, "_save_locked", fail_completion)
    submit(env)
    task = finish(env)
    assert task["upstream_cleanup"]["state"] == "pending" and task["can_resume"] is False
    original.shutdown(timeout=5)
    restored = ImageTaskService(env["path"])
    env["service"] = restored
    monkeypatch.setattr(restored, "_run_resume_poll", lambda *_: pytest.fail("Removed upstream must never be polled"))
    restored.start()
    task = finish(env)
    assert task["upstream_cleanup"]["state"] == "complete" and task["dispatch_state"] == "removed"
    assert len(env["sent"]) == 1 and env["removed"] == ["conversation-1", "conversation-1"]


@pytest.mark.parametrize("success", [True, False])
def test_stop_at_terminal_save_retains_cleanup_intent(runtime, monkeypatch, success):
    env = runtime
    monkeypatch.setitem(config.data, "image_remove_conversation_always", not success)
    monkeypatch.setitem(config.data, "image_remove_conversation_after_result", success)
    def stream(backend, request, index, total):
        cid = env["send"](backend, request)
        if not success:
            raise RuntimeError("controlled final failure")
        yield conversation.ImageOutput(kind="result", model=request.model, index=index, total=total,
                                       data=[{"url": "https://controlled.test/result.png"}], conversation_id=cid)
    monkeypatch.setattr(conversation, "stream_image_outputs", stream)
    original = env["service"]
    save = original._save_locked
    def stop(**changes):
        save(**changes)
        if any(task.get("upstream_cleanup") for task in original._tasks.values()):
            original._stopping.set()
    monkeypatch.setattr(original, "_save_locked", stop)
    submit(env)
    task = finish(env)
    assert task["upstream_cleanup"]["state"] == "pending" and env["removed"] == []
    restored = ImageTaskService(env["path"])
    env["service"] = restored
    monkeypatch.setattr(restored, "_run_resume_poll", lambda *_: pytest.fail("Cleanup intent must survive terminal save"))
    restored.start()
    task = finish(env)
    assert task["upstream_cleanup"]["state"] == "complete" and env["removed"] == ["conversation-1"]
    assert task["status"] == ("success" if success else "error") and len(env["sent"]) == 1
