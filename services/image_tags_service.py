from __future__ import annotations

import json
import os
from pathlib import Path
from threading import RLock

from services.config import DATA_DIR
from services.image_storage_service import image_storage_service

TAGS_FILE = DATA_DIR / "image_tags.json"
_TAGS_LOCK = RLock()


def load_tags() -> dict[str, list[str]]:
    with _TAGS_LOCK:
        if not TAGS_FILE.exists():
            return {}
        data = json.loads(TAGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("图片标签记录格式无效")
        return data


def save_tags(data: dict[str, list[str]]) -> None:
    with _TAGS_LOCK:
        TAGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = TAGS_FILE.with_suffix(".tmp")
        try:
            with temporary.open("w", encoding="utf-8") as output:
                output.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(TAGS_FILE)
        finally:
            temporary.unlink(missing_ok=True)


def get_tags(image_rel: str) -> list[str]:
    return load_tags().get(image_rel, [])


def set_tags(image_rel: str, tags: list[str]) -> list[str]:
    with _TAGS_LOCK:
        data = load_tags()
        cleaned = list(dict.fromkeys(t.strip() for t in tags if t.strip()))
        if cleaned:
            data[image_rel] = cleaned
        else:
            data.pop(image_rel, None)
        save_tags(data)
        return cleaned


def remove_tags(image_rel: str) -> None:
    remove_tags_many([image_rel])


def remove_tags_many(image_rels) -> None:
    with _TAGS_LOCK:
        # Cleanup must report unreadable/corrupt metadata instead of treating it as empty.
        data = load_tags()
        changed = False
        for image_rel in image_rels:
            changed = data.pop(image_rel, None) is not None or changed
        if changed:
            save_tags(data)


def delete_tag(tag: str, identity: dict[str, object] | None = None) -> int:
    """从所有图片中删除指定标签，返回受影响的图片数。"""
    with _TAGS_LOCK:
        data = load_tags()
        count = 0
        for rel in list(data):
            if not image_storage_service.can_access(rel, identity):
                continue
            if tag in data[rel]:
                data[rel] = [t for t in data[rel] if t != tag]
                if not data[rel]:
                    del data[rel]
                count += 1
        if count > 0:
            save_tags(data)
        return count


def get_all_tags(identity: dict[str, object] | None = None) -> list[str]:
    data = load_tags()
    seen: set[str] = set()
    result: list[str] = []
    for rel, tags in data.items():
        if not image_storage_service.can_access(rel, identity):
            continue
        for t in tags:
            if t not in seen:
                seen.add(t)
                result.append(t)
    return result
