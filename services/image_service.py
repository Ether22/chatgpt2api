from __future__ import annotations

import io
import mimetypes
import os
import shutil
import struct
import tempfile
import threading
import time
import zipfile
import zlib
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps

from services.config import config
from services.image_storage_service import ImageStorageError, image_storage_service, is_managed_image, local_image_path
from services.storage import image_rows
from utils.business_time import beijing_iso
from utils.redact import redact
from services.image_tags_service import load_tags, remove_tags
from utils.log import logger

THUMBNAIL_SIZE = (320, 320)


def _cleanup_empty_dirs(root: Path) -> None:
    for path in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        if is_managed_image(path.relative_to(root).as_posix()):
            continue
        try:
            path.rmdir()
        except OSError:
            pass


def _safe_relative_path(path: str) -> str:
    value = str(path or "").strip().replace("\\", "/").lstrip("/")
    if not value:
        raise HTTPException(status_code=404, detail="image not found")
    parts = Path(value).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(status_code=404, detail="image not found")
    return Path(*parts).as_posix()


def _safe_image_path(relative_path: str) -> Path:
    path = local_image_path(relative_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="image not found")
    return path


def get_image_response(relative_path: str) -> FileResponse | Response:
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }
    if image_storage_service.has_local(relative_path):
        return FileResponse(_safe_image_path(relative_path), headers=headers)
    return Response(content=image_storage_service.get_bytes(relative_path), media_type=mimetypes.guess_type(relative_path)[0] or "image/png", headers=headers)


def _thumbnail_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    return config.image_thumbnails_dir / f"{rel}.png"


def thumbnail_url(base_url: str, relative_path: str) -> str:
    return f"{base_url.rstrip('/')}/image-thumbnails/{_safe_relative_path(relative_path)}"


def _image_dimensions(path: Path) -> tuple[int, int] | None:
    try:
        with Image.open(path) as image:
            return image.size
    except Exception:
        return None


def ensure_thumbnail(relative_path: str) -> Path:
    target = _thumbnail_path(relative_path)
    source_mtime = 0.0
    source: Path | None = None
    if image_storage_service.has_local(relative_path):
        source = _safe_image_path(relative_path)
        source_mtime = source.stat().st_mtime
    if target.exists() and (not source_mtime or target.stat().st_mtime >= source_mtime):
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        image_source = source if source is not None else io.BytesIO(image_storage_service.get_bytes(relative_path))
        with Image.open(image_source) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            image.save(target, format="PNG", optimize=True)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail="failed to create thumbnail") from exc
    return target


def get_thumbnail_response(relative_path: str) -> FileResponse:
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }
    return FileResponse(ensure_thumbnail(relative_path), headers=headers)


def get_image_download_response(relative_path: str) -> FileResponse:
    cors_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }
    if image_storage_service.has_local(relative_path):
        path = _safe_image_path(relative_path)
        headers = {**cors_headers, "Content-Disposition": f'attachment; filename="{path.name}"'}
        return FileResponse(path, filename=path.name, headers=headers)
    rel = _safe_relative_path(relative_path)
    headers = {
        **cors_headers,
        "Content-Disposition": f'attachment; filename="{Path(rel).name}"',
    }
    return Response(
        content=image_storage_service.get_bytes(rel),
        media_type=mimetypes.guess_type(rel)[0] or "image/png",
        headers=headers,
    )


def cleanup_image_thumbnails() -> int:
    thumbnails_root = config.image_thumbnails_dir
    removed = 0
    for path in thumbnails_root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(thumbnails_root).as_posix()
        if not rel.endswith(".png") or not image_storage_service.exists(rel[:-4]):
            path.unlink()
            removed += 1
    _cleanup_empty_dirs(thumbnails_root)
    return removed

def list_images(base_url: str, start_date: str = "", end_date: str = "", identity: dict[str, object] | None = None,
                offset: int = 0, limit: int = 12, tags: list[str] | None = None,
                paths_only: bool = False) -> dict[str, object]:
    all_tags = load_tags()
    matching_paths = {rel for rel, values in all_tags.items() if all(tag in values for tag in tags)} if tags else None
    page = image_storage_service.list_page(base_url, identity, start_date, end_date, offset, limit, matching_paths, paths_only)
    if paths_only:
        return page
    items = [
        {
            **{key: value for key, value in item.items() if key != "remote_url"},
            "url": str(item.get("url") or f"{base_url.rstrip('/')}/images/{item['path']}"),
            "thumbnail_url": thumbnail_url(base_url, str(item["path"])),
            "tags": all_tags.get(str(item["path"]), []),
        }
        for item in page["items"]
    ]
    groups: dict[str, list[dict[str, object]]] = {}
    for item in items:
        groups.setdefault(str(item["date"]), []).append(item)
    return {"items": items, "pagination": page["pagination"],
            "groups": [{"date": key, "items": value} for key, value in groups.items()]}


