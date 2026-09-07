"""Public upstream stream boundary with controlled HTTP transport; no real account/credits."""
import base64
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

from test.test_image_conversations_http import image_bytes


class Reply:
    def __init__(self, value=None, *, status=200, lines=None):
        self.status_code = status
        self.value = value or {}
        self.text = json.dumps(self.value)
        self.headers = {}
        self.lines = lines or []
        self.content = image_bytes()
    def json(self):
        return self.value
    def iter_lines(self):
        return iter(self.lines)
    def close(self):
        pass


class ControlledHTTP:
    def __init__(self):
        self.uploads = []
        self.generations = []
        self.files = {}
        self.lock = threading.Lock()
        self.fail_put = False
        self.barrier = None

    def session(self, **_kwargs):
        remote = self
        class Session:
            def __init__(self):
                self.headers = {}
            def close(self):
                pass
            def get(self, url, **kwargs):
                if url.endswith('/download'):
                    return Reply({'download_url': 'https://synthetic-output.test/result.png'})
                if url.endswith('/backend-api/me'):
                    return Reply({'id': 'synthetic-user', 'email': 'synthetic@example.test'})
                if '/accounts/check/' in url:
                    return Reply({'accounts': {'default': {'account': {'plan_type': 'plus'}}}})
                return Reply()
            def post(self, url, **kwargs):
                headers = {**self.headers, **kwargs.get('headers', {})}
                owner = (urlsplit(url).netloc, headers.get('Authorization'), headers.get('ChatGPT-Account-ID'))
                if url.endswith('/backend-api/files'):
                    with remote.lock:
                        file_id = f'file_{len(remote.files) + 1:08d}'
                        remote.files[file_id] = owner
                        remote.uploads.append(owner)
                    return Reply({'file_id': file_id, 'upload_url': f'https://upload.test/{file_id}'})
                if url.endswith('/conversation/init'):
                    return Reply({'limits_progress': [{'feature_name': 'image_gen', 'remaining': 100}]})
                if url.endswith('/uploaded'):
                    return Reply()
                if url.endswith('/chat-requirements/prepare'):
                    return Reply({'prepare_token': 'controlled-prepare'})
                if url.endswith('/chat-requirements/finalize'):
                    return Reply({'token': 'controlled-sentinel'})
                if url.endswith('/f/conversation/prepare'):
                    return Reply({'conduit_token': 'controlled-conduit'})
                if url.endswith('/conversation'):
                    body = kwargs['json']
                    for attachment in body['messages'][0]['metadata'].get('attachments', []):
                        assert remote.files[attachment['id']] == owner, 'Upstream file crossed account/protocol host/tenant'
                    remote.generations.append(body)
                    event = {'conversation_id': 'controlled-conversation', 'message': {'author': {'role': 'tool'}, 'metadata': {'async_task_type': 'image_gen'},
                             'content': {'content_type': 'multimodal_text', 'parts': ['file-service://file_generated_00001']}}}
                    return Reply(lines=['data: ' + json.dumps(event), 'data: [DONE]'])
                raise AssertionError(f'Unexpected external request {url}')
            def put(self, url, **kwargs):
                if remote.barrier:
                    remote.barrier.wait(timeout=3)
                if remote.fail_put:
                    time.sleep(.1)
                    return Reply({'error': 'controlled upload failure'}, status=500)
                assert kwargs['data'] == image_bytes()
                return Reply()
        return Session()


def stream(cache, token='synthetic-A', host='https://chatgpt.com', tenant=None, *, messages=False):
    from services.openai_backend_api import OpenAIBackendAPI
    with OpenAIBackendAPI(token) as backend:
        backend.image_upload_cache = cache
        backend.base_url = host
        if tenant:
            backend.session.headers['ChatGPT-Account-ID'] = tenant
        if messages:
            return list(backend.stream_conversation(messages=[{'role': 'user', 'content': [
                {'type': 'image', 'data': image_bytes(), 'mime': 'image/png'}, {'type': 'text', 'text': 'reference'}]}]))
        return list(backend.stream_conversation(prompt='reference', images=[base64.b64encode(image_bytes()).decode()], system_hints=['picture_v2']))


def test_round_upload_cache_covers_picture_and_message_callers_and_isolates_auth_context(monkeypatch):
    from services import openai_backend_api as backend
    remote = ControlledHTTP()
    monkeypatch.setattr(backend.requests, 'Session', remote.session)
    cache = backend.ImageUploadCache()
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert all(pool.map(lambda _: stream(cache), range(4)))
    assert len(remote.uploads) == 1
    stream(cache, messages=True)
    assert len(remote.uploads) == 1, 'Both multimodal callers reuse the shared upload entry'
    stream(cache, token='synthetic-B')
    stream(cache, host='https://another-upstream.test')
    stream(cache, tenant='another-tenant')
    stream(backend.ImageUploadCache())
    assert len(remote.uploads) == 5, 'Different auth/host/tenant/round must upload independently'


