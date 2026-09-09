"""Measure metadata-only reads over both real-file workloads without opening result bytes."""
import importlib.util
import json
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api import image_tasks, support, system

spec = importlib.util.spec_from_file_location("volume", ROOT / ".scratch/image-workflow-upgrade-delivery/reports/13-benchmark.py")
volume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volume)
results = {}
for dense in (False, True):
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        service = volume.seed(directory, dense=dense)
        identity = {"id": "benchmark-owner", "role": "admin"}
        app = FastAPI()
        app.include_router(image_tasks.create_router())
        app.include_router(system.create_router("controlled-volume"))
        client = TestClient(app)
        with patch.object(image_tasks, "image_task_service", service), \
             patch.object(image_tasks, "require_identity", return_value=identity), \
             patch.object(support, "require_identity", return_value=identity):
            with volume.file_cost(directory) as cost:
                start = time.perf_counter()
                offset, pages, images, byte_count = 0, 0, [], 0
                while offset is not None:
                    reply = client.get(f"/api/image-conversations/gallery-0?offset={offset}&limit=10")
                    assert reply.status_code == 200, reply.text
                    data = reply.json()
                    assert len(data["turns"]) <= 10
                    images.extend(image["id"] for turn in data["turns"] for image in turn["images"])
                    pages += 1
                    byte_count += len(reply.content)
                    offset = data["pagination"]["next_offset"]
                for offset in range(0, len(images), 200):
                    assert client.post("/api/image-tasks/query", json={"ids": images[offset:offset + 200]}).status_code == 200
                assert client.get("/api/images?limit=12", headers={"Authorization": "Bearer controlled"}).status_code == 200
                elapsed = (time.perf_counter() - start) * 1000
            assert len(images) == len(set(images)) == 1600 and cost["image_reads"] == 0
            results["dense" if dense else "normal"] = {"actual_png_files": 3200, "current_images": len(images),
                "detail_pages": pages, "detail_bytes": byte_count, "ms": round(elapsed, 2), **cost}
        service.shutdown()
target = ROOT / ".scratch/account-management-followup/evidence/all-rounds/read-cost.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
