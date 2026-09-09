import base64
import copy
import io
import os
import struct
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from PIL import Image, PngImagePlugin

from services.config import config
from services.image_service import compress_images, delete_to_target, ensure_thumbnail, _compressed_png
from services.image_storage_service import image_storage_service as storage, local_image_path
from services.storage import image_rows
from test.test_image_conversations_http import environment, image_bytes, submit, wait_for_history


def large_png():
    output = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    info.add_text("Description", "keep the original metadata")
    Image.new("RGBA", (512, 512), (40, 50, 60, 120)).save(output, format="PNG", compress_level=0, pnginfo=info, dpi=(144, 144))
    return output.getvalue()


def generated(env, count=1, payload=None):
    if payload:
        env["service"].generation_handler = lambda _request: {"data": [{"b64_json": base64.b64encode(payload).decode()}]}
    assert submit(env, count=count).status_code == 200
    return wait_for_history(env, count)["items"][0]["turns"][0]["images"]


def relative(image):
    return urlsplit(image["url"]).path.removeprefix("/images/")


def hold(env, image):
    rel = relative(image)
    env["service"]._references["held-result"] = {
        "id": "held-result", "owner_id": env["owner"]["id"], "path": rel, "url": image["url"],
        "name": "held.png", "type": "image/png", "size": local_image_path(rel).stat().st_size,
        "input_scopes": ["ordinary"], "turn_ids": [], "state": "ready", "upload_scope": "ordinary", "request_id": "held",
    }
    env["service"]._save_locked(references=["held-result"])


def test_refresh_discovers_manual_public_images_and_never_reads_known_or_managed_files(environment, monkeypatch):
    env = environment
    folder = config.images_dir / "manual"
    folder.mkdir()
    for name in ("one.png", "two.png"):
        (folder / name).write_bytes(image_bytes())
    unowned = config.images_dir / "managed" / "manual-private.png"
    unowned.parent.mkdir()
    unowned.write_bytes(image_bytes())
    (folder / "partial.png").write_bytes(b"partly copied")
    response = env["client"].get("/api/images?limit=1", headers=env["headers"])
    assert response.status_code == 200 and response.json()["pagination"]["total"] == 2
    assert len(response.json()["items"]) == 1
    assert not image_rows.get(storage.index_file, "images", "managed/manual-private.png")
    (folder / "partial.png").unlink()
    def no_read(*args, **kwargs):
        raise AssertionError("known image bytes must not be read during pagination")
    monkeypatch.setattr(Image, "open", no_read)
    assert env["client"].get("/api/images?offset=1&limit=1", headers=env["headers"]).status_code == 200


def test_gallery_range_deletion_is_owner_scoped_and_retains_references(environment):
    env = environment
    images = generated(env, 3)
    hold(env, images[0])
    rels = [relative(image) for image in images]
    for rel in rels:
        env["client"].post("/api/images/tags", headers=env["headers"], json={"path": rel, "tags": ["selected"]})
    assert env["client"].post("/api/images/delete", headers=env["other"], json={"paths": [rels[0], rels[1]]}).status_code == 404
    assert env["client"].post("/api/images/delete", headers=env["other"], json={"all_matching": True}).json()["removed"] == 0
    response = env["client"].post("/api/images/delete", headers=env["headers"], json={"all_matching": True, "tags": ["selected"]})
    assert response.status_code == 200, response.text
    assert response.json() == {"removed": 3, "retained": 1, "pending": 0, "failed": 0}
    assert local_image_path(rels[0]).is_file() and not local_image_path(rels[1]).exists()
    assert env["client"].get("/api/images", headers=env["headers"]).json()["items"] == []
    assert all(task["result_deleted"] for task in env["service"]._tasks.values())
    assert len(env["calls"]) == 3


def test_low_space_uses_actual_free_space_and_skips_references_and_unknown_attempts(environment, monkeypatch):
    env = environment
    images = generated(env, 4, large_png())
    hold(env, images[0])
    paths = [local_image_path(relative(image)) for image in images]
    owner = env["owner"]["id"]
    env["service"]._update_task(f"{owner}:{images[1]['id']}", status="error", dispatch_state="unknown")
    for index, path in enumerate(paths):
        os.utime(path, (index + 1, index + 1))
    original = sum(path.stat().st_size for path in paths)
    def usage(_path):
        return type("Usage", (), {"free": original - sum(path.stat().st_size for path in paths if path.exists())})()
    monkeypatch.setattr("services.image_service.shutil.disk_usage", usage)
    preview = delete_to_target(1, dry_run=True)
    assert preview["removed"] == 1 and all(path.exists() for path in paths)
    result = delete_to_target(1)
    assert result["done"] and result["removed"] == 1 and result["current_free_mb"] >= 1
    assert paths[0].exists() and paths[1].exists() and not paths[2].exists() and paths[3].exists()
    for task in env["service"]._tasks.values():
        if task["id"] != images[1]["id"]:
            task["updated_at"] = "2000-01-01T00:00:00+00:00"
    config.cleanup_old_images()
    assert paths[0].exists() and paths[1].exists() and not paths[3].exists()