def delete_images(paths: list[str] | None = None, start_date: str = "", end_date: str = "", all_matching: bool = False,
                  identity: dict | None = None, tags: list[str] | None = None) -> dict[str, int]:
    from services.image_task_service import image_task_service
    targets = set(paths or [])
    if all_matching:
        targets = set()
        offset = 0
        while offset is not None:
            page = list_images("", start_date, end_date, identity, offset, 100, tags, True)
            targets.update(item["rel"] for item in page["items"])
            offset = page["pagination"]["next_offset"]
    # Validate the complete selection before making any changes.
    for path in targets:
        image_storage_service.require_owner(path, identity)
    managed = {path for path in targets if is_managed_image(path)}
    result = image_task_service.delete_gallery_results(identity, managed) if managed else {"removed": 0, "retained": 0, "pending": 0, "failed": 0}
    for batch in image_storage_service.delete_many(targets - managed):
        for item in batch.values():
            result["removed"] += int(bool(item["removed"]))
            result["failed"] += int(bool(item["error"]))
    return result


def download_images_zip(paths: list[str]) -> io.BytesIO:
    root = config.images_dir.resolve()
    buf = io.BytesIO()
    added = 0
    used_names: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in paths:
            rel = _safe_relative_path(item)
            path = (root / rel).resolve()
            payload: bytes | None = None
            try:
                path.relative_to(root)
            except ValueError:
                continue
            if path.is_file():
                payload = path.read_bytes()
            else:
                try:
                    payload = image_storage_service.get_bytes(rel)
                except Exception:
                    continue
            name = path.name
            if name in used_names:
                stem = path.stem
                suffix = path.suffix
                counter = 2
                while f"{stem}_{counter}{suffix}" in used_names:
                    counter += 1
                name = f"{stem}_{counter}{suffix}"
            used_names.add(name)
            zf.writestr(name, payload)
            added += 1
    if added == 0:
        raise HTTPException(status_code=404, detail="no images found")
    buf.seek(0)
    return buf
def storage_stats() -> dict:
    import shutil
    usage = shutil.disk_usage(config.images_dir)
    total_mb = usage.total // (1024 * 1024)
    used_mb = usage.used // (1024 * 1024)
    free_mb = usage.free // (1024 * 1024)

    image_count = 0
    image_size = 0
    for p in config.images_dir.rglob("*"):
        if p.is_file():
            image_count += 1
            image_size += p.stat().st_size

    return {
        "disk_total_mb": total_mb,
        "disk_used_mb": used_mb,
        "disk_free_mb": free_mb,
        "image_count": image_count,
        "image_size_mb": image_size // (1024 * 1024),
        "image_size_bytes": image_size,
    }


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def _compressed_png(payload: bytes) -> bytes:
    """Recompress IDAT only: pixels, palette, EXIF, color profile and all other chunks stay intact."""
    if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("PNG文件头无效")
    chunks, stream, offset = [], [], 8
    while offset < len(payload):
        length, kind = struct.unpack_from(">I4s", payload, offset)
        end = offset + length + 12
        if end > len(payload):
            raise ValueError("PNG数据不完整")
        chunk = payload[offset:end]
        if zlib.crc32(chunk[4:-4]) != struct.unpack(">I", chunk[-4:])[0]:
            raise ValueError("PNG校验失败")
        if kind == b"acTL":
            return payload  # Preserve animated PNG frame streams verbatim.
        chunks.append((kind, chunk))
        if kind == b"IDAT":
            stream.append(chunk[8:-4])
        offset = end
    if not stream or chunks[-1][0] != b"IEND":
        raise ValueError("PNG数据不完整")
    compressed = zlib.compress(zlib.decompress(b"".join(stream)), level=9)
    replacement = struct.pack(">I", len(compressed)) + b"IDAT" + compressed + struct.pack(">I", zlib.crc32(b"IDAT" + compressed))
    output = [payload[:8]]
    for kind, chunk in chunks:
        if kind == b"IDAT":
            if replacement:
                output.append(replacement)
                replacement = b""
        else:
            output.append(chunk)
    return b"".join(output)


