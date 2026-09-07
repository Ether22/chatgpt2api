"""Inject disk commit failures without replacing the task or storage service."""
from pathlib import Path
import sqlite3


def deny_sqlite_commits(monkeypatch, path, message, *, after=0):
    original = sqlite3.connect
    target = Path(path).with_suffix(".sqlite3")
    attempts = 0

    class DiskFailure(sqlite3.Connection):
        def __exit__(self, error_type, error, traceback):
            nonlocal attempts
            if error_type is None and self.in_transaction:
                attempts += 1
                if attempts > after:
                    self.rollback()
                    raise PermissionError(message)
            return super().__exit__(error_type, error, traceback)

    def connect(database, *args, **kwargs):
        if Path(database) == target:
            kwargs["factory"] = DiskFailure
        return original(database, *args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", connect)
