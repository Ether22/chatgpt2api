from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from urllib.parse import quote, urlparse

from curl_cffi import requests
from fastapi import HTTPException
from PIL import Image

from services.config import DATA_DIR, config
from services.storage import image_rows
from utils.business_time import beijing_now, beijing_iso

IMAGE_INDEX_FILE = DATA_DIR / "image_index.json"
IMAGE_INDEX_LOCK = Lock()
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_IMAGE_OWNER: ContextVar[str | None] = ContextVar("image_owner", default=None)


def is_managed_image(rel: str) -> bool:
    return _safe_relative_path(rel).split("/")[0].lower() == "managed"


def _owner_namespace(owner: str) -> str:
    return hashlib.sha256(owner.encode()).hexdigest()


class ImageStorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class StoredImage:
    rel: str
    url: str
    storage: str
    size: int


def _clean(value: object) -> str:
    return str(value or "").strip()


def _now_iso() -> str:
    return beijing_iso()


def _safe_relative_path(path: str) -> str:
    value = str(path or "").strip().replace("\\", "/").lstrip("/")
    if not value:
        raise HTTPException(status_code=404, detail="image not found")
    parts = Path(value).parts
    if any(part in {"", ".", ".."} or part.rstrip(" .") != part or ":" in part for part in parts):
        raise HTTPException(status_code=404, detail="image not found")
    return Path(*parts).as_posix()


def _image_dimensions(payload: bytes) -> tuple[int, int] | None:
    try:
        with Image.open(io.BytesIO(payload)) as image:
            return image.size
    except Exception:
        return None


def _is_image_rel(path: str) -> bool:
    try:
        safe_rel = _safe_relative_path(path)
    except HTTPException:
        return False
    return Path(safe_rel).suffix.lower() in IMAGE_EXTENSIONS


def _without_windows_namespace(path: Path) -> Path:
    # realpath may preserve the extended namespace for a long, not-yet-created Windows path.
    value = str(path)
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    else:
        value = value.removeprefix("\\\\?\\")
    return Path(value)


def local_image_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    root = config.images_dir.resolve()
    path = (root / rel).resolve()
    try:
        _without_windows_namespace(path).relative_to(_without_windows_namespace(root))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="image not found") from exc
    return path


