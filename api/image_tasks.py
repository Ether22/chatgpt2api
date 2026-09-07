from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, field_validator

from api.image_inputs import MAX_IMAGE_REFERENCE_BYTES, parse_image_edit_request, read_image_sources
from api.support import require_identity, resolve_image_base_url
from services.content_filter import check_request
from services.image_task_service import image_task_service
from services.image_storage_service import ImageStorageError
from services.log_service import LoggedCall
from utils.redact import redact


class ImageGenerationTaskRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    size: str | None = None
    quality: str = "auto"


class TaskQueryRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)
    versions: dict[str, str] = Field(default_factory=dict, max_length=200)

    @field_validator("ids")
    @classmethod
    def valid_ids(cls, value: list[str]) -> list[str]:
        if any(not item.strip() or len(item) > 128 for item in value):
            raise ValueError("task IDs must be nonblank and at most 128 characters")
        return value


class ResumePollRequest(BaseModel):
    extra_timeout_secs: float = Field(default=30.0, ge=5.0, le=120.0)


class ReferenceImageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)


class ImageTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=128)
    conversation_id: str | None = None
    source_entry_id: str | None = None
    source_turn_id: str | None = Field(default=None, min_length=1, max_length=128)
    rerun: bool = False
    prompt: str = Field(min_length=1)
    model: str = Field(default="gpt-image-2", min_length=1)
    size: str = Field(default="1024x1024", pattern=r"^[1-9]\d{0,4}x[1-9]\d{0,4}$")
    quality: str = "auto"
    count: int = Field(default=4, ge=1, le=100, strict=True)
    ratio: str = "1:1"
    tier: str = "1k"
    referenceImages: list[ReferenceImageRequest] = Field(default_factory=list)

    @field_validator("prompt", "request_id")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class CreateConversationRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)


class CurrentConversationRequest(BaseModel):
    conversation_id: str


class TurnVisibilityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    promptDeleted: bool | None = None
    resultsDeleted: bool | None = None
    dismissedImageIds: list[str] | None = Field(default=None, max_length=100)


class ConversationUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=200)
    turns: list[TurnVisibilityRequest] = Field(default_factory=list)


async def conversation_call(method, *args):
    try:
        return await run_in_threadpool(method, *args)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": "conversation not found"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": redact(str(exc)), "retryable": True}) from exc
    except (OSError, ImageStorageError) as exc:
        raise HTTPException(status_code=507, detail={"error": redact(f"保存失败，未能启动生成：{exc}"), "retryable": True}) from exc


