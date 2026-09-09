"""Accepted tasks survive restart; controlled handlers stand in for paid upstreams."""
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from services.image_task_service import ImageTaskService
from test.test_image_task_service import OWNER, wait_for_task
from test.test_image_conversations_http import environment, submit


def test_unsent_edit_restarts_with_original_images_mask_and_identity(tmp_path):
    entered, release = threading.Event(), threading.Event()
    sent = []

    def upstream(payload):
        entered.set()
        assert release.wait(5)
        payload["lifecycle_callback"]("sending", {"account_ref": "controlled-account", "protocol": "web"})
        sent.append(payload)
        return {"data": [{"url": "https://controlled.test/result.png"}]}

    path = tmp_path / "tasks.sqlite3"
    first = ImageTaskService(path, edit_handler=upstream)
    first.submit_edit({**OWNER, "key": "must-never-be-persisted"}, client_task_id="edit", prompt="original",
                      model="gpt-image-2", size="1024x1024", quality="high",
                      images=[(b"original-image", "original.png", "image/png")],
                      masks=[(b"original-mask", "mask.png", "image/png")])
    assert entered.wait(5)
    first.shutdown(timeout=0)
    release.set()
    first.shutdown(timeout=5)
    assert sent == []
    assert b"must-never-be-persisted" not in path.read_bytes()

    restored = ImageTaskService(path, edit_handler=upstream)
    restored.start()
    try:
        assert wait_for_task(restored, OWNER, "edit", "success")["id"] == "edit"
        assert len(sent) == 1
        assert sent[0]["prompt"] == "original"
        assert sent[0]["quality"] == "high"
        assert sent[0]["images"] == [(b"original-image", "original.png", "image/png")]
        assert sent[0]["mask"] == [(b"original-mask", "mask.png", "image/png")]
    finally:
        restored.shutdown()


