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
        _write_rows(connection, "main.image_rows", changes)


def save_result_deletion(path: Path, task_key: str, task: dict[str, Any],
                         index_path: Path, images: dict[str, Any]) -> None:
    """SQLite's attached rollback-journal databases commit the tombstone and visibility together."""
    with connect(path) as connection:
        connection.execute("ATTACH DATABASE ? AS result_index", (str(index_path.with_suffix(".sqlite3")),))
        databases = {name: filename for _, name, filename in connection.execute("PRAGMA database_list")}
        for database in ("main", "result_index"):
            journal = connection.execute(f"PRAGMA {database}.journal_mode").fetchone()[0]
            if not databases[database] or journal not in {"delete", "truncate", "persist"}:
                raise OSError("图片删除需要磁盘 rollback journal；当前数据库模式不支持跨库原子提交")
        connection.execute("CREATE TABLE IF NOT EXISTS result_index.image_rows ("
                           "namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
                           "PRIMARY KEY (namespace, key))")
        connection.execute("BEGIN IMMEDIATE")
        _write_rows(connection, "main.image_rows", {"tasks": {task_key: task}})
        _write_rows(connection, "result_index.image_rows", {"images": images})


def _write_rows(connection, table: str, changes: dict[str, dict[str, Any]]) -> None:
    for namespace, items in changes.items():
        for key, value in items.items():
            if value is None:
                connection.execute(f"DELETE FROM {table} WHERE namespace = ? AND key = ?", (namespace, key))
            else:
                connection.execute(
                    f"INSERT INTO {table} VALUES (?, ?, ?) ON CONFLICT(namespace, key) "
                    "DO UPDATE SET value = excluded.value WHERE value != excluded.value",
                    (namespace, key, json.dumps(value, ensure_ascii=False, separators=(",", ":"))),
                )