def _parse_task_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-references")
    async def list_references(authorization: str | None = Header(default=None)):
        return await conversation_call(image_task_service.list_references, require_identity(authorization))

    @router.post("/api/image-references/{reference_id}/retain")
    async def retain_reference(reference_id: str, authorization: str | None = Header(default=None)):
        return await conversation_call(image_task_service.retain_reference, require_identity(authorization), reference_id)

    @router.post("/api/image-references")
    async def upload_reference(request: Request, file: UploadFile = File(...),
                               request_id: str = Form(..., min_length=1, max_length=128),
                               authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            data = await file.read(MAX_IMAGE_REFERENCE_BYTES + 1)
        finally:
            await file.close()
        if not data or len(data) > MAX_IMAGE_REFERENCE_BYTES:
            raise HTTPException(status_code=400, detail={"error": "参考图不能为空且不得超过50MB"})
        return await conversation_call(image_task_service.upload_reference, identity, request_id, data,
                                       file.filename or "image.png", resolve_image_base_url(request))

    @router.delete("/api/image-references/{reference_id}")
    async def release_reference(reference_id: str, authorization: str | None = Header(default=None)):
        return await conversation_call(image_task_service.release_reference, require_identity(authorization), reference_id)

    @router.delete("/api/image-references/uploads/{request_id}")
    async def cancel_reference_upload(request_id: str, authorization: str | None = Header(default=None)):
        return await conversation_call(image_task_service.cancel_reference_upload, require_identity(authorization), request_id)

    @router.get("/api/image-conversations")
    async def list_conversations(authorization: str | None = Header(default=None),
                                 offset: int = Query(default=0, ge=0), limit: int = Query(default=30, ge=1, le=100)):
        return await conversation_call(image_task_service.list_conversations, require_identity(authorization), offset, limit)

    @router.post("/api/image-conversations")
    async def create_conversation(body: CreateConversationRequest, authorization: str | None = Header(default=None)):
        return await conversation_call(image_task_service.create_conversation, require_identity(authorization), body.request_id)

    @router.put("/api/image-conversations/current")
    async def select_conversation(body: CurrentConversationRequest, authorization: str | None = Header(default=None)):
        await conversation_call(image_task_service.set_current_conversation, require_identity(authorization), body.conversation_id)
        return {"ok": True}

    @router.post("/api/image-conversations/turns")
    async def submit_turn(body: ImageTurnRequest, request: Request, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        await filter_or_log(LoggedCall(identity, "/api/image-conversations/turns", body.model, "生图轮次", request_text=body.prompt), body.prompt)
        return await conversation_call(image_task_service.submit_turn, identity, body.model_dump(), resolve_image_base_url(request))

    @router.get("/api/image-conversations/{conversation_id}")
    async def get_conversation(conversation_id: str, authorization: str | None = Header(default=None),
                               offset: int | None = Query(default=None, ge=0), limit: int = Query(default=2, ge=1, le=10),
                               turn_id: str = "", image_id: str = "", navigation: bool = False):
        return await conversation_call(image_task_service.get_conversation, require_identity(authorization), conversation_id,
                                       offset, limit, turn_id, image_id, navigation)

    @router.patch("/api/image-conversations/{conversation_id}")
    async def update_conversation(conversation_id: str, body: ConversationUpdateRequest, background: BackgroundTasks, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        result = await conversation_call(image_task_service.update_conversation, identity, conversation_id, body.model_dump(exclude_none=True))
        if any(turn.resultsDeleted for turn in body.turns):
            background.add_task(image_task_service.cleanup_results, identity)
        return result

    @router.delete("/api/image-conversations/{conversation_id}")
    async def delete_conversation(conversation_id: str, background: BackgroundTasks, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        await conversation_call(image_task_service.delete_conversations, identity, conversation_id)
        background.add_task(image_task_service.cleanup_results, identity)
        return {"ok": True}

    @router.delete("/api/image-conversations/{conversation_id}/turns/{turn_id}/images/{task_id}")
    async def delete_result(conversation_id: str, turn_id: str, task_id: str, background: BackgroundTasks,
                            authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        result = await conversation_call(image_task_service.delete_result, identity, conversation_id, turn_id, task_id)
        background.add_task(image_task_service.cleanup_result, identity, task_id)
        return result

    @router.delete("/api/image-conversations")
    async def clear_conversations(background: BackgroundTasks, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        await conversation_call(image_task_service.delete_conversations, identity)
        background.add_task(image_task_service.cleanup_results, identity)
        return {"ok": True}

    @router.get("/api/image-cleanups")
    async def list_cleanups(authorization: str | None = Header(default=None), offset: int = Query(default=0, ge=0),
                            limit: int = Query(default=50, ge=1, le=100)):
        return await conversation_call(image_task_service.list_cleanups, require_identity(authorization), offset, limit)

    @router.post("/api/image-cleanups/{task_id}/retry")
    async def retry_cleanup(task_id: str, background: BackgroundTasks, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        await conversation_call(image_task_service.retry_cleanup, identity, task_id)
        background.add_task(image_task_service.cleanup_result, identity, task_id)
        return {"ok": True}

    @router.get("/api/image-tasks")
    async def list_image_tasks(ids: str = Query(default=""), authorization: str | None = Header(default=None)):
        return await run_in_threadpool(image_task_service.list_tasks, require_identity(authorization), _parse_task_ids(ids))

    @router.post("/api/image-tasks/query")
    async def query_image_tasks(body: TaskQueryRequest, authorization: str | None = Header(default=None)):
        return await run_in_threadpool(image_task_service.list_tasks, require_identity(authorization), body.ids, body.versions)

    @router.get("/api/image-conversations/{conversation_id}/metadata")
    async def conversation_metadata(conversation_id: str, authorization: str | None = Header(default=None)):
        return await conversation_call(image_task_service.conversation_metadata, require_identity(authorization), conversation_id)

    @router.post("/api/image-tasks/generations")
    async def create_generation_task(
        body: ImageGenerationTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/generations", body.model, "文生图任务", request_text=body.prompt), body.prompt)
        try:
            return await run_in_threadpool(
                image_task_service.submit_generation,
                identity,
                client_task_id=body.client_task_id,
                prompt=body.prompt,
                model=body.model,
                size=body.size,
                quality=body.quality,
                base_url=resolve_image_base_url(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": redact(str(exc)), "retryable": True}) from exc
        except (OSError, ImageStorageError) as exc:
            raise HTTPException(status_code=507, detail={"error": redact(f"保存失败，未能启动生成：{exc}"), "retryable": True}) from exc

    @router.post("/api/image-tasks/edits")
    async def create_edit_task(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        payload, image_sources, mask_sources = await parse_image_edit_request(request)
        client_task_id = str(payload.get("client_task_id") or "").strip()
        if not client_task_id:
            raise HTTPException(status_code=400, detail={"error": "client_task_id is required"})
        prompt = str(payload["prompt"])
        model = str(payload["model"])
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/edits", model, "图生图任务", request_text=prompt), prompt)
        reference_reader = lambda reference_id: image_task_service.read_reference(identity, reference_id)
        images = await read_image_sources(image_sources, reference_reader=reference_reader)
        masks = await read_image_sources(mask_sources, reference_reader=reference_reader) if mask_sources else None
        try:
            return await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=client_task_id,
                prompt=prompt,
                model=model,
                size=payload["size"],
                quality=payload["quality"],
                base_url=resolve_image_base_url(request),
                images=images,
                masks=masks,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": redact(str(exc)), "retryable": True}) from exc
        except (OSError, ImageStorageError) as exc:
            raise HTTPException(status_code=507, detail={"error": redact(f"保存失败，未能启动生成：{exc}"), "retryable": True}) from exc

    @router.post("/api/image-tasks/{task_id}/resume-poll")
    async def resume_image_poll(
        task_id: str,
        body: ResumePollRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                image_task_service.resume_poll,
                identity,
                task_id,
                body.extra_timeout_secs,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": redact(str(exc)), "retryable": True}) from exc

    return router