def test_lossless_compression_keeps_non_idat_chunks_pixels_and_updates_sizes(environment):
    env = environment
    original = large_png()
    images = generated(env, 2, original)
    hold(env, images[1])
    rel = relative(images[0])
    thumb = ensure_thumbnail(rel)
    assert thumb.is_file()
    result = compress_images()
    assert result["compressed"] == 1 and result["failed"] == 0
    compressed = local_image_path(rel).read_bytes()
    assert len(compressed) < len(original)
    def chunks(payload):
        index, result = 8, []
        while index < len(payload):
            size, kind = struct.unpack_from(">I4s", payload, index)
            end = index + 12 + size
            if kind != b"IDAT":
                result.append(payload[index:end])
            index = end
        return result
    assert chunks(compressed) == chunks(original)
    assert Image.open(io.BytesIO(compressed)).tobytes() == Image.open(io.BytesIO(original)).tobytes()
    assert not thumb.exists() and local_image_path(relative(images[1])).read_bytes() == original
    assert image_rows.get(storage.index_file, "images", rel)["size"] == len(compressed)
    task = env["service"]._tasks[f"{env['owner']['id']}:{images[0]['id']}"]
    assert task["data"][0]["file_size"] == len(compressed)
    assert not list(config.images_dir.rglob("*.compression-backup"))
    assert compress_images()["compressed"] == 0


def test_expiry_includes_finished_unsent_failures_but_keeps_queued_work(environment):
    env = environment
    generated(env, 2)
    failed, queued = env["service"]._tasks.values()
    failed.update(status="error", dispatch_state="pending", data=[], updated_at="2000-01-01T00:00:00+00:00")
    queued.update(status="queued", dispatch_state="pending", data=[], updated_at="2000-01-01T00:00:00+00:00")
    assert env["service"].expire_results(1_600_000_000) == 1
    tasks = list(env["service"]._tasks.values())
    assert tasks[0]["result_deleted"] and not tasks[1].get("result_deleted")


@pytest.mark.parametrize("failure", ["remote", "commit", "persistent-remote"])
def test_compression_failure_rolls_back_or_leaves_recoverable_original(environment, monkeypatch, failure):
    env = environment
    original = large_png()
    image = generated(env, payload=original)[0]
    rel = relative(image)
    remote = {rel: original}
    item = image_rows.get(storage.index_file, "images", rel)
    image_rows.save(storage.index_file, {"images": {rel: {**item, "webdav": True, "storage": "both"}}})
    class Dav:
        failures = 1 if failure == "remote" else 100 if failure == "persistent-remote" else 0
        def __init__(self, settings):
            pass
        def put(self, rel, data):
            remote[rel] = data  # Simulate an accepted upload with a lost response.
            if self.failures:
                Dav.failures -= 1
                raise OSError("controlled remote failure")
            return "https://test.invalid/" + rel
    monkeypatch.setattr("services.image_storage_service.WebDAVClient", Dav)
    commit = image_rows.save_deletions
    if failure == "commit":
        def fail(*args, **kwargs):
            raise OSError("controlled compression commit failure")
        monkeypatch.setattr(image_rows, "save_deletions", fail)
    result = compress_images()
    assert result["compressed"] == 0 and result["failed"] >= 1
    assert local_image_path(rel).read_bytes() == original and remote[rel] == original
    if failure == "persistent-remote":
        indexed = image_rows.get(storage.index_file, "images", rel)
        assert indexed["writing"] and indexed["compression"]
        assert env["client"].get(image["url"], headers=env["headers"]).status_code == 404
    else:
        assert not image_rows.get(storage.index_file, "images", rel).get("writing")
    monkeypatch.setattr(image_rows, "save_deletions", commit)
    Dav.failures = 0
    assert compress_images()["compressed"] == 1
    assert local_image_path(rel).read_bytes() == remote[rel] == _compressed_png(original)
    assert not list(config.images_dir.rglob("*.compression-backup"))