def _maintenance_targets():
    from services.image_task_service import image_task_service
    image_storage_service.discover_local()
    with image_task_service._lock:
        eligible = image_task_service.maintenance_paths()
        items = image_rows.load(image_storage_service.index_file, "images")
        return [(rel, item) for rel, item in items.items()
                if not item.get("writing") and not item.get("deleting") and not item.get("result_hidden")
                and item.get("kind") != "reference" and "/references/" not in rel
                and (not is_managed_image(rel) or rel in eligible)]


def _restore_compression(rel, item):
    from services.image_storage_service import WebDAVClient
    path = local_image_path(rel)
    backup = path.with_name(path.name + ".compression-backup")
    if item.get("compression"):
        payload = backup.read_bytes()
        if item.get("webdav"):
            if item.get("storage_target") != image_storage_service.storage_target():
                raise ImageStorageError("压缩恢复需要原WebDAV位置，请恢复配置后重试")
            WebDAVClient(image_storage_service.settings()).put(rel, payload)
        if item.get("local"):
            _atomic_bytes(path, payload)
            os.utime(path, (item["compression"]["mtime"], item["compression"]["mtime"]))
        for thumbnail in (_thumbnail_path(rel), config.image_thumbnails_dir / rel):
            thumbnail.unlink(missing_ok=True)
        item = {**item, "size": len(payload), "writing": False, "compression_cleanup": True}
        item.pop("compression", None)
        image_rows.save(image_storage_service.index_file, {"images": {rel: item}})
    if item.get("compression_cleanup"):
        backup.unlink(missing_ok=True)
        item = {**item}
        item.pop("compression_cleanup", None)
        image_rows.save(image_storage_service.index_file, {"images": {rel: item}})
    return item