def test_upload_failure_releases_waiters_and_other_accounts_upload_independently(monkeypatch):
    from services import openai_backend_api as backend
    remote = ControlledHTTP()
    monkeypatch.setattr(backend.requests, 'Session', remote.session)
    cache = backend.ImageUploadCache()
    remote.fail_put = True
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(stream, cache) for _ in range(4)]
        assert all(future.exception(timeout=5) is not None for future in futures)
    remote.fail_put = False
    assert stream(cache), 'A failed upload must not poison retries'
    remote.barrier = threading.Barrier(2)
    fresh = backend.ImageUploadCache()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(stream, fresh, token) for token in ('synthetic-A', 'synthetic-B')]
        assert all(future.result(timeout=5) for future in futures)


def test_http_turn_uses_real_pool_protocol_and_one_upstream_upload(environment, monkeypatch, tmp_path):
    from services import openai_backend_api as backend
    from services.protocol import conversation, openai_v1_image_edit
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    from services.config import config
    from test.test_image_references_http import upload
    from test.test_image_conversations_http import submit
    env = environment
    store = JSONStorageBackend(tmp_path / 'upstream-accounts.json')
    store.save_accounts([{'access_token': 'synthetic-A', 'type': 'plus', 'status': '正常', 'quota': 100}])
    pool = AccountService(store)
    monkeypatch.setattr(backend, 'account_service', pool)
    monkeypatch.setattr(conversation, 'account_service', pool)
    remote = ControlledHTTP()
    monkeypatch.setattr(backend.requests, 'Session', remote.session)
    for key in ('image_check_before_hit_enabled', 'image_settle_enabled', 'image_remove_conversation_always', 'image_remove_conversation_after_result'):
        monkeypatch.setitem(config.data, key, False)
    env['service'].edit_handler = openai_v1_image_edit.handle
    reference = upload(env)
    response = submit(env, referenceImages=[{'id': reference['id']}], count=4)
    assert response.status_code == 200, response.text
    route = '/api/image-conversations/' + response.json()['id']
    for _ in range(500):
        result = env['client'].get(route, headers=env['headers']).json()
        if all(image['status'] != 'loading' for image in result['turns'][0]['images']):
            break
        time.sleep(.02)
    assert all(image['status'] == 'success' for image in result['turns'][0]['images']), result
    assert len(remote.generations) == 4
    assert len(remote.uploads) == 1
    # The pool still releases the acquired slot: another real protocol round can finish.
    response = submit(env, request_id='second-round', referenceImages=[{'id': reference['id']}])
    assert response.status_code == 200
    for _ in range(500):
        result = env['client'].get(route, headers=env['headers']).json()
        if result['turns'][-1]['images'][0]['status'] != 'loading':
            break
        time.sleep(.02)
    assert result['turns'][-1]['images'][0]['status'] == 'success'
    assert len(remote.uploads) == 2, 'Upload references never leak to another round'


def test_codex_protocol_keeps_inline_inputs_without_reusing_web_file_ids(monkeypatch, tmp_path):
    import io
    from services import openai_backend_api as backend
    from services.account_service import AccountService
    from services.storage.json_storage import JSONStorageBackend
    store = JSONStorageBackend(tmp_path / 'codex-accounts.json')
    store.save_accounts([{'access_token': 'synthetic-codex', 'type': 'plus', 'source_type': 'codex', 'status': '正常', 'quota': 100}])
    monkeypatch.setattr(backend, 'account_service', AccountService(store))
    remote = ControlledHTTP()
    monkeypatch.setattr(backend.requests, 'Session', remote.session)
    bodies = []
    class Response(io.BytesIO):
        headers = {'content-type': 'application/json'}
        status = 200
    def urlopen(request, **_kwargs):
        assert request.full_url == 'https://chatgpt.com/backend-api/codex/responses'
        bodies.append(json.loads(request.data))
        return Response(json.dumps({'output': [{'type': 'image_generation_call', 'result': base64.b64encode(image_bytes()).decode()}]}).encode())
    monkeypatch.setattr(backend.urllib.request, 'urlopen', urlopen)
    with backend.OpenAIBackendAPI('synthetic-codex') as client:
        client.image_upload_cache = backend.ImageUploadCache()
        for _ in range(2):
            assert list(client.iter_codex_image_response_events('reference', [base64.b64encode(image_bytes()).decode()]))
    assert len(bodies) == 2 and not remote.uploads
    assert all(body['input'][0]['content'][1]['image_url'].startswith('data:image/png;base64,') for body in bodies)
    assert all('file_id' not in json.dumps(body) for body in bodies)


# Reuse the approved real HTTP environment, not a substitute task service.
from test.test_image_conversations_http import environment
