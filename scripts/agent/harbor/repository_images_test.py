"""OCI image preparation must preserve registry identity and reject corrupt content."""

import contextlib
import gzip
import hashlib
import io
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

import repository_images as subject

from resource_leases import DispatchError, ResourceLeases
from repository_images import blob_path, download, main, received_range_bytes, transfer, verify_image, write_oci_archive


class RepositoryImageTests(unittest.TestCase):
    @contextlib.contextmanager
    def import_fixture(self, *, health_states=None, containers=None):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            bench = Path(directory)
            cache = bench / "registry-blobs"
            cache.mkdir()
            expected, _ = self.fixture(cache)
            config = json.loads(blob_path(cache, expected["config_digest"]).read_text())
            manifest = bench / "manifest.json"
            manifest.write_text(json.dumps({"resource_pool": {"max_active_attempts": 2, "cpus": 2, "memory_mb": 8192}, "tasks": {"synthetic": {"image": expected}}}))
            gateway = bench / "selected-gateway"
            gateway.mkdir()
            secret = "synthetic-selected-gateway-secret"
            (gateway / "gateway-token").write_text(secret)
            legacy = bench / "campaign"
            legacy.mkdir()
            (legacy / "gateway-token").write_text("synthetic-wrong-gateway-secret")
            argv = ["repository_images.py", "--manifest", str(manifest), "--task", "synthetic",
                "--name", "fixture", "--gateway-directory", str(gateway),
                "--gateway-url", "http://127.0.0.1:48763"]
            states = iter(health_states or [
                {"activeUpstreamRequests": 0, "scheduler": {"queued": 0}},
                {"activeUpstreamRequests": 0, "scheduler": {"queued": 0}},
            ])
            running = iter(containers or ["", ""])
            def health(request, **_kwargs):
                self.assertEqual(request.full_url, "http://127.0.0.1:48763/health")
                self.assertEqual(request.get_header("Authorization"), "Bearer " + secret)
                return io.StringIO(json.dumps(next(states)))
            def output(command, **kwargs):
                if command == ["docker", "ps", "--quiet"]:
                    return next(running)
                self.assertNotIn(secret, repr(kwargs))
                self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
                self.assertNotIn("ANTHROPIC_API_KEY", kwargs["env"])
                if command[0] == "colima":
                    return "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/vda 50000000 10000000 40000000 20% /var/lib/docker\n"
                self.assertEqual(command, ["docker", "image", "inspect", expected["name"]])
                return json.dumps([{"Id": expected["id"], "Architecture": "amd64", "Os": "linux",
                    "RootFS": {"Layers": config["rootfs"]["diff_ids"]}, "Size": 1024}])
            stack.enter_context(patch("sys.argv", argv))
            stack.enter_context(patch("repository_images.BENCH", bench))
            stack.enter_context(patch("repository_launch.BENCH", bench))
            network = stack.enter_context(patch("repository_images.requests.Session"))
            network.return_value.__enter__.return_value.get.return_value.json.return_value = {"token": "synthetic-registry-secret"}
            checks = stack.enter_context(patch("repository_launch.urllib.request.urlopen", side_effect=health))
            processes = stack.enter_context(patch("repository_images.subprocess.check_output", side_effect=output))
            load = stack.enter_context(patch("repository_images.subprocess.run"))
            stdout = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            yield {"bench": bench, "gateway": gateway, "secret": secret, "argv": argv,
                "checks": checks, "processes": processes, "network": network, "load": load, "stdout": stdout}

    def test_import_requires_explicit_gateway_directory_and_origin(self):
        for missing in (("--gateway-directory",), ("--gateway-url",), ("--gateway-directory", "--gateway-url")):
            with self.subTest(missing=missing), self.import_fixture() as fixture:
                argv = fixture["argv"].copy()
                for flag in missing:
                    index = argv.index(flag)
                    del argv[index:index + 2]
                with patch("sys.argv", argv), self.assertRaises(SystemExit) as error:
                    main()
                self.assertEqual(error.exception.code, 2)
                fixture["checks"].assert_not_called()
                fixture["network"].assert_not_called()

    def test_import_checks_selected_gateway_before_download_and_before_load(self):
        with self.import_fixture() as fixture:
            main()
            self.assertEqual(fixture["checks"].call_count, 2)
            self.assertEqual(sum(call.args[0] == ["docker", "ps", "--quiet"]
                for call in fixture["processes"].call_args_list), 2)
            fixture["load"].assert_called_once()
            load_env = fixture["load"].call_args.kwargs["env"]
            self.assertNotIn("OPENAI_API_KEY", load_env)
            self.assertNotIn("ANTHROPIC_API_KEY", load_env)
            self.assertEqual(load_env["DOCKER_CONFIG"], str(fixture["bench"] / "docker-config"))
            evidence = (fixture["bench"] / "image-imports/fixture/result.json").read_text()
            result = json.loads(evidence)
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["gateway_health_url"], "http://127.0.0.1:48763/health")
            self.assertEqual(result["gateway_directory"], str(fixture["gateway"].resolve()))
            self.assertNotIn(fixture["secret"], evidence + fixture["stdout"].getvalue())

    def test_busy_gateway_or_any_vm_container_blocks_import_at_both_boundaries(self):
        idle = {"activeUpstreamRequests": 0, "scheduler": {"queued": 0}}
        for phase in ("download", "load"):
            for busy in ("active", "queued", "container"):
                state = {"activeUpstreamRequests": int(busy == "active"),
                    "scheduler": {"queued": int(busy == "queued")}}
                states = [state] if phase == "download" else [idle, state]
                containers = ([""] if phase == "load" else []) + (["some-other-job"] if busy == "container" else [])
                with self.subTest(phase=phase, busy=busy), self.import_fixture(
                        health_states=states, containers=containers) as fixture:
                    with self.assertRaises(RuntimeError):
                        main()
                    fixture["load"].assert_not_called()
                    if phase == "download":
                        fixture["network"].assert_not_called()
                    else:
                        result = json.loads((fixture["bench"] / "image-imports/fixture/result.json").read_text())
                        self.assertEqual(result["status"], "failed")

    def test_gateway_origin_rejects_embedded_credentials_or_url_suffixes(self):
        for url in ("http://user:secret@127.0.0.1:48763", "http://127.0.0.1:48763?token=secret",
                    "http://127.0.0.1:48763#secret"):
            with self.subTest(url=url), self.import_fixture() as fixture:
                argv = fixture["argv"].copy()
                argv[-1] = url
                with patch("sys.argv", argv), self.assertRaises(ValueError):
                    main()
                fixture["checks"].assert_not_called()
                fixture["network"].assert_not_called()

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
            def fetch(_url, headers, path, **_kwargs):
                return transfer(url + "/ok", headers, path, timeout=2)
            with patch("repository_images.transfer", side_effect=fetch):
                result = download("example/test", {}, cache, identity, records.append)
            self.assertEqual(received, ["bytes=3-"])
            self.assertEqual(result.read_bytes(), b"abcdef")
            self.assertEqual(records[-1]["status"], "verified")
            result.unlink()
            partial.write_bytes(b"abc")
            def ignored(_url, headers, path, **_kwargs):
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
            def completed_but_timed_out(_url, _headers, partial, **_kwargs):
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
            def corrupt(_url, headers, path, **_kwargs):
                return transfer(url + "/corrupt", headers, path, timeout=2)
            with patch("repository_images.transfer", side_effect=corrupt), patch("repository_images.time.sleep"):
                with self.assertRaisesRegex(ValueError, "identity mismatch"):
                    download("example/test", {}, cache, identity, lambda _: None)
            self.assertFalse(blob_path(cache, identity).exists())
            self.assertFalse(blob_path(cache, identity).with_suffix(".partial").exists())
            quarantined = list(cache.glob("*.corrupt-*"))
            self.assertEqual(len(quarantined), 1)
            self.assertEqual(quarantined[0].read_bytes(), b"xxxxxx")

    def test_26_maintenance_claim_spans_download_and_load(self):
        with self.import_fixture() as fixture:
            def observe(*_args, **_kwargs):
                path = fixture["bench"] / "campaign/resource-leases/resources.json"
                state = json.loads(path.read_text())
                self.assertEqual(state["admission"]["scope"]["kind"], "maintenance")
                pool = ResourceLeases(path.parent, state["capacity"])
                identity = {key: "synthetic" for key in ("campaignId", "candidateId", "participantId", "taskId", "attemptId", "jobId")}
                identity["phase"] = "source"
                with self.assertRaises(DispatchError):
                    pool.acquire(identity, {"cpus": 1, "memory_mb": 1}, timeout=0)
            fixture["load"].side_effect = observe
            session = fixture["network"].return_value.__enter__.return_value
            fixture["network"].return_value.__enter__.side_effect = lambda: (observe() or session)
            main()
            state = json.loads((fixture["bench"] / "campaign/resource-leases/resources.json").read_text())
            self.assertIsNone(state["admission"])

    def test_27_unknown_image_import_retains_claim(self):
        with self.import_fixture() as fixture:
            fixture["load"].side_effect = subprocess.TimeoutExpired(["docker", "load"], 600)
            with self.assertRaises(RuntimeError):
                main()
            path = fixture["bench"] / "campaign/resource-leases/resources.json"
            state = json.loads(path.read_text())
            self.assertEqual(state["admission"]["status"], "blocked")
            self.assertEqual(state["admission"]["reason"], "image_import_settlement_unknown")
            with self.assertRaises(DispatchError):
                main()
            self.assertEqual(fixture["load"].call_count, 1)

    def test_28_existing_lease_prevents_any_preparation_writes(self):
        with self.import_fixture() as fixture:
            pool = ResourceLeases(fixture["bench"] / "campaign/resource-leases", {"max_active_attempts": 2, "cpus": 2, "memory_mb": 8192})
            identity = {key: "synthetic" for key in ("campaignId", "candidateId", "participantId", "taskId", "attemptId", "jobId")}
            identity["phase"] = "source"
            lease = pool.acquire(identity, {"cpus": 1, "memory_mb": 1})
            with self.assertRaises(DispatchError):
                main()
            self.assertFalse((fixture["bench"] / "image-imports").exists())
            fixture["checks"].assert_not_called()
            fixture["network"].assert_not_called()
            fixture["load"].assert_not_called()
            pool.finish(lease, settled=True)


