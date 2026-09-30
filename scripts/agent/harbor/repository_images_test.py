"""OCI image preparation must preserve registry identity and reject corrupt content."""

import contextlib
import gzip
import hashlib
import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import tempfile
import tarfile
import unittest
from pathlib import Path
from unittest.mock import patch

from repository_images import blob_path, download, received_range_bytes, transfer, verify_image, write_oci_archive


class RepositoryImageTests(unittest.TestCase):
    def test_range_deadline_keeps_only_a_matching_contiguous_prefix(self):
        valid = dict(status=206, returncode=28, content_range="bytes 10-19/30",
                     start=10, end=19, total=30, received=4)
        self.assertEqual(received_range_bytes(**valid), 4)
        self.assertEqual(received_range_bytes(**{**valid, "returncode": 18}), 4)
        self.assertEqual(received_range_bytes(**{**valid, "returncode": 0, "received": 10}), 10)
        for change in ({"status": 200}, {"content_range": "bytes 0-9/30"},
                       {"content_range": "bytes 10-19/31"}, {"received": 0},
                       {"received": 11}, {"returncode": 0}, {"returncode": 60},
                       {"returncode": 23}, {"end": 30}, {"start": -1}):
            with self.subTest(change=change):
                self.assertEqual(received_range_bytes(**{**valid, **change}), 0)

    def fixture(self, cache, *, diff_id=None):
        def put(content, media):
            identity = "sha256:" + hashlib.sha256(content).hexdigest()
            blob_path(cache, identity).write_bytes(content)
            return {"mediaType": media, "digest": identity, "size": len(content)}
        original = b"synthetic uncompressed layer payload"
        layer = put(gzip.compress(original, mtime=0), "application/vnd.oci.image.layer.v1.tar+gzip")
        config = put(json.dumps({"architecture": "amd64", "os": "linux", "rootfs": {"type": "layers",
            "diff_ids": [diff_id or "sha256:" + hashlib.sha256(original).hexdigest()]}}).encode(),
            "application/vnd.oci.image.config.v1+json")
        manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": config, "layers": [layer]}
        descriptor = put(json.dumps(manifest).encode(), manifest["mediaType"])
        expected = {"name": "ghcr.io/example/test:fixed", "id": descriptor["digest"],
            "manifest_digest": descriptor["digest"], "config_digest": config["digest"]}
        return expected, manifest

    def test_original_manifest_and_compressed_layers_are_kept_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            expected, manifest = self.fixture(cache)
            self.assertNotEqual(expected["manifest_digest"], expected["config_digest"])
            archive = cache / "image.oci.tar"
            write_oci_archive(cache, expected, archive)
            with tarfile.open(archive) as image:
                index = json.load(image.extractfile("index.json"))
                descriptor = index["manifests"][0]
                self.assertEqual(descriptor["digest"], expected["id"])
                self.assertEqual(descriptor["annotations"]["io.containerd.image.name"], expected["name"])
                for identity in (expected["manifest_digest"], expected["config_digest"], manifest["layers"][0]["digest"]):
                    original = blob_path(cache, identity).read_bytes()
                    self.assertEqual(image.extractfile("blobs/sha256/" + identity.split(":")[1]).read(), original)
            with self.assertRaises(FileExistsError):
                write_oci_archive(cache, expected, archive)

    def test_compressed_corruption_and_uncompressed_mismatch_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            expected, manifest = self.fixture(cache)
            blob_path(cache, manifest["layers"][0]["digest"]).write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "identity or size mismatch"):
                verify_image(cache, expected)
            expected, manifest = self.fixture(cache, diff_id="sha256:" + "0" * 64)
            with self.assertRaisesRegex(ValueError, "Uncompressed image layer identity mismatch"):
                verify_image(cache, expected)
            with self.assertRaisesRegex(ValueError, "Unsupported image content digest"):
                blob_path(cache, "../../escape")

    @contextlib.contextmanager
    def server(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                received.append(self.headers.get("Range"))
                if self.path == "/slow":
                    self.send_response(200)
                    self.send_header("Content-Length", "1000")
                    self.end_headers()
                    for _ in range(1000):
                        try:
                            self.wfile.write(b"x")
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                        time.sleep(0.01)
                    return
                start = int(self.headers.get("Range", "bytes=0-").split("=")[1].split("-")[0])
                if self.path == "/ignored":
                    self.send_response(200)
                    content = b"abcdef"
                else:
                    self.send_response(206 if start else 200)
                    content = (b"xxxxxx" if self.path == "/corrupt" else b"abcdef")[start:]
                    if start:
                        self.send_header("Content-Range", f"bytes {start}-5/6")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield "http://127.0.0.1:" + str(server.server_port), received
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_download_resumes_exact_range_and_verifies_final_digest(self):
        with tempfile.TemporaryDirectory() as directory, self.server() as (url, received):
            cache = Path(directory)
            identity = "sha256:" + hashlib.sha256(b"abcdef").hexdigest()
            target = blob_path(cache, identity)
            partial = target.with_suffix(".partial")
            partial.write_bytes(b"abc")
            records = []
            def fetch(_url, headers, path):
                return transfer(url + "/ok", headers, path, timeout=2)
            with patch("repository_images.transfer", side_effect=fetch):
                result = download("example/test", {}, cache, identity, records.append)
            self.assertEqual(received, ["bytes=3-"])
            self.assertEqual(result.read_bytes(), b"abcdef")
            self.assertEqual(records[-1]["status"], "verified")
            result.unlink()
            partial.write_bytes(b"abc")
            def ignored(_url, headers, path):
                return transfer(url + "/ignored", headers, path, timeout=2)
            with patch("repository_images.transfer", side_effect=ignored), patch("repository_images.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, "exhausted retries"):
                    download("example/test", {}, cache, identity, records.append)
            self.assertEqual(partial.read_bytes(), b"abc")
            self.assertFalse(target.exists())
            self.assertEqual(len(received), 5)
            partial.write_bytes(b"abcdef")
            with patch("repository_images.transfer", side_effect=AssertionError("Verified partial needs no download")):
                self.assertEqual(download("example/test", {}, cache, identity, records.append), result)
            self.assertEqual(records[-1]["status"], "recovered-verified-partial")

    def test_trickling_transfer_has_a_total_deadline_and_keeps_partial(self):
        with tempfile.TemporaryDirectory() as directory, self.server() as (url, _):
            partial = Path(directory) / "layer.partial"
            start = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "curl exit 28"):
                transfer(url + "/slow", {}, partial, timeout=0.3)
            self.assertLess(time.monotonic() - start, 2)
            self.assertGreater(partial.stat().st_size, 0)
            self.assertLess(partial.stat().st_size, 1000)

    def test_deadline_after_last_byte_uses_verified_content_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            identity = "sha256:" + hashlib.sha256(b"abcdef").hexdigest()
            records = []
            def completed_but_timed_out(_url, _headers, partial):
                partial.write_bytes(b"abcdef")
                raise RuntimeError("Image transfer exceeded wall-clock deadline")
            with patch("repository_images.transfer", side_effect=completed_but_timed_out) as worker:
                result = download("example/test", {}, cache, identity, records.append)
            self.assertEqual(result.read_bytes(), b"abcdef")
            self.assertEqual(worker.call_count, 1)
            self.assertEqual(records[-1]["status"], "verified-after-transfer-error")

    def test_worker_timeout_and_errors_cannot_expose_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            partial = Path(directory) / "layer.partial"
            secret = "synthetic-private-token"
            with patch("repository_images.subprocess.run", side_effect=subprocess.TimeoutExpired(["curl"], 6, stderr=secret)) as run:
                with self.assertRaisesRegex(RuntimeError, "wall-clock deadline") as error:
                    transfer("https://ghcr.io/example", {"Authorization": "Bearer " + secret}, partial, timeout=1)
            self.assertNotIn(secret, str(error.exception))
            self.assertNotIn(secret, repr(run.call_args.args))
            self.assertIn(secret, run.call_args.kwargs["input"])
            self.assertEqual(run.call_args.kwargs["timeout"], 6)
            with self.assertRaisesRegex(ValueError, "Invalid download configuration"):
                transfer("https://ghcr.io/example", {"Authorization": "bad\nheader"}, partial)

    def test_corrupt_download_is_never_published(self):
        with tempfile.TemporaryDirectory() as directory, self.server() as (url, _):
            cache = Path(directory)
            identity = "sha256:" + hashlib.sha256(b"abcdef").hexdigest()
            def corrupt(_url, headers, path):
                return transfer(url + "/corrupt", headers, path, timeout=2)
            with patch("repository_images.transfer", side_effect=corrupt), patch("repository_images.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, "exhausted retries"):
                    download("example/test", {}, cache, identity, lambda _: None)
            self.assertFalse(blob_path(cache, identity).exists())


if __name__ == "__main__":
    unittest.main()