def _read_json_object(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ImageStorageError("图片索引损坏，请先修复存储") from exc
    if not isinstance(data, dict):
        raise ImageStorageError("图片索引格式错误，请先修复存储")
    return data


def write_json_atomic(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as output:
            tmp_path = Path(output.name)
            json.dump(data, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        # Windows readers may briefly deny replacement. Permanent failures retain their original cause.
        for attempt in range(5):
            try:
                tmp_path.replace(path)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.025 * (attempt + 1))
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


class WebDAVClient:
    def __init__(self, settings: dict[str, object]):
        self.url = _clean(settings.get("webdav_url")).rstrip("/")
        self.username = _clean(settings.get("webdav_username"))
        self.password = _clean(settings.get("webdav_password"))
        self.root_path = _clean(settings.get("webdav_root_path")).strip("/")
        self.session = requests.Session()

    def _auth_kwargs(self) -> dict[str, object]:
        return {"auth": (self.username, self.password)} if self.username or self.password else {}

    def _request(self, method: str, url: str, **kwargs):
        response = self.session.request(method, url, timeout=30, **self._auth_kwargs(), **kwargs)
        if response.status_code >= 400 and not (method == "MKCOL" and response.status_code in {405}):
            raise ImageStorageError(f"WebDAV {method} failed: HTTP {response.status_code}")
        return response

    def remote_url(self, rel: str = "") -> str:
        parts = [part for part in [self.root_path, _safe_relative_path(rel) if rel else ""] if part]
        encoded = "/".join(quote(part, safe="") for item in parts for part in item.split("/") if part)
        return f"{self.url}/{encoded}" if encoded else self.url

    def ensure_dirs(self, rel: str) -> None:
        parts = [part for part in [self.root_path, Path(_safe_relative_path(rel)).parent.as_posix()] if part and part != "."]
        current = self.url
        for item in "/".join(parts).split("/"):
            if not item:
                continue
            current = f"{current}/{quote(item, safe='')}"
            response = self.session.request("MKCOL", current, timeout=30, **self._auth_kwargs())
            if response.status_code in {201, 405}:
                continue
            if response.status_code >= 400:
                raise ImageStorageError(f"WebDAV MKCOL failed: HTTP {response.status_code}")

    def put(self, rel: str, payload: bytes, content_type: str = "image/png") -> str:
        self.ensure_dirs(rel)
        url = self.remote_url(rel)
        self._request("PUT", url, data=payload, headers={"Content-Type": content_type})
        return url

    def get(self, rel: str) -> bytes:
        response = self._request("GET", self.remote_url(rel))
        return bytes(response.content)

    def delete(self, rel: str) -> bool:
        response = self.session.request("DELETE", self.remote_url(rel), timeout=30, **self._auth_kwargs())
        if response.status_code in {200, 202, 204, 404}:
            return response.status_code != 404
        raise ImageStorageError(f"WebDAV DELETE failed: HTTP {response.status_code}")

    def test(self) -> dict[str, object]:
        if not self.url:
            return {"ok": False, "status": 0, "error": "WebDAV URL is required"}
        if urlparse(self.url).scheme not in {"http", "https"}:
            return {"ok": False, "status": 0, "error": "invalid WebDAV URL"}
        test_rel = ".chatgpt2api_webdav_test.txt"
        try:
            self.put(test_rel, b"chatgpt2api webdav test\n", content_type="text/plain")
            self.delete(test_rel)
            return {"ok": True, "status": 200, "error": None}
        except ImageStorageError as exc:
            return {"ok": False, "status": 0, "error": str(exc)}
        except Exception as exc:
            return {"ok": False, "status": 0, "error": str(exc) or exc.__class__.__name__}
        finally:
            self.session.close()


class ImageStorageService:
    def __init__(self, index_file: Path = IMAGE_INDEX_FILE):
        self.index_file = index_file
        self._index_lock = IMAGE_INDEX_LOCK

    @contextmanager
    def owner_scope(self, owner: str):
        token = _IMAGE_OWNER.set(owner)
        try:
            yield
        finally:
            _IMAGE_OWNER.reset(token)

    def require_owner(self, rel: str, identity: dict[str, object]) -> None:
        if not self.can_access(rel, identity) or (image_rows.get(self.index_file, "images", _safe_relative_path(rel)) or {}).get("deleting"):
            raise HTTPException(status_code=404, detail="image not found")

    def can_access(self, rel: str, identity: dict[str, object] | None = None) -> bool:
        safe_rel = _safe_relative_path(rel)
        if not is_managed_image(safe_rel):
            return True
        parts = safe_rel.split("/")
        return bool(identity and len(parts) >= 3 and parts[1] == _owner_namespace(str(identity["id"])))

    def check_writable(self, *, verify_destinations: bool = False) -> None:
        """Check known local capacity before sending a paid generation request."""
        for directory in {config.images_dir, self.index_file.parent}:
            directory.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(directory).free < 500 * 1024 * 1024:
                raise OSError("图片存储剩余空间不足 500 MB，请手动释放空间后重试")
            with tempfile.TemporaryFile(dir=directory) as probe:
                probe.write(b"image-storage-probe")
                probe.flush()
                os.fsync(probe.fileno())
        if verify_destinations:
            with self._index_lock:
                image_rows.save(self.index_file, {})
            if self.mode() in {"webdav", "both"}:
                result = WebDAVClient(self.settings()).test()
                if not result.get("ok"):
                    raise ImageStorageError(f"图片远程存储不可写：{result.get('error') or 'WebDAV probe failed'}")

    def settings(self) -> dict[str, object]:
        return config.get_image_storage_settings()

    def mode(self) -> str:
        return _clean(self.settings().get("mode")) or "local"

    def storage_target(self) -> dict[str, str]:
        settings = self.settings()
        return {key: str(settings.get(key) or "").rstrip("/")
                for key in ("webdav_url", "webdav_root_path", "webdav_username")}

    def _load_index(self) -> dict[str, dict[str, object]]:
        return image_rows.load(self.index_file, "images")

    def _load_clean_index(self) -> dict[str, dict[str, object]]:
        items = self._load_index()
        return {rel: item for rel, item in items.items() if _is_image_rel(rel)}

    def _save_index(self, items: dict[str, dict[str, object]]) -> None:
        with image_rows.connect(self.index_file) as connection:
            keys = {row[0] for row in connection.execute("SELECT key FROM image_rows WHERE namespace = 'images'")}
        image_rows.save(self.index_file, {"images": {**dict.fromkeys(keys - items.keys()), **items}})

    def _public_url(self, rel: str, base_url: str | None = None) -> str:
        settings = self.settings()
        public_base_url = _clean(settings.get("public_base_url"))
        if public_base_url and not is_managed_image(rel):
            return f"{public_base_url.rstrip('/')}/{_safe_relative_path(rel)}"
        return f"{(base_url or config.base_url).rstrip('/')}/images/{_safe_relative_path(rel)}"

    def make_relative_path(self, image_data: bytes) -> str:
        owner = _IMAGE_OWNER.get()
        if owner is not None:
            return f"managed/{_owner_namespace(owner)}/{beijing_now():%Y/%m/%d}/{uuid.uuid4().hex}.png"
        file_hash = hashlib.md5(image_data).hexdigest()
        filename = f"{int(time.time())}_{file_hash}.png"
        relative_dir = Path(beijing_now().strftime("%Y/%m/%d"))
        return f"{relative_dir.as_posix()}/{filename}"

    def make_reference_path(self, mime_type: str) -> str:
        owner = _IMAGE_OWNER.get()
        if owner is None:
            raise ValueError("reference owner is required")
        extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}[mime_type]
        return f"managed/{_owner_namespace(owner)}/references/{beijing_now():%Y/%m/%d}/{uuid.uuid4().hex}.{extension}"

    def save(self, image_data: bytes, base_url: str | None = None, *, reference: bool = False,
             reference_path: str | None = None, storage_mode: str | None = None) -> StoredImage:
        if _IMAGE_OWNER.get() is None:
            config.cleanup_old_images()
        rel = self.make_relative_path(image_data)
        mime_type = "image/png"
        if reference:
            if _IMAGE_OWNER.get() is None:
                raise ValueError("reference owner is required")
            with Image.open(io.BytesIO(image_data)) as image:
                extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp", "GIF": "gif"}.get(image.format)
                if not extension:
                    raise ValueError("参考图仅支持 PNG、JPEG、WebP、GIF")
                mime_type = Image.MIME[image.format]
                image.verify()
            rel = _safe_relative_path(reference_path) if reference_path else self.make_reference_path(mime_type)
            if not rel.startswith(f"managed/{_owner_namespace(_IMAGE_OWNER.get())}/references/"):
                raise ValueError("reference path must belong to its owner")
        mode = storage_mode or self.mode()
        if mode not in {"local", "webdav", "both"}:
            mode = "local"
        stored_local = False
        stored_webdav = False
        remote_url = ""

        if mode in {"local", "both"}:
            path = local_image_path(rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(image_data)
            stored_local = True

        if mode in {"webdav", "both"}:
            client = WebDAVClient(self.settings())
            remote_url = client.put(rel, image_data, content_type=mime_type) if reference else client.put(rel, image_data)
            stored_webdav = True

        dimensions = _image_dimensions(image_data)
        item = {
            "rel": rel,
            "path": rel,
            "name": Path(rel).name,
            "date": beijing_now().strftime("%Y-%m-%d"),
            "size": len(image_data),
            "created_at": beijing_iso(),
            "storage": "both" if stored_local and stored_webdav else ("webdav" if stored_webdav else "local"),
            "local": stored_local,
            "webdav": stored_webdav,
            "remote_url": remote_url,
            "storage_target": self.storage_target(),
        }
        if _IMAGE_OWNER.get() is not None:
            item["owner_id"] = _IMAGE_OWNER.get()
        if reference:
            item.update(kind="reference", mime_type=mime_type, created_at=beijing_iso(), date=beijing_now().strftime("%Y-%m-%d"))
        if dimensions:
            item["width"], item["height"] = dimensions
        with self._index_lock:
            image_rows.save(self.index_file, {"images": {rel: item}})
        return StoredImage(rel=rel, url=self._public_url(rel, base_url), storage=str(item["storage"]), size=len(image_data))

    def get_bytes(self, rel: str) -> bytes:
        safe_rel = _safe_relative_path(rel)
        item = image_rows.get(self.index_file, "images", safe_rel) or {}
        if not _is_image_rel(safe_rel) or item.get("deleting"):
            raise HTTPException(status_code=404, detail="image not found")
        path = local_image_path(safe_rel)
        if path.is_file():
            return path.read_bytes()
        if item.get("webdav"):
            return WebDAVClient(self.settings()).get(safe_rel)
        raise HTTPException(status_code=404, detail="image not found")

    def exists(self, rel: str) -> bool:
        safe_rel = _safe_relative_path(rel)
        if not _is_image_rel(safe_rel):
            return False
        if local_image_path(safe_rel).is_file():
            return True
        item = image_rows.get(self.index_file, "images", safe_rel) or {}
        return bool(item.get("webdav"))

    def has_local(self, rel: str) -> bool:
        safe_rel = _safe_relative_path(rel)
        return _is_image_rel(safe_rel) and local_image_path(safe_rel).is_file()

    def list_page(self, base_url: str, identity: dict[str, object], start_date: str = "", end_date: str = "",
                  offset: int = 0, limit: int = 12, matching_paths: set[str] | None = None,
                  paths_only: bool = False) -> dict[str, object]:
        if offset < 0 or not 1 <= limit <= 100:
            raise ValueError("invalid pagination")
        # Saved files are already indexed. Browsing must not reconcile every file or read image bytes.
        with self._index_lock:
            indexed = self._load_clean_index()
        items = [(rel, item) for rel, item in indexed.items()
                 if not item.get("deleting") and not item.get("result_hidden") and item.get("kind") != "reference" and "/references/" not in rel
                 and self.can_access(rel, identity)
                 and (not start_date or str(item.get("date", "")) >= start_date)
                 and (not end_date or str(item.get("date", "")) <= end_date)
                 and (matching_paths is None or rel in matching_paths)]
        items.sort(key=lambda pair: (str(pair[1].get("created_at", "")), pair[0]), reverse=True)
        total = len(items)
        return {"items": [{"rel": rel} if paths_only else {**{key: value for key, value in item.items() if key not in {"remote_url", "owner_id", "storage_target"}},
                           "rel": rel, "path": rel, "url": self._public_url(rel, base_url)}
                          for rel, item in items[offset:offset + limit]],
                "pagination": {"offset": offset, "limit": limit, "total": total,
                               "next_offset": offset + limit if offset + limit < total else None,
                               "previous_offset": max(0, offset - limit) if offset else None}}

    def list_items(self, base_url: str, start_date: str = "", end_date: str = "") -> list[dict[str, object]]:
        with self._index_lock:
            indexed = self._load_clean_index()
            root = config.images_dir
            changed = False
            for path in root.rglob("*"):
                if not path.is_file() or not _is_image_rel(path.name):
                    continue
                rel = path.relative_to(root).as_posix()
                if rel in indexed:
                    continue
                dimensions = None
                try:
                    dimensions = _image_dimensions(path.read_bytes())
                except Exception:
                    dimensions = None
                indexed[rel] = {
                    "rel": rel,
                    "path": rel,
                    "name": path.name,
                    "date": "-".join(rel.split("/")[:3]) if len(rel.split("/")) >= 4 else beijing_iso(path.stat().st_mtime)[:10],
                    "size": path.stat().st_size,
                    "created_at": beijing_iso(path.stat().st_mtime),
                    "storage": "local",
                    "local": True,
                    "webdav": False,
                    **({"width": dimensions[0], "height": dimensions[1]} if dimensions else {}),
                }
                changed = True

            items: list[dict[str, object]] = []
            for rel, item in list(indexed.items()):
                if not _is_image_rel(rel):
                    indexed.pop(rel, None)
                    changed = True
                    continue
                local = local_image_path(rel).is_file()
                webdav = bool(item.get("webdav"))
                if not local and not webdav:
                    indexed.pop(rel, None)
                    changed = True
                    continue
                storage = "both" if local and webdav else ("webdav" if webdav else "local")
                if item.get("local") != local or item.get("storage") != storage:
                    item = {
                        **item,
                        "local": local,
                        "storage": storage,
                    }
                    indexed[rel] = item
                    changed = True
                day = str(item.get("date") or "")
                if start_date and day < start_date:
                    continue
                if end_date and day > end_date:
                    continue
                items.append({
                    **item,
                    "rel": rel,
                    "path": rel,
                    "url": self._public_url(rel, base_url),
                })
            if changed:
                self._save_index(indexed)
        items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return items

    def hide_result(self, rel: str) -> None:
        """A file held only as input must not reappear in the generated gallery."""
        safe_rel = _safe_relative_path(rel)
        with self._index_lock:
            item = image_rows.get(self.index_file, "images", safe_rel)
            if item and not item.get("result_hidden"):
                image_rows.save(self.index_file, {"images": {safe_rel: {**item, "result_hidden": True}}})

    def delete(self, rel: str, *, reference_storage_mode: str | None = None) -> bool:
        from services.image_tags_service import remove_tags

        safe_rel = _safe_relative_path(rel)
        removed = False
        with self._index_lock:
            item = image_rows.get(self.index_file, "images", safe_rel) or {}
            item = {**item, "deleting": True}
            image_rows.save(self.index_file, {"images": {safe_rel: item}})
        errors = []
        path = local_image_path(safe_rel)
        try:
            removed = path.is_file()
            path.unlink(missing_ok=True)
            item["local"] = False
        except OSError as exc:
            errors.append(f"本地原图：{exc}")
        if item.get("webdav") or reference_storage_mode in {"webdav", "both"}:
            try:
                if item.get("storage_target") and item["storage_target"] != self.storage_target():
                    raise ImageStorageError("远端存储位置已变更，请恢复原位置后重试")
                removed = WebDAVClient(self.settings()).delete(safe_rel) or removed
                item["webdav"] = False
            except Exception as exc:
                errors.append(f"WebDAV 副本：{exc}")
        for thumbnail in (config.image_thumbnails_dir / f"{safe_rel}.png", config.image_thumbnails_dir / safe_rel):
            try:
                thumbnail.unlink(missing_ok=True)
            except OSError as exc:
                errors.append(f"缩略图：{exc}")
        try:
            remove_tags(safe_rel)
        except OSError as exc:
            errors.append(f"标签：{exc}")
        with self._index_lock:
            image_rows.save(self.index_file, {"images": {safe_rel: item if errors else None}})
        if errors:
            raise ImageStorageError("；".join(errors))
        return removed

    def sync_all(self) -> dict[str, int]:
        settings = self.settings()
        if self.mode() not in {"webdav", "both"}:
            raise ImageStorageError("WebDAV 图片存储未启用")
        uploaded = 0
        skipped = 0
        failed = 0
        with self._index_lock:
            items = self._load_clean_index()
            client = WebDAVClient(settings)
            for path in sorted(config.images_dir.rglob("*")):
                if not path.is_file() or not _is_image_rel(path.name):
                    continue
                rel = path.relative_to(config.images_dir).as_posix()
                item = items.get(rel, {})
                if item.get("webdav"):
                    skipped += 1
                    continue
                try:
                    payload = path.read_bytes()
                    remote_url = client.put(rel, payload)
                    dimensions = _image_dimensions(payload)
                    items[rel] = {
                        **item,
                        "rel": rel,
                        "path": rel,
                        "name": path.name,
                        "date": "-".join(rel.split("/")[:3]) if len(rel.split("/")) >= 4 else beijing_iso(path.stat().st_mtime)[:10],
                        "size": len(payload),
                        "created_at": str(item.get("created_at") or beijing_iso(path.stat().st_mtime)),
                        "storage": "both",
                        "local": True,
                        "webdav": True,
                        "remote_url": remote_url,
                        **({"width": dimensions[0], "height": dimensions[1]} if dimensions else {}),
                    }
                    uploaded += 1
                except Exception:
                    failed += 1
            self._save_index(items)
        return {"uploaded": uploaded, "skipped": skipped, "failed": failed}

    def test_webdav(self) -> dict[str, object]:
        return WebDAVClient(self.settings()).test()


image_storage_service = ImageStorageService()