class SegmentedDownloadTests(unittest.TestCase):
    def test_progress_can_complete_after_more_than_four_windows(self):
        content = b"abcdef"
        identity = "sha256:" + hashlib.sha256(content).hexdigest()
        records, offsets = [], []
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            target = blob_path(cache, identity)
            partial = target.with_suffix(".partial")
            def curl(argv, *, input, **kwargs):
                self.assertEqual(argv, ["curl", "-q", "--config", "-"])
                self.assertIn("continue-at = -", input)
                self.assertIn("max-time = 90", input)
                offset = partial.stat().st_size if partial.exists() else 0
                offsets.append(offset)
                with partial.open("ab") as stream:
                    stream.write(content[offset:offset + 1])
                return subprocess.CompletedProcess(argv, 0 if offset == len(content) - 1 else 28)
            with patch("repository_images.subprocess.run", side_effect=curl), patch("repository_images.time.sleep"):
                result = download("synthetic/image", {}, cache, identity, records.append)
            self.assertEqual(result.read_bytes(), content)
            self.assertEqual(offsets, list(range(6)))
            self.assertFalse(partial.exists())
            self.assertTrue(all(item["status"] == "progress" for item in records[:-1]))

    def test_stalls_and_untrusted_errors_remain_bounded_even_if_bytes_grow(self):
        for code in ("CURL_28", "CURL_60", None):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                cache = Path(directory)
                identity = "sha256:" + hashlib.sha256(b"abcdef").hexdigest()
                target = subject.blob_path(cache, identity)
                partial = target.with_suffix(".partial")
                partial.write_bytes(b"a")
                records = []
                def fail(_url, _headers, path, **_kwargs):
                    if code != "CURL_28":
                        with path.open("ab") as stream:
                            stream.write(b"x")
                    if code is None:
                        raise RuntimeError("curl exit 28 is not a structured outcome")
                    raise subject.ImageTransferError("sanitized", code)
                with patch.object(subject, "transfer", side_effect=fail) as worker, patch.object(subject.time, "sleep"):
                    with self.assertRaisesRegex(RuntimeError, "exhausted retries"):
                        subject.download("synthetic/image", {}, cache, identity, records.append)
                self.assertEqual(worker.call_count, 4)
                self.assertEqual(records[-1]["no_progress_failures"], 4)
                self.assertTrue(all(item["status"] == "retry" for item in records))
                self.assertEqual(partial.read_bytes(), b"a" if code == "CURL_28" else b"axxxx")
                self.assertFalse(target.exists())

    def test_progress_resets_consecutive_stalls(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            identity = "sha256:" + hashlib.sha256(b"abc").hexdigest()
            records, calls = [], []
            def fetch(_url, _headers, partial, **_kwargs):
                calls.append(1)
                if len(calls) % 4 == 0:
                    offset = partial.stat().st_size if partial.exists() else 0
                    with partial.open("ab") as stream:
                        stream.write(b"abc"[offset:offset + 1])
                raise subject.ImageTransferError("sanitized", "CURL_18")
            with patch.object(subject, "transfer", side_effect=fetch), patch.object(subject.time, "sleep"):
                target = subject.download("synthetic/image", {}, cache, identity, records.append)
            self.assertEqual(target.read_bytes(), b"abc")
            self.assertEqual(len(calls), 12)
            self.assertEqual([item["no_progress_failures"] for item in records[:-1]], [1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3])

    def test_total_deadline_bounds_progress_windows_and_preserves_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            identity = "sha256:" + hashlib.sha256(b"abcdef").hexdigest()
            records, windows, clock = [], [], [0.0]
            def fetch(_url, _headers, partial, *, timeout, wall_timeout):
                windows.append((timeout, wall_timeout))
                clock[0] += timeout
                with partial.open("ab") as stream:
                    stream.write(b"x")
                raise subject.ImageTransferError("sanitized", "CURL_28")
            with patch.object(subject, "transfer", side_effect=fetch), patch.object(subject.time, "monotonic", side_effect=lambda: clock[0]), patch.object(subject.time, "sleep") as sleep:
                with self.assertRaisesRegex(RuntimeError, "total deadline"):
                    subject.download("synthetic/image", {}, cache, identity, records.append, total_timeout=200)
            self.assertEqual(windows, [(90, 200), (90, 110), (20, 20)])
            self.assertEqual(clock[0], 200)
            sleep.assert_not_called()
            self.assertEqual(records[-1]["status"], "deadline-exceeded")
            self.assertEqual(subject.blob_path(cache, identity).with_suffix(".partial").read_bytes(), b"xxx")
            self.assertFalse(subject.blob_path(cache, identity).exists())

    def test_deadline_bounds_backoff_and_does_not_publish_late_complete_bytes(self):
        for complete in (False, True):
            with self.subTest(complete=complete), tempfile.TemporaryDirectory() as directory:
                cache = Path(directory)
                identity = "sha256:" + hashlib.sha256(b"abcdef").hexdigest()
                records, clock = [], [0.0]
                def fetch(_url, _headers, partial, *, timeout, wall_timeout):
                    self.assertEqual((timeout, wall_timeout), (3, 3))
                    partial.write_bytes(b"abcdef" if complete else b"abc")
                    clock[0] += 3 if complete else 2
                    raise subject.ImageTransferError("sanitized", "CURL_60")
                def delay(seconds):
                    self.assertEqual(seconds, 1)
                    clock[0] += seconds
                with patch.object(subject, "transfer", side_effect=fetch) as worker, patch.object(subject.time, "monotonic", side_effect=lambda: clock[0]), patch.object(subject.time, "sleep", side_effect=delay) as sleep:
                    with self.assertRaisesRegex(RuntimeError, "total deadline"):
                        subject.download("synthetic/image", {}, cache, identity, records.append, total_timeout=3)
                self.assertEqual(worker.call_count, 1)
                self.assertEqual(sleep.call_count, 0 if complete else 1)
                self.assertEqual(clock[0], 3)
                target = subject.blob_path(cache, identity)
                self.assertFalse(target.exists())
                self.assertEqual(target.with_suffix(".partial").read_bytes(), b"abcdef" if complete else b"abc")

    def test_checksum_mismatch_is_quarantined_and_next_attempt_starts_fresh(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            identity = "sha256:" + hashlib.sha256(b"abcdef").hexdigest()
            records = []
            def corrupt(_url, _headers, partial, **_kwargs):
                partial.write_bytes(b"xxxxxx")
            with patch.object(subject, "transfer", side_effect=corrupt) as worker:
                with self.assertRaisesRegex(ValueError, "identity mismatch"):
                    subject.download("synthetic/image", {}, cache, identity, records.append)
            self.assertEqual(worker.call_count, 1)
            self.assertEqual(records[-1]["status"], "checksum-mismatch")
            quarantine = Path(records[-1]["quarantine"])
            self.assertEqual(quarantine.read_bytes(), b"xxxxxx")
            self.assertIn(hashlib.sha256(b"xxxxxx").hexdigest(), quarantine.name)
            target = subject.blob_path(cache, identity)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix(".partial").exists())
            def good(_url, _headers, partial, **_kwargs):
                self.assertFalse(partial.exists())
                partial.write_bytes(b"abcdef")
            with patch.object(subject, "transfer", side_effect=good):
                self.assertEqual(subject.download("synthetic/image", {}, cache, identity, records.append), target)
            self.assertEqual(target.read_bytes(), b"abcdef")
            self.assertEqual(quarantine.read_bytes(), b"xxxxxx")

    def test_curl_and_worker_deadlines_share_remaining_budget_without_exposing_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            partial = Path(directory) / "fixture.partial"
            with patch.object(subject.subprocess, "run", side_effect=subprocess.TimeoutExpired(["curl"], 0.5, stderr="synthetic-secret")) as worker:
                with self.assertRaises(subject.ImageTransferError) as error:
                    subject.transfer("https://registry.invalid/example", {"Authorization": "synthetic-secret"}, partial, timeout=0.5, wall_timeout=0.5)
            self.assertEqual(error.exception.code, "WALL_TIMEOUT")
            self.assertIsInstance(error.exception, RuntimeError)
            self.assertNotIn("synthetic-secret", str(error.exception))
            self.assertEqual(worker.call_args.kwargs["timeout"], 0.5)
            self.assertIn("max-time = 0.5", worker.call_args.kwargs["input"])
            self.assertIn('proto-redir = "=https"', worker.call_args.kwargs["input"])
            self.assertNotIn("insecure", worker.call_args.kwargs["input"])

    def test_deadline_configuration_rejects_unbounded_and_invalid_values(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in (0, -1, float("inf"), float("nan")):
                with self.subTest(total_timeout=value), self.assertRaises(ValueError):
                    subject.download("synthetic/image", {}, Path(directory), "sha256:" + "0" * 64, lambda _: None, total_timeout=value)
            for value in (0, -1, 0.5, True):
                with self.subTest(max_no_progress=value), self.assertRaises(ValueError):
                    subject.download("synthetic/image", {}, Path(directory), "sha256:" + "0" * 64, lambda _: None, max_no_progress=value)




if __name__ == "__main__":
    unittest.main()
