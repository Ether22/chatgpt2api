"""Small durable row store shared by image history and the image index."""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
from typing import Any


@contextmanager
def connect(path: Path):
    # New stores deliberately leave the former JSON files untouched.
    path = path.with_suffix(".sqlite3")
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = None
    try:
        connection = sqlite3.connect(path, timeout=30)
        connection.execute("CREATE TABLE IF NOT EXISTS image_rows ("
                           "namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
                           "PRIMARY KEY (namespace, key))")
        with connection:
            yield connection
    except sqlite3.Error as exc:
        raise OSError(f"图片记录存储失败：{exc}") from exc
    finally:
        if connection is not None:
            connection.close()


def load(path: Path, namespace: str) -> dict[str, Any]:
    with connect(path) as connection:
        return {key: json.loads(value) for key, value in connection.execute(
            "SELECT key, value FROM image_rows WHERE namespace = ?", (namespace,))}


def get(path: Path, namespace: str, key: str) -> Any:
    with connect(path) as connection:
        row = connection.execute("SELECT value FROM image_rows WHERE namespace = ? AND key = ?",
                                 (namespace, key)).fetchone()
        return json.loads(row[0]) if row else None


def save(path: Path, changes: dict[str, dict[str, Any]]) -> None:
    with connect(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        for namespace, items in changes.items():
            for key, value in items.items():
                if value is None:
                    connection.execute("DELETE FROM image_rows WHERE namespace = ? AND key = ?", (namespace, key))
                else:
                    connection.execute(
                        "INSERT INTO image_rows VALUES (?, ?, ?) ON CONFLICT(namespace, key) "
                        "DO UPDATE SET value = excluded.value WHERE value != excluded.value",
                        (namespace, key, json.dumps(value, ensure_ascii=False, separators=(",", ":"))),
                    )