def test_pool_waits_for_known_restore_and_busy_slots_but_rejects_unknown_quota(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    from services.openai_backend_api import OpenAIBackendAPI
    from services.config import config
    store = JSONStorageBackend(tmp_path / "accounts.json")
    store.save_accounts([{"access_token": "controlled", "status": "限流", "quota": 0,
                          "restore_at": (datetime.now(timezone.utc) + timedelta(seconds=.2)).isoformat()}])
    pool = AccountService(store)
    monkeypatch.setitem(config.data, "image_account_concurrency", 1)
    monkeypatch.setattr(OpenAIBackendAPI, "get_user_info", lambda *_args, **_kwargs: {"status": "正常", "quota": 5})
    waiting = []
    token = pool.get_available_access_token(wait_callback=waiting.append)
    assert token == "controlled"
    assert any(item["reason"] == "quota" for item in waiting)
    busy = threading.Event()
    with ThreadPoolExecutor() as workers:
        queued = workers.submit(pool.get_available_access_token, wait_callback=lambda _item: busy.set())
        assert busy.wait(3)
        assert not queued.done()
        pool.update_account(token, {"usage_mode": "monitor"})
        with pytest.raises(RuntimeError, match="合格"):
            queued.result(timeout=3)
    pool.release_image_slot(token)
    pool.update_account(token, {"usage_mode": "normal", "status": "限流", "quota": 0, "restore_at": None})
    with pytest.raises(RuntimeError, match="恢复时间"):
        pool.get_available_access_token()


def test_real_protocol_retries_classified_connection_reset_with_durable_attempts(environment, tmp_path, monkeypatch):
    from services import openai_backend_api as backend
    from services.protocol import conversation, openai_v1_image_generations
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    from services.config import config
    from test.test_reference_protocol import ControlledHTTP
    store = JSONStorageBackend(tmp_path / "accounts.json")
    store.save_accounts([{"access_token": "secret-upstream-token", "status": "正常", "quota": 100}])
    pool = AccountService(store)
    monkeypatch.setattr(backend, "account_service", pool)
    monkeypatch.setattr(conversation, "account_service", pool)
    remote = ControlledHTTP()
    session = remote.session
    def transport(**kwargs):
        client = session(**kwargs)
        original = client.post
        def post(url, **arguments):
            result = original(url, **arguments)
            if url.endswith("/f/conversation"):
                raise ConnectionError("connection reset by peer after accepted generation")
            return result
        client.post = post
        return client
    monkeypatch.setattr(backend.requests, "Session", transport)
    monkeypatch.setattr(conversation.time, "sleep", lambda _seconds: None)
    monkeypatch.setitem(config.data, "image_remove_conversation_always", False)
    environment["service"].generation_handler = openai_v1_image_generations.handle
    response = submit(environment)
    assert response.status_code == 200, response.text
    task_id = response.json()["turns"][0]["images"][0]["taskId"]
    task = wait_for_task(environment["service"], environment["owner"], task_id, "error", timeout=20)
    assert len(remote.generations) == 4
    assert task["dispatch_state"] == "unknown"
    assert task["retryable"] is False
    assert "secret-upstream-token" not in str(task)
    durable = next(iter(environment["service"]._tasks.values()))
    assert durable["retry_counts"] == {"tls": 3}
    assert len({attempt["upstream"]["request_id"] for attempt in durable["attempts"]}) == 3


def test_slow_reference_upload_does_not_block_history_or_a_ready_turn(environment, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from services import image_storage_service as storage
    from services.config import config
    from test.test_image_references_http import upload
    from test.test_image_conversations_http import image_bytes
    started, release = threading.Event(), threading.Event()
    slow = False
    class Remote:
        def __init__(self, _settings):
            pass
        def test(self):
            return {"ok": True}
        def put(self, rel, payload, content_type="image/png"):
            if slow:
                started.set()
                assert release.wait(10)
            return "https://controlled.test/" + rel
    monkeypatch.setattr(storage, "WebDAVClient", Remote)
    monkeypatch.setitem(config.data, "image_storage", {"enabled": True, "mode": "both", "webdav_url": "https://controlled.test"})
    ready = upload(environment)
    slow = True
    with ThreadPoolExecutor(max_workers=3) as clients:
        uploading = clients.submit(upload, environment, "slow", "slow.png")
        assert started.wait(3)
        try:
            listing = clients.submit(environment["client"].get, "/api/image-conversations", headers=environment["headers"])
            assert listing.result(timeout=2).status_code == 200
            accepted = clients.submit(submit, environment, referenceImages=[{"id": ready["id"]}])
            assert accepted.result(timeout=2).status_code == 200
        finally:
            release.set()
        assert uploading.result(timeout=5)["name"] == "slow.png"
    environment["service"].shutdown(timeout=5)


def test_failed_task_and_logs_keep_reason_and_task_id_but_redact_credentials(tmp_path, monkeypatch, capfd):
    from services import image_task_service as tasks
    from services.log_service import LogService
    from utils.log import Logger
    logger = LogService(tmp_path / "events.jsonl")
    monkeypatch.setattr(tasks, "log_service", logger)
    secret = ('read failed: Authorization: Bearer upstream-secret; auth_key=login-secret; '
              'oauth_code=oauth-secret; https://auth.openai.com/authorize?client_id=client-secret&code=link-secret')
    def upstream(_payload):
        raise RuntimeError(secret)
    service = ImageTaskService(tmp_path / "tasks.sqlite3", generation_handler=upstream)
    service.submit_generation(OWNER, client_task_id="failed-image", prompt="test", model="gpt-image-2", size=None)
    task = wait_for_task(service, OWNER, "failed-image", "error")
    service.shutdown(timeout=5)
    assert task["retryable"] is True
    assert "read failed" in task["error"]
    assert "failed-image" in task["error_detail"]
    Logger().error({"error": secret})
    output = str(task) + (tmp_path / "events.jsonl").read_text(encoding="utf-8") + capfd.readouterr().err
    assert all(value not in output for value in ("upstream-secret", "login-secret", "oauth-secret", "client-secret", "link-secret"))


@pytest.mark.parametrize("match", [True, False])
def test_restart_verifies_exact_request_on_original_account_without_resending(environment, tmp_path, monkeypatch, match):
    from services import openai_backend_api as backend
    from services.protocol import conversation, openai_v1_image_generations
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    from services.config import config
    from test.test_reference_protocol import ControlledHTTP, Reply
    store = JSONStorageBackend(tmp_path / "accounts.json")
    store.save_accounts([{"access_token": "original-account", "status": "正常", "quota": 100}])
    pool = AccountService(store)
    monkeypatch.setattr(backend, "account_service", pool)
    monkeypatch.setattr(conversation, "account_service", pool)
    remote = ControlledHTTP()
    make_session = remote.session
    reads = []
    def transport(**kwargs):
        client = make_session(**kwargs)
        get, post = client.get, client.post
        def send(url, **arguments):
            result = post(url, **arguments)
            if url.endswith("/f/conversation"):
                raise ConnectionError("response lost after upstream accepted")
            return result
        def read(url, **arguments):
            if "/backend-api/conversations?" in url:
                reads.append(client.headers["Authorization"])
                return Reply({"items": [{"id": "wrong", "title": "a red kite"}, {"id": "correct"}]})
            if "/backend-api/conversation/" in url:
                request_id = remote.generations[0]["messages"][0]["id"] if match and url.endswith("/correct") else "unrelated-request"
                return Reply({"mapping": {"user": {"message": {"id": request_id, "author": {"role": "user"}}},
                    "tool": {"message": {"author": {"role": "tool"}, "metadata": {"async_task_type": "image_gen"},
                      "content": {"parts": ["file-service://file_generated_00001"]}}}}})
            return get(url, **arguments)
        client.post, client.get = send, read
        return client
    monkeypatch.setattr(backend.requests, "Session", transport)
    for key in ("image_check_before_hit_enabled", "image_settle_enabled", "image_remove_conversation_always", "image_remove_conversation_after_result"):
        monkeypatch.setitem(config.data, key, False)
    monkeypatch.setitem(config.data, "image_poll_initial_wait_secs", 0)
    environment["service"].generation_handler = openai_v1_image_generations.handle
    response = submit(environment)
    task_id = response.json()["turns"][0]["images"][0]["taskId"]
    wait_for_task(environment["service"], environment["owner"], task_id, "error")
    environment["service"].shutdown(timeout=5)
    pool.update_account("original-account", {"usage_mode": "monitor", "hidden": True})
    assert "image_account_ref" not in str(pool.list_accounts())
    assert "image_account_ref" not in str(pool.get_account("original-account"))
    assert "image_account_ref" not in str(pool.build_export_items())
    # A new account-service instance must still resolve the opaque reference.
    monkeypatch.setattr(backend, "account_service", AccountService(store))
    restored = ImageTaskService(environment["path"])
    restored.start()
    try:
        task = wait_for_task(restored, environment["owner"], task_id, "success" if match else "error", timeout=5)
        assert reads == ["Bearer original-account"]
        assert len(remote.generations) == 1
        if match:
            assert task["conversation_id"] == "correct"
            assert task["data"][0]["url"]
        else:
            assert task["dispatch_state"] == "unknown"
            assert "未知" in task["error"]
    finally:
        restored.shutdown(timeout=5)


def test_same_conversation_consumption_expands_with_the_live_account_pool(environment, tmp_path, monkeypatch):
    from services import openai_backend_api as backend
    from services.protocol import conversation, openai_v1_image_generations
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    from services.config import config
    from test.test_reference_protocol import ControlledHTTP
    store = JSONStorageBackend(tmp_path / "accounts.json")
    store.save_accounts([{"access_token": token, "status": "正常", "quota": 100} for token in ("first", "second")])
    pool = AccountService(store)
    monkeypatch.setattr(backend, "account_service", pool)
    monkeypatch.setattr(conversation, "account_service", pool)
    monkeypatch.setitem(config.data, "image_account_concurrency", 1)
    monkeypatch.setitem(config.data, "image_check_before_hit_enabled", False)
    monkeypatch.setitem(config.data, "image_remove_conversation_after_result", False)
    remote = ControlledHTTP()
    release, two, three = threading.Event(), threading.Event(), threading.Event()
    make_session = remote.session
    def transport(**kwargs):
        client = make_session(**kwargs)
        post = client.post
        def send(url, **arguments):
            response = post(url, **arguments)
            if url.endswith("/f/conversation"):
                if len(remote.generations) >= 2:
                    two.set()
                if len(remote.generations) >= 3:
                    three.set()
                assert release.wait(10)
            return response
        client.post = send
        return client
    monkeypatch.setattr(backend.requests, "Session", transport)
    environment["service"].generation_handler = openai_v1_image_generations.handle
    try:
        replies = [submit(environment, request_id=f"round-{index}").json() for index in range(3)]
        assert len({reply["id"] for reply in replies}) == 1
        assert two.wait(3)
        assert len(remote.generations) == 2
        assert sum(item["image_inflight"] for item in pool.list_accounts()) == 2
        pool.add_account_items([{"access_token": "third", "status": "正常", "quota": 100}])
        assert three.wait(3), "Adding an eligible account must release waiting work without a fixed global limit"
    finally:
        release.set()
    tasks = environment["service"].list_tasks(environment["owner"], [])["items"]
    for task in tasks:
        wait_for_task(environment["service"], environment["owner"], task["id"], "success", timeout=5)
    assert len(remote.generations) == 3


@pytest.mark.parametrize("status,health", [(401, "异常"), (429, "限流")])
def test_real_post_rejection_updates_health_without_resending_or_removing_account(environment, tmp_path, monkeypatch, status, health):
    from services import openai_backend_api as backend
    from services.protocol import conversation, openai_v1_image_generations
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    from test.test_reference_protocol import ControlledHTTP, Reply
    from services.config import config
    monkeypatch.setitem(config.data, "auto_remove_invalid_accounts", False)
    monkeypatch.setitem(config.data, "auto_remove_rate_limited_accounts", False)
    store = JSONStorageBackend(tmp_path / "accounts.json")
    store.save_accounts([{"access_token": "retained", "status": "正常", "quota": 100, "hidden": True}])
    pool = AccountService(store)
    monkeypatch.setattr(backend, "account_service", pool)
    monkeypatch.setattr(conversation, "account_service", pool)
    remote = ControlledHTTP()
    make_session = remote.session
    def transport(**kwargs):
        client = make_session(**kwargs)
        post = client.post
        def send(url, **arguments):
            response = post(url, **arguments)
            if url.endswith("/f/conversation"):
                response = Reply({"error": "unauthorized" if status == 401 else "rate limited"}, status=status)
                if status == 401:
                    response.headers["Retry-After"] = "60"
            return response
        client.post = send
        return client
    monkeypatch.setattr(backend.requests, "Session", transport)
    environment["service"].generation_handler = openai_v1_image_generations.handle
    response = submit(environment)
    task_id = response.json()["turns"][0]["images"][0]["taskId"]
    task = wait_for_task(environment["service"], environment["owner"], task_id, "error")
    assert len(remote.generations) == 1
    assert task["dispatch_state"] == "rejected" and task["retryable"] is True
    account = pool.list_accounts()[0]
    assert (account["status"], account["usage_mode"], account["image_inflight"]) == (health, "normal", 0)
    assert "hidden" not in account


@pytest.mark.parametrize("restart_after_rejection", [False, True])
def test_explicit_429_waits_until_known_restore_then_cleans_only_durable_success(environment, tmp_path, monkeypatch, restart_after_rejection):
    from services import openai_backend_api as backend
    from services.protocol import conversation, openai_v1_image_generations
    from services.account_service import AccountService
    from services.config import config
    from services.storage import image_rows
    from services.storage.json_storage import JSONStorageBackend
    from test.test_reference_protocol import ControlledHTTP, Reply
    store = JSONStorageBackend(tmp_path / "limited.json")
    store.save_accounts([{"access_token": "retained", "status": "正常", "quota": 100}])
    pool = AccountService(store)
    monkeypatch.setattr(backend, "account_service", pool)
    monkeypatch.setattr(conversation, "account_service", pool)
    monkeypatch.setitem(config.data, "image_remove_conversation_after_result", True)
    monkeypatch.setitem(config.data, "image_settle_enabled", False)
    remote, cleaned, sent_at = ControlledHTTP(), [], []
    make_session = remote.session

    def transport(**kwargs):
        client = make_session(**kwargs)
        post = client.post
        def send(url, **arguments):
            if url.endswith("/f/conversation"):
                sent_at.append(time.time())
            response = post(url, **arguments)
            if url.endswith("/f/conversation") and len(remote.generations) == 1:
                response = Reply({"error": "rate limited"}, status=429)
                response.headers["Retry-After"] = "3"
            return response
        def remove(_url, **_kwargs):
            rows = image_rows.load(environment["path"], "tasks")
            assert all(row["status"] == "success" for row in rows.values())
            cleaned.append(True)
            return Reply()
        client.post, client.patch = send, remove
        return client

    monkeypatch.setattr(backend.requests, "Session", transport)
    environment["service"].generation_handler = openai_v1_image_generations.handle
    checkpoint = threading.Event()
    if restart_after_rejection:
        original = environment["service"]
        save = original._save_locked
        def stop_at_rejected(**changes):
            save(**changes)
            if any(task.get("dispatch_state") == "rejected" for task in original._tasks.values()):
                checkpoint.set()
                assert original._stopping.wait(10)
                from services.image_task_service import TaskServiceStopped
                raise TaskServiceStopped()
        monkeypatch.setattr(original, "_save_locked", stop_at_rejected)
    response = submit(environment)
    task_id = response.json()["turns"][0]["images"][0]["taskId"]
    if restart_after_rejection:
        assert checkpoint.wait(5)
        original.shutdown(timeout=3)
        durable = next(iter(image_rows.load(environment["path"], "tasks").values()))
        assert durable["dispatch_state"] == "rejected"
        assert durable["last_rejection"]["retry_after"] == "3"
        assert pool.list_accounts()[0].get("restore_at") is None, "Crash precedes the pool's health update"
        restored = ImageTaskService(environment["path"], generation_handler=openai_v1_image_generations.handle)
        environment["service"] = restored
        restored.start()
        time.sleep(.15)
        assert len(sent_at) == 1 and time.time() < durable["retry_not_before"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        task = environment["service"].list_tasks(environment["owner"], [task_id])["items"][0]
        if task.get("waiting") and task["dispatch_state"] == "pending":
            break
        time.sleep(.01)
    assert task["status"] == "queued" and task["dispatch_state"] == "pending"
    assert task["waiting"]["reason"] == "quota" and task["waiting"]["restore_at"]
    assert len(remote.generations) == 1 and not cleaned
    wait_for_task(environment["service"], environment["owner"], task_id, "success", timeout=8)
    for worker in list(environment["service"]._workers.values()):
        worker.join(5)
    environment["service"].shutdown(timeout=5)
    assert len(remote.generations) == 2 and cleaned == [True]
    final = next(iter(image_rows.load(environment["path"], "tasks").values()))
    assert sent_at[1] >= sent_at[0] + 3
    assert final["last_rejection"]["upstream"]["request_id"] != final["upstream"]["request_id"]
    assert pool.list_accounts()[0]["image_inflight"] == 0