def compress_images(quality: int = 60) -> dict:
    """Lossless PNG compression with a durable original for rollback/retry across both destinations."""
    from services.image_storage_service import WebDAVClient
    from services.image_task_service import image_task_service
    saved = count = 0
    errors = []
    # Recover only previously recorded maintenance writes before selecting fresh work.
    with image_task_service._lock, image_storage_service._index_lock:
        for rel, item in image_rows.load(image_storage_service.index_file, "images").items():
            if item.get("compression") or item.get("compression_cleanup"):
                try:
                    _restore_compression(rel, item)
                except Exception as exc:
                    errors.append(f"{rel}：{redact(str(exc))}")
    for rel, _ in _maintenance_targets():
        if Path(rel).suffix.lower() != ".png":
            continue
        # ponytail: keep one file's rewrite under the existing history/index locks; split preparation if maintenance blocks submissions.
        with image_task_service._lock, image_storage_service._index_lock:
            item = image_rows.get(image_storage_service.index_file, "images", rel) or {}
            if (item.get("writing") or item.get("deleting") or item.get("result_hidden")
                    or is_managed_image(rel) and rel not in image_task_service.maintenance_paths({rel})):
                continue
            committed = False
            try:
                if item.get("webdav") and item.get("storage_target") != image_storage_service.storage_target():
                    raise ImageStorageError("远端存储位置已改变，请恢复原位置后重试")
                original = image_storage_service.get_bytes(rel)
                compressed = _compressed_png(original)
                if len(compressed) >= len(original):
                    continue
                path = local_image_path(rel)
                backup = path.with_name(path.name + ".compression-backup")
                if backup.exists():
                    raise ImageStorageError("压缩恢复文件已存在，请先完成上次维护")
                mtime = path.stat().st_mtime if path.is_file() else time.time()
                _atomic_bytes(backup, original)
                intent = {**item, "writing": True, "compression": {"mtime": mtime}}
                try:
                    image_rows.save(image_storage_service.index_file, {"images": {rel: intent}})
                except Exception:
                    backup.unlink(missing_ok=True)
                    raise
                if item.get("webdav"):
                    WebDAVClient(image_storage_service.settings()).put(rel, compressed)
                if item.get("local"):
                    _atomic_bytes(path, compressed)
                    os.utime(path, (mtime, mtime))
                for thumbnail in (_thumbnail_path(rel), config.image_thumbnails_dir / rel):
                    thumbnail.unlink(missing_ok=True)
                indexed = {**item, "size": len(compressed), "compression_cleanup": True}
                changes = {key: {**task, "updated_at": beijing_iso(), "updated_ts": time.time(), "data": [{**image, "file_size": len(compressed)}
                    if urlsplit(image.get("url", "")).path == f"/images/{rel}" else image for image in task.get("data", [])]}
                    for key, task in image_task_service._tasks.items() if rel in image_task_service._result_paths(task)}
                image_rows.save_deletions(image_task_service.path, {"tasks": changes}, image_storage_service.index_file, {rel: indexed})
                image_task_service._tasks.update(changes)
                committed = True
                count += 1
                saved += len(original) - len(compressed)
                _restore_compression(rel, indexed)
            except Exception as exc:
                errors.append(f"{rel}：{redact(str(exc))}")
                if not committed:
                    latest = image_rows.get(image_storage_service.index_file, "images", rel) or {}
                    if latest.get("compression"):
                        try:
                            _restore_compression(rel, latest)
                        except Exception as recovery:
                            errors.append(f"{rel} 恢复待重试：{redact(str(recovery))}")
    return {"compressed": count, "saved_bytes": saved, "saved_mb": saved // (1024 * 1024), "failed": len(errors), "errors": errors}


def delete_to_target(target_free_mb: int, dry_run: bool = False) -> dict:
    """Free actual local space; referenced files are never counted as freed."""
    from services.image_task_service import image_task_service
    if target_free_mb < 0:
        raise ValueError("目标空间不能为负数")
    current_free = shutil.disk_usage(config.images_dir).free // (1024 * 1024)
    removed = freed = 0
    errors = []
    candidates = []
    for rel, item in _maintenance_targets():
        path = local_image_path(rel)
        if path.suffix.lower() == ".png" and path.is_file():
            candidates.append((path.stat().st_mtime, rel, item))
    for _, rel, item in sorted(candidates):
        if current_free >= target_free_mb:
            break
        path = local_image_path(rel)
        try:
            size = path.stat().st_size
            if dry_run:
                freed += size
                removed += 1
                current_free = (shutil.disk_usage(config.images_dir).free + freed) // (1024 * 1024)
                continue
            if is_managed_image(rel):
                result = image_task_service.delete_gallery_results({"id": item["owner_id"]}, [rel], maintenance=True)
                if result["failed"]:
                    errors.append(f"{rel}：部分副本清理失败，请在删除清理中重试")
            else:
                image_storage_service.delete(rel)
            if not path.exists():
                freed += size
                removed += 1
            current_free = shutil.disk_usage(config.images_dir).free // (1024 * 1024)
        except (OSError, ValueError, HTTPException, ImageStorageError) as exc:
            errors.append(f"{rel}：{redact(str(exc))}")
    return {"removed": removed, "freed_mb": freed // (1024 * 1024), "target_free_mb": target_free_mb,
            "current_free_mb": current_free, "done": current_free >= target_free_mb, "dry_run": dry_run,
            "failed": len(errors), "errors": errors}


def cleanup_old_images(retention_days: int) -> int:
    from services.image_task_service import image_task_service, _timestamp
    cutoff = time.time() - retention_days * 86400
    removed = 0
    for rel, item in _maintenance_targets():
        path = local_image_path(rel)
        timestamp = path.stat().st_mtime if path.is_file() else _timestamp(item.get("created_at"))
        if timestamp >= cutoff:
            continue
        if is_managed_image(rel):
            result = image_task_service.delete_gallery_results({"id": item["owner_id"]}, [rel], maintenance=True)
            removed += result["removed"]
            if result["failed"]:
                logger.error({"event": "image_expiry_cleanup_failed", "path": rel})
        else:
            removed += int(image_storage_service.delete(rel))
    image_task_service.expire_results(cutoff)
    return removed


def _auto_cleanup_worker(stop_event: threading.Event) -> None:
    """后台线程：每30分钟检查存储，空间低于阈值自动清理最旧图片"""
    import shutil
    min_free_mb = getattr(config, "image_min_free_mb", None)
    if min_free_mb is None:
        min_free_mb = 500

    while not stop_event.wait(1800):  # 每30分钟
        try:
            config.cleanup_old_images()
            cleanup_image_thumbnails()
            usage = shutil.disk_usage(config.images_dir)
            free_mb = usage.free // (1024 * 1024)
            if free_mb < min_free_mb:
                logger.info({"event": "image_auto_cleanup", "free_mb": free_mb, "min_free_mb": min_free_mb})
                result = delete_to_target(min_free_mb)
                logger.info({"event": "image_auto_cleanup_done", **result})
        except Exception as exc:
            logger.error({"event": "image_auto_cleanup_failed", "error": redact(str(exc))})


def start_image_cleanup_scheduler(stop_event: threading.Event) -> threading.Thread:
    t = threading.Thread(target=_auto_cleanup_worker, args=(stop_event,), daemon=True, name="image-cleanup")
    t.start()
    return t
