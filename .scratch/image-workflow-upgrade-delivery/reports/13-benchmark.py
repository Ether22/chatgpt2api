"""Synthetic persisted 3,200-result workload; never accesses deployment data."""
import hashlib
import io
import json
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api import image_tasks, support, system
from services import config as config_module, image_storage_service as storage_module, image_tags_service
from services.image_task_service import ImageTaskService
from services.storage import image_rows


def seed(directory, owner="benchmark-owner", dense=False):
    config_module.DATA_DIR = directory
    storage_module.image_storage_service.index_file = directory / "image_index.json"
    image_tags_service.TAGS_FILE = directory / "tags.json"
    image_tags_service.TAGS_FILE.write_text("{}")
    namespace = hashlib.sha256(owner.encode()).hexdigest()
    tasks, conversations, index = [], {}, {}
    output = io.BytesIO()
    Image.new("RGB", (480, 320), "#90cfbc").save(output, format="PNG")
    pixels = output.getvalue()
    for conv in range(2):
        cid = f"gallery-{conv}"
        turns, sources = [], []
        per_turn = 100 if dense else 20
        for number in range(1600 // per_turn):
            tid = f"{cid}-turn-{number:03}"
            source = f"{cid}-source-{number:03}"
            created = f"2026-09-08T12:{number // 60:02}:{number % 60:02}+08:00"
            ids = []
            for n in range(per_turn):
                task_id = f"{tid}-{n}"
                rel = f"managed/{namespace}/2026/09/08/{task_id}.png"
                path = directory / "images" / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(pixels)
                index[rel] = dict(rel=rel, path=rel, name=path.name, date="2026-09-08", size=len(pixels),
                                  created_at=created, storage="local", local=True, webdav=False,
                                  owner_id=owner, kind="result", width=480, height=320)
                ids.append(task_id)
                tasks.append(dict(id=task_id, owner_id=owner, managed=True, status="success", mode="generate",
                                  image_conversation_id=cid, turn_id=tid, source_entry_id=source,
                                  created_at=created, updated_at=created, model="gpt-image-2", size="1024x1024",
                                  data=[{"url": f"/images/{rel}"}]))
            sources.append(dict(id=source, name=f"Source {number}"))
            turns.append(dict(id=tid, sourceEntryId=source, prompt=f"Synthetic round {number}: " + "long prompt " * 100,
                              count=per_turn, task_ids=ids, request_id=tid, referenceImages=[], mode="generate",
                              model="gpt-image-2", quality="auto", size="1024x1024", ratio="1:1", tier="1k", createdAt=created))
        conversations[cid] = dict(id=cid, owner_id=owner, title=f"Large gallery {conv}", createdAt=created,
                                  updatedAt=created, turns=turns, sourceEntries=sources)
    image_rows.save(directory / "tasks.json", {"tasks": {f"{owner}:{task['id']}": task for task in tasks},
                                               "conversations": conversations, "current": {owner: "gallery-0"}})
    image_rows.save(directory / "image_index.json", {"images": index})
    return ImageTaskService(directory / "tasks.json")


@contextmanager
def file_cost(directory):
    """Observe actual filesystem operations for diagnostics, without replacing their behavior."""
    cost = {"directory_scans": 0, "file_stats": 0, "image_reads": 0, "json_reads": 0, "atomic_writes": 0, "written_bytes": 0}
    originals = {name: getattr(Path, name) for name in ("stat", "rglob", "read_bytes", "read_text", "replace")}
    def observed(name, field):
        def call(path, *args, **kwargs):
            if str(path).startswith(str(directory)):
                cost[field] += 1
                if name == "replace":
                    cost["written_bytes"] += originals["stat"](path).st_size
            return originals[name](path, *args, **kwargs)
        return call
    with patch.object(Path, "stat", observed("stat", "file_stats")), patch.object(Path, "rglob", observed("rglob", "directory_scans")), \
         patch.object(Path, "read_bytes", observed("read_bytes", "image_reads")), patch.object(Path, "read_text", observed("read_text", "json_reads")), \
         patch.object(Path, "replace", observed("replace", "atomic_writes")):
        yield cost


def measure(label):
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        service = seed(directory, dense=label == "dense")
        app = FastAPI()
        app.include_router(image_tasks.create_router())
        app.include_router(system.create_router("benchmark"))
        identity = {"id": "benchmark-owner", "role": "admin"}
        results = {}
        with patch.object(image_tasks, "image_task_service", service), patch.object(support, "require_identity", return_value=identity), \
             patch.object(image_tasks, "require_identity", return_value=identity), patch.object(system, "require_admin", return_value=identity):
            client = TestClient(app)
            for name, url in [("history", "/api/image-conversations"), ("detail", "/api/image-conversations/gallery-0"),
                              ("gallery_cold", "/api/images?limit=12"), ("gallery_warm", "/api/images?limit=12&offset=12")]:
                with file_cost(directory) as cost:
                    started = time.perf_counter()
                    response = client.get(url)
                    elapsed = round((time.perf_counter()-started)*1000, 2)
                assert response.status_code == 200, response.text
                results[name] = {"ms": elapsed, "bytes": len(response.content), **cost}
            if label == "dense":
                for limit in (5, 10):
                    started = time.perf_counter()
                    response = client.get(f"/api/image-conversations/gallery-0?offset=0&limit={limit}")
                    results[f"dense_{limit}_turns"] = {"ms": round((time.perf_counter()-started)*1000, 2), "bytes": len(response.content),
                                                      "images": sum(len(turn["images"]) for turn in response.json()["turns"])}
            with file_cost(directory) as cost:
                from services.image_service import cleanup_image_thumbnails
                started = time.perf_counter()
                config_module.config.cleanup_old_images()
                cleanup_image_thumbnails()
                storage_module.image_storage_service.list_items("")
                results["legacy_scan_diagnostic"] = {"ms": round((time.perf_counter()-started)*1000, 2), **cost}
            started = time.perf_counter()
            service.set_current_conversation(identity, "gallery-1")
            results["select_save"] = {"ms": round((time.perf_counter()-started)*1000, 2), "snapshot_bytes": service.path.stat().st_size}
            started = time.perf_counter()
            with storage_module.image_storage_service.owner_scope(identity["id"]):
                storage_module.image_storage_service.save((directory / "images" / next(iter(image_rows.load(directory / "image_index.json", "images")))).read_bytes())
            results["image_save"] = {"ms": round((time.perf_counter()-started)*1000, 2), "index_bytes": (directory / "image_index.sqlite3").stat().st_size}
        target = Path(__file__).parent / "13-evidence"
        target.mkdir(exist_ok=True)
        (target / f"{label}.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    measure(sys.argv[1])
