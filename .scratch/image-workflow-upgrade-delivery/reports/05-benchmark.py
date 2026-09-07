"""3200 synthetic results; measure real SQLite writes through public services."""
from pathlib import Path
import sys
import os
ROOT = Path(__file__).resolve().parents[3]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
os.environ["CHATGPT2API_AUTH_KEY"] = "chatgpt2api"

import hashlib
import json
import sqlite3
import statistics
import tempfile
import threading
import time
from unittest.mock import patch
from services import config as settings
from services.image_storage_service import image_storage_service
from services.image_task_service import ImageTaskService
from services.storage import image_rows
from test.test_image_conversations_http import image_bytes
from test.test_image_task_service import wait_for_task
from utils.business_time import beijing_iso


def measure(operation):
    writes.clear()
    started = time.perf_counter()
    operation()
    return {"ms": round((time.perf_counter() - started) * 1000, 2),
            "upsert_rows": len(writes), "json_bytes": sum(writes)}


writes = []
original_connect = sqlite3.connect
class MeasuredConnection(sqlite3.Connection):
    def execute(self, sql, parameters=()):
        if sql.startswith("INSERT INTO image_rows"):
            writes.append(len(parameters[2].encode("utf-8")))
        return super().execute(sql, parameters)


with tempfile.TemporaryDirectory(prefix="image-task05-benchmark-", ignore_cleanup_errors=True) as directory:
    root = Path(directory)
    with patch.object(settings, "DATA_DIR", root), patch.object(image_storage_service, "index_file", root / "index.sqlite3"), \
         patch.dict(settings.config.data, {"image_storage": {"mode": "local"}}):
        identity = {"id": "benchmark-owner", "name": "Synthetic", "role": "admin"}
        owner = identity["id"]
        stamp = beijing_iso()
        prefix = f"managed/{hashlib.sha256(owner.encode()).hexdigest()}/2026/09/08"
        pixels = image_bytes()
        tasks, images, turns = {}, {}, []
        for index in range(3200):
            task_id = f"seed-{index}"
            rel = f"{prefix}/{task_id}.png"
            path = settings.config.images_dir / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(pixels)
            tasks[f"{owner}:{task_id}"] = {"id": task_id, "owner_id": owner, "managed": True,
                "status": "success", "dispatch_state": "complete", "mode": "generate", "model": "gpt-image-2",
                "prompt": "Synthetic prompt " * 20, "size": "1024x1024", "quality": "high",
                "created_at": stamp, "updated_at": stamp, "data": [{"url": f"http://test/images/{rel}"}]}
            images[rel] = {"rel": rel, "path": rel, "name": path.name, "date": "2026-09-08", "created_at": stamp,
                           "size": len(pixels), "storage": "local", "local": True, "webdav": False,
                           "owner_id": owner, "width": 24, "height": 16}
        for index in range(160):
            turns.append({"id": f"turn-{index}", "sourceEntryId": "source", "request_id": f"seed-{index}",
                          "prompt": "Synthetic prompt " * 20, "mode": "generate", "model": "gpt-image-2",
                          "createdAt": stamp, "size": "1024x1024", "quality": "high", "count": 20,
                          "referenceImages": [], "task_ids": [f"seed-{n}" for n in range(index * 20, (index + 1) * 20)]})
        conversation = {"id": "history", "owner_id": owner, "title": "3200 results", "createdAt": stamp,
                        "updatedAt": stamp, "sourceEntries": [{"id": "source", "name": "Synthetic"}], "turns": turns}
        image_rows.save(root / "tasks.sqlite3", {"tasks": tasks, "conversations": {"history": conversation}, "current": {owner: "history"}})
        image_rows.save(root / "index.sqlite3", {"images": images})
        release, ready, run_progress, progressed = (threading.Event() for _ in range(4))
        def upstream(payload):
            ready.set()
            assert run_progress.wait(20)
            for index in range(10):
                payload["progress_callback"](f"step-{index}")
            for _ in range(100):
                payload["progress_callback"]("step-9")
            progressed.set()
            assert release.wait(20)
            return {"data": [{"url": "https://controlled.test/result.png"}]}
        service = ImageTaskService(root / "tasks.sqlite3", generation_handler=upstream)
        service.submit_generation(identity, client_task_id="measured", prompt="measured", model="gpt-image-2", size="1024x1024")
        assert ready.wait(10)
        with patch.object(sqlite3, "connect", lambda path, **kwargs: original_connect(path, factory=MeasuredConnection, **kwargs)):
            result = {"seed_results": 3200, "shape": "160 rounds x 20 images",
                      "task_database_bytes": (root / "tasks.sqlite3").stat().st_size,
                      "index_database_bytes": (root / "index.sqlite3").stat().st_size}
            result["select_current"] = measure(lambda: service.set_current_conversation(identity, "history"))
            result["poll_100_reads"] = measure(lambda: [service.list_tasks(identity, ["measured"]) for _ in range(100)])
            def progress():
                run_progress.set()
                assert progressed.wait(10)
            result["10_changed_plus_100_unchanged_progress_events"] = measure(progress)
            with image_storage_service.owner_scope(owner):
                samples = [measure(lambda: image_storage_service.save(pixels, "http://test")) for _ in range(10)]
            result["save_image_at_3200_results"] = {"median_ms": round(statistics.median(item["ms"] for item in samples), 2),
                "rows_per_image": [item["upsert_rows"] for item in samples],
                "json_bytes_per_image": [item["json_bytes"] for item in samples]}
        release.set()
        wait_for_task(service, identity, "measured", "success", timeout=10)
        service.shutdown(timeout=5)
        restored = ImageTaskService(root / "tasks.sqlite3")
        assert len(restored.list_tasks(identity, [])["items"]) == 3201
        assert len(image_storage_service.list_items("http://test")) == 3210
        output = Path(__file__).with_name("05-benchmark-stage-a.json")
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
