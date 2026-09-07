from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field
from typing import Annotated

from api.support import require_identity, resolve_image_base_url
from services.image_import_service import ImportConflict, image_import_service
from services.image_storage_service import ImageStorageError

RequestId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"\S")]


class ImportMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: RequestId
    version: int = Field(ge=0, strict=True)


class ReferenceReservation(ImportMutation):
    name: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0, le=50 * 1024 * 1024, strict=True)


class ClearImports(ImportMutation):
    upload_ids: list[RequestId] = Field(default_factory=list, max_length=10000)


class CandidateCorrection(ImportMutation):
    md_version: int = Field(ge=0, strict=True)
    changes: dict = Field(min_length=1, max_length=7)


async def import_call(method, *args):
    try:
        return await run_in_threadpool(method, *args)
    except ImportConflict as exc:
        raise HTTPException(409, detail={"error": str(exc)}) from exc
    except KeyError as exc:
        raise HTTPException(404, detail={"error": "素材不存在"}) from exc
    except ValueError as exc:
        raise HTTPException(400, detail={"error": str(exc)}) from exc
    except (OSError, ImageStorageError) as exc:
        raise HTTPException(507, detail={"error": f"素材保存或清理未完成，请重试：{exc}"}) from exc


def create_router():
    router = APIRouter()

    @router.get("/api/image-imports")
    async def get_imports(authorization: str | None = Header(default=None)):
        return await import_call(image_import_service.get, require_identity(authorization))

    @router.post("/api/image-imports/references")
    async def reserve_reference(body: ReferenceReservation, authorization: str | None = Header(default=None)):
        return await import_call(image_import_service.reserve_reference, require_identity(authorization),
                                 body.request_id, body.version, body.name, body.size)

    @router.patch("/api/image-imports/candidates/{key}")
    async def correct_candidate(key: str, body: CandidateCorrection, authorization: str | None = Header(default=None)):
        return await import_call(image_import_service.correct_candidate, require_identity(authorization),
                                 body.request_id, body.version, body.md_version, key, body.changes)

    @router.put("/api/image-imports/references/{upload_id}")
    async def upload_reference(upload_id: RequestId, request: Request, file: UploadFile = File(...),
                               authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            data = await file.read(50 * 1024 * 1024 + 1)
        finally:
            await file.close()
        return await import_call(image_import_service.upload_reference, identity, upload_id, file.filename, data,
                                 resolve_image_base_url(request))

    @router.delete("/api/image-imports/references/{upload_id}")
    async def remove_reference(upload_id: RequestId, body: ImportMutation, authorization: str | None = Header(default=None)):
        return await import_call(image_import_service.remove_reference, require_identity(authorization),
                                 body.request_id, body.version, upload_id)

    @router.delete("/api/image-imports")
    async def clear_imports(body: ClearImports, authorization: str | None = Header(default=None)):
        return await import_call(image_import_service.clear, require_identity(authorization),
                                 body.request_id, body.version, body.upload_ids)

    @router.put("/api/image-imports/md")
    async def replace_md(file: UploadFile = File(...),
                         request_id: str = Form(..., min_length=1, max_length=128, pattern=r"\S"),
                         version: int = Form(..., ge=0), authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            data = await file.read(5 * 1024 * 1024 + 1)
        finally:
            await file.close()
        return await import_call(image_import_service.replace_md, identity, request_id, version, file.filename, data)

    return router
