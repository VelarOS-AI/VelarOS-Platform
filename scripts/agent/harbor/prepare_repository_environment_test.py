"""Zero-worker preparation contracts: actual overlay ABI, exact identities and uncertain settlement."""

import contextlib
import hashlib
import io
import json
import shutil
import struct
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import prepare_repository_environment as prep


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def elf(machine=62, endian=1, elf_class=2):
    data = bytearray(64)
    data[:7] = bytes((127, 69, 76, 70, elf_class, endian, 1))
    struct.pack_into("<H", data, 18, machine)
    return bytes(data)


def shell_elf(interpreter, machine=62):
    encoded = interpreter.encode() + b"\0" if interpreter is not None else b""
    data = bytearray(elf(machine=machine) + bytes(56) + encoded)
    struct.pack_into("<H", data, 16, 3)
    struct.pack_into("<I", data, 20, 1)
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<HHH", data, 52, 64, 56, 1)
    struct.pack_into("<I", data, 64, 3 if interpreter is not None else 1)
    struct.pack_into("<Q", data, 72, 120)
    struct.pack_into("<Q", data, 96, len(encoded))
    return bytes(data)


class Fixture:
    def __init__(self, root):
        self.root = root
        self.bench = root / "bench"
        self.dataset = self.bench / "dataset"
        self.task = "fixture-repository-task"
        self.directory = self.bench / "preparation"
        self.gateway = self.bench / "gateway"
        self.output = self.bench / "fresh-output"
        self.task_path = self.dataset / "v2/tasks" / self.task
        self.config = {"architecture": "amd64", "os": "linux", "rootfs": {"diff_ids": ["sha256:" + "b" * 64]},
                       "config": {"WorkingDir": "/repository"}}
        write(self.directory / "registry-config.json", self.config)
        self.image = {"name": "registry.invalid/fixture:task", "id": "sha256:" + "a" * 64,
                      "manifest_digest": "sha256:" + "a" * 64,
                      "config_digest": "sha256:" + sha((self.directory / "registry-config.json").read_bytes())}
        files = {"instruction.md": b"opaque instruction bytes", "environment/Dockerfile": b"opaque environment bytes",
                 "tests/test.sh": b"opaque verification bytes", "solution/opaque.diff": b"opaque solution bytes",
                 "tests/config.json": b"opaque bytes even though suffix is JSON",
                 "task.toml": ('[environment]\ndocker_image="' + self.image["name"] + '"\ncpus=1\nmemory_mb=1536\nstorage_mb=2048\nos="linux"\n').encode()}
        for name, data in files.items():
            target = self.task_path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (self.dataset / "v2/tooling").mkdir(parents=True)
        (self.dataset / "v2/tooling/patch_replay.py").write_text("# opaque replay identity\n")
        for command in (["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]):
            subprocess.run(["git", "-C", str(self.dataset), *command], check=True, capture_output=True)
        revision = subprocess.check_output(["git", "-C", str(self.dataset), "rev-parse", "HEAD"], text=True).strip()
        write(self.directory / "selection.json", {"tasks": [self.task]})
        self.manifest = {"schema": 1, "dataset_revision": revision, "vm": {"profile": "fixture-worker"},
            "selection_manifest": str(self.directory / "selection.json"), "selection_sha256": sha((self.directory / "selection.json").read_bytes()),
            "resource_pool": {"max_active_attempts": 2, "cpus": 2, "memory_mb": 3072},
            "tasks": {self.task: {"image": self.image, "resources": {"cpus": 1, "memory_mb": 1536, "storage_mb": 2048, "os": "linux"},
                                  "files_sha256": {name: sha(data) for name, data in files.items()}}}}
        self.manifest_path = self.directory / "manifest.json"
        write(self.manifest_path, self.manifest)
        self.import_path = self.directory / "import.json"
        self.imported = {"status": "ready", "task": self.task, "image": self.image, "image_id": self.image["id"],
                         "manifest_file": str(self.manifest_path), "manifest_sha256": sha(self.manifest_path.read_bytes()),
                         "gateway_directory": str(self.gateway), "gateway_health_url": "http://127.0.0.1:12345/health",
                         "layers_verified": 1, "uncompressed_diff_ids_verified": 1}
        write(self.import_path, self.imported)
        write(self.gateway / "budget.json", {"requests": [{"id": "historical-request", "finishedAt": "earlier", "estimatedUsd": None}]})
        self.validator = self.directory / "validator.py"
        self.validator.write_text('''import json
def validate_environment_ready(ready_path, base_path, base, task, libc, gateway):
    ready = json.loads(ready_path.read_text())
    assert ready["status"] == "environment_ready" and ready["task"] == task
    assert ready["preparation_model_request_increment"] == 0
    assert ready["container_ids"] == [] and ready["baseline_request_ids"] == ready["gateway_request_ids"]
    assert base["tasks"][task]["image"]["id"] == ready["image_id"]
    assert ready["required_agent_platform"] == "linux-x64-" + libc
    return {"required_agent_platform": ready["required_agent_platform"]}, ready["evidence"]
''')
        self.source = self.directory / "helper.py"
        self.source.write_bytes(Path(prep.__file__).read_bytes())
        self.runtime_source = self.directory / "runtime_artifacts.py"
        self.runtime_source.write_bytes(Path(prep.runtime_artifacts.__file__).read_bytes())
        self.args = prep.parser().parse_args(["--manifest", str(self.manifest_path), "--task", self.task,
            "--import-result", str(self.import_path), "--output", str(self.output), "--gateway-directory", str(self.gateway),
            "--gateway-url", "http://127.0.0.1:12345", "--environment-validator", str(self.validator), "--dataset", str(self.dataset)])

    @contextlib.contextmanager
    def patched(self):
        with patch.object(prep, "ROOT", self.root), patch.object(prep, "BENCH", self.bench), patch.object(prep, "__file__", str(self.source)), \
             patch.object(prep.runtime_artifacts, "__file__", str(self.runtime_source)):
            yield


class FakeDocker:
    def __init__(self, inputs, kind="glibc", failure=None):
        self.inputs, self.kind, self.failure = inputs, kind, failure
        self.cid, self.alive, self.commands = "d" * 64, False, []
        self.owner = None

    def command(self, argv, *, effect=False):
        self.commands.append((argv, effect))
        if argv[0] == "ps":
            return ((self.cid if self.alive else "") + "\n").encode()
        if argv[0] == "image":
            return json.dumps({"id": self.inputs["task_data"]["image"]["id"], "os": "linux", "architecture": "amd64",
                               "layers": self.inputs["config"]["rootfs"]["diff_ids"], "workdir": "/repository", "size": 1234}).encode()
        if argv[0] == "create":
            if self.failure == "create_timeout":
                raise subprocess.TimeoutExpired("docker create", 60)
            if self.failure == "create_cancelled":
                raise KeyboardInterrupt
            self.owner = next(value.split("=", 1)[1] for value in argv if value.startswith("velaros.bench.metadata-owner="))
            self.alive = True
            return ("short" if self.failure == "short_id" else self.cid).encode()
        if argv[0] == "inspect":
            return json.dumps({"id": self.cid, "image": self.inputs["task_data"]["image"]["id"],
                "owner": self.owner, "manifest": self.inputs["manifest_sha256"], "workdir": "/repository", "network": "none",
                "nano_cpus": 1000000000, "memory": 1536 * 1024 ** 2,
                "state": {"Status": "running" if self.failure == "started" else "created", "Running": self.failure == "started",
                          "StartedAt": "0001-01-01T00:00:00Z"}}).encode()
        if argv[0] == "rm":
            if self.failure == "rm_timeout":
                raise subprocess.TimeoutExpired("docker rm", 60)
            if self.failure == "wrong_removed_id":
                return b"another-id"
            self.alive = False
            return self.cid.encode()
        raise AssertionError("Unexpected command")

    def head(self, cid, path):
        if path == "/repository":
            return {"mode": 1 << 31, "name": "repository"}
        if path == "/bin/sh":
            return None if self.failure == "missing_shell" else {"mode": 0}
        kind = next((kind for kind, paths in prep.LOADERS.items() if path in paths), None)
        return {"mode": 0} if self.kind == "both" or kind == self.kind else None

    def copy(self, cid, path):
        if path == "/etc/os-release":
            return b'ID="fixture"\nPRIVATE_VALUE=not-published\n'
        if path == "/bin/sh":
            interpreter = (prep.LOADERS["musl"][0] if self.kind == "musl" or self.failure == "primary_musl"
                           else prep.LOADERS["glibc"][0])
            if self.failure == "static_shell":
                interpreter = None
            elif self.failure == "unknown_interpreter":
                interpreter = "/unsupported/loader"
            return shell_elf(interpreter)
        return elf(machine=183 if self.failure == "arm_loader" else 62)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Fixture(Path(self.temporary.name).resolve())

    def test_valid_local_inputs_read_no_worker_and_do_not_publish(self):
        with self.fixture.patched(), patch.object(prep, "environment", side_effect=AssertionError("Worker contacted")):
            inputs = prep.local_inputs(self.fixture.args)
        self.assertEqual(inputs["baseline"]["unknown"], 1)
        self.assertEqual(len(inputs["task_data"]["files_sha256"]), 6)
        self.assertFalse(self.fixture.output.exists())

    def test_wrong_import_task_manifest_image_gateway_and_unverified_layers_are_rejected(self):
        for update in ({"task": "foreign"}, {"manifest_sha256": "0" * 64}, {"image_id": "sha256:" + "0" * 64},
                       {"gateway_health_url": "http://127.0.0.1:1/health"}, {"uncompressed_diff_ids_verified": 0}):
            with self.subTest(update=update):
                write(self.fixture.import_path, {**self.fixture.imported, **update})
                with self.fixture.patched(), self.assertRaises(ValueError):
                    prep.local_inputs(self.fixture.args)

    def test_task_and_pinned_source_mutations_cannot_be_published(self):
        with self.fixture.patched():
            inputs = prep.local_inputs(self.fixture.args)
            self.fixture.source.write_text("changed")
            with self.assertRaisesRegex(ValueError, "input changed"):
                prep.verify_pins(inputs)
            self.fixture.source.write_bytes(Path(__file__).read_bytes())
            inputs["pins"][self.fixture.source] = prep.digest(self.fixture.source)
            (self.fixture.task_path / "tests/test.sh").write_text("changed opaque bytes")
            with self.assertRaisesRegex(ValueError, "input changed"):
                prep.verify_pins(inputs)

    def test_manifest_file_set_and_opaque_file_bytes_must_match_official_git(self):
        with self.fixture.patched():
            self.fixture.manifest["tasks"][self.fixture.task]["files_sha256"].pop("solution/opaque.diff")
            write(self.fixture.manifest_path, self.fixture.manifest)
            self.fixture.imported["manifest_sha256"] = prep.digest(self.fixture.manifest_path)
            write(self.fixture.import_path, self.fixture.imported)
            with self.assertRaisesRegex(ValueError, "file set"):
                prep.local_inputs(self.fixture.args)

    def test_config_digest_is_not_inferred_from_distribution(self):
        write(self.fixture.directory / "registry-config.json", {**self.fixture.config, "architecture": "arm64"})
        with self.fixture.patched(), self.assertRaisesRegex(ValueError, "digest"):
            prep.local_inputs(self.fixture.args)

    def test_symlink_ancestors_external_alias_and_task_file_alias_are_rejected(self):
        alias = self.fixture.root / "alias"
        alias.symlink_to(self.fixture.directory, target_is_directory=True)
        self.fixture.args.manifest = alias / "manifest.json"
        with self.fixture.patched(), self.assertRaisesRegex(ValueError, "Symlink"):
            prep.local_inputs(self.fixture.args)
        self.fixture.args.manifest = self.fixture.manifest_path
        target = self.fixture.task_path / "instruction.md"
        target.unlink()
        target.symlink_to(self.fixture.root.parent / "external")
        with self.fixture.patched(), self.assertRaisesRegex(ValueError, "Symlink"):
            prep.local_inputs(self.fixture.args)

    def test_unfinished_and_duplicate_ledger_rows_are_not_a_quiescent_baseline(self):
        for rows in ([{"id": "active", "estimatedUsd": None}],
                     [{"id": "same", "finishedAt": "done", "estimatedUsd": None}] * 2):
            write(self.fixture.gateway / "budget.json", {"requests": rows})
            with self.fixture.patched(), self.assertRaises(ValueError):
                prep.local_inputs(self.fixture.args)

    def run_overlay(self, kind="glibc", failure=None):
        inputs = prep.local_inputs(self.fixture.args)
        self.fixture.output.mkdir(exist_ok=False)
        leases = prep.ResourceLeases(self.fixture.bench / "campaign/resource-leases", inputs["pool"])
        fake = FakeDocker(inputs, kind, failure)
        state = {"activeUpstreamRequests": 0, "scheduler": {"active": 0, "queued": 0}, "requests": 1, "unknownUsage": 1}
        with patch.object(prep, "guard_idle", return_value=state):
            with prep.maintenance_session(leases, owner=str(inputs["output"]), manifest_sha256=inputs["manifest_sha256"],
                                          worker={"profile": inputs["profile"], "socket": str(inputs["socket"])}) as claim:
                result = prep.inspect_overlay(inputs, leases, claim, fake, {})
        resources = prep.read(leases.path)
        result.update(active_leases_after=0, admission_after=None, released_admission=resources["admission_history"][-1])
        prep.write_evidence(self.fixture.output / "inspection.json", result)
        return inputs, leases, fake, result, state

    def test_actual_glibc_and_musl_overlay_are_identified_without_starting_container(self):
        for kind in ("glibc", "musl"):
            with self.subTest(kind=kind), self.fixture.patched():
                inputs, leases, fake, result, state = self.run_overlay(kind)
                self.assertEqual(result["libc"]["kind"], kind)
                self.assertTrue(result["inspection_container_removed"])
                self.assertEqual(result["released_admission"]["status"], "released")
                self.assertFalse(any(command[0] in ("start", "run", "exec") for command, effect in fake.commands))
                self.assertNotIn("PRIVATE_VALUE", json.dumps(result))
                shutil_remove(self.fixture.output)

    def test_missing_or_wrong_architecture_loader_cleanup_but_never_ready(self):
        for kind, failure in (("none", None), ("glibc", "arm_loader"), ("glibc", "started"),
                              ("both", "missing_shell"), ("both", "static_shell"), ("both", "unknown_interpreter")):
            with self.subTest(kind=kind, failure=failure), self.fixture.patched(), self.assertRaises(ValueError):
                self.run_overlay(kind, failure)
            record = json.loads((self.fixture.output / "inspection-in-progress.json").read_text())
            self.assertEqual(record["status"], "failed")
            self.assertTrue(record["inspection_container_removed"])
            self.assertFalse((self.fixture.output / "environment-ready.json").exists())
            shutil_remove(self.fixture.output)

    def test_mixed_loaders_select_actual_shell_interpreter_for_either_primary_abi(self):
        for failure, expected in ((None, "glibc"), ("primary_musl", "musl")):
            with self.subTest(expected=expected), self.fixture.patched():
                inputs, leases, fake, result, health = self.run_overlay("both", failure)
                self.assertEqual(result["libc"]["kind"], expected)
                self.assertEqual(result["libc"]["loader_path"], result["primary_shell"]["pt_interp"])
                self.assertEqual(result["primary_shell"]["sha256"], sha(fake.copy(fake.cid, "/bin/sh")))
                self.assertEqual(result["libc"]["selection_basis"], "system_shell_elf_pt_interp")
                self.assertTrue(result["inspection_container_removed"])
                shutil_remove(self.fixture.output)

    def test_truncated_or_multiple_shell_interpreter_headers_do_not_prove_an_abi(self):
        valid = shell_elf(prep.LOADERS["glibc"][0])
        self.assertEqual(prep.shell_interpreter(valid)["libc_kind"], "glibc")
        broken = bytearray(valid)
        struct.pack_into("<Q", broken, 72, len(valid) + 100)
        for data in (valid[:70], bytes(broken), shell_elf(None), shell_elf("/unsupported/loader")):
            with self.assertRaises(ValueError):
                prep.shell_interpreter(data)
        duplicated = bytearray(valid[:64] + valid[64:120] * 2 + valid[120:])
        struct.pack_into("<H", duplicated, 56, 2)
        struct.pack_into("<Q", duplicated, 72, 176)
        struct.pack_into("<Q", duplicated, 128, 176)
        with self.assertRaises(ValueError):
            prep.shell_interpreter(duplicated)

    def test_unknown_create_and_cleanup_leave_blocked_epoch_and_retained_failure(self):
        for failure in ("create_timeout", "create_cancelled", "short_id", "rm_timeout", "wrong_removed_id"):
            with self.subTest(failure=failure), self.fixture.patched(), self.assertRaises((ValueError, subprocess.TimeoutExpired, KeyboardInterrupt)):
                self.run_overlay(failure=failure)
            state = json.loads((self.fixture.bench / "campaign/resource-leases/resources.json").read_text())
            self.assertEqual(state["admission"]["status"], "blocked")
            self.assertEqual(json.loads((self.fixture.output / "inspection-in-progress.json").read_text())["status"], "failed")
            self.assertFalse((self.fixture.output / "environment-ready.json").exists())
            shutil_remove(self.fixture.output)
            shutil_remove(self.fixture.bench / "campaign/resource-leases")

    def test_cold_create_has_bounded_deadline_without_relaxing_metadata_reads(self):
        with self.fixture.patched():
            inputs = prep.local_inputs(self.fixture.args)
            self.fixture.output.mkdir()
            docker = prep.DockerMetadata(inputs, {})
            response = SimpleNamespace(returncode=0, stdout=b"opaque result", stderr=b"")
            with patch.object(prep.subprocess, "run", return_value=response) as run:
                for operation, seconds in (("create", 600), ("inspect", 60), ("rm", 60)):
                    docker.command([operation, "opaque"], effect=operation != "inspect")
                    self.assertEqual(run.call_args.kwargs["timeout"], seconds)
                    self.assertEqual(docker.commands[-1]["deadline_seconds"], seconds)

    def test_expired_create_retains_unknown_effect_without_retry_or_raw_output(self):
        with self.fixture.patched():
            inputs = prep.local_inputs(self.fixture.args)
            self.fixture.output.mkdir()
            docker = prep.DockerMetadata(inputs, {})
            error = subprocess.TimeoutExpired("docker create", 600, output=b"private output", stderr=b"private error")
            with patch.object(prep.subprocess, "run", side_effect=error) as run, self.assertRaises(subprocess.TimeoutExpired):
                docker.command(["create", "opaque"], effect=True)
            self.assertEqual(run.call_count, 1)
            receipt = prep.read(self.fixture.output / "command-001-receipt.json")
            self.assertEqual(receipt["status"], "effect_settlement_unknown")
            self.assertEqual(receipt["deadline_seconds"], 600)
            self.assertNotIn("private", json.dumps(receipt))

    def test_cli_termination_unwinds_execution_and_restores_previous_handler(self):
        args = SimpleNamespace(disk_headroom_mib=4096, agent_budget_seconds=100, source_phase_seconds=120,
                               expected_source_sha256=None, execute=True)
        previous = object()
        def terminate(inputs, args):
            handler = handlers.call_args.args[1]
            handler(prep.signal.SIGTERM, None)
        with patch.object(prep, "parser") as parser, patch.object(prep, "local_inputs", return_value={}), \
             patch.object(prep.signal, "signal", return_value=previous) as handlers, \
             patch.object(prep, "execute", side_effect=terminate), self.assertRaises(KeyboardInterrupt):
            parser.return_value.parse_args.return_value = args
            prep.main([])
        self.assertEqual(handlers.call_count, 2)
        self.assertIs(handlers.call_args.args[1], previous)

    def test_publication_binds_current_baseline_abi_and_derived_full_plan_capacity(self):
        with self.fixture.patched():
            inputs, leases, fake, inspection, health = self.run_overlay("musl")
            original_check_output = subprocess.check_output
            with patch.object(prep, "guard_idle", return_value=health), patch.object(prep.shutil, "disk_usage", return_value=SimpleNamespace(free=16 * 1024 ** 3)), \
                 patch.object(prep.subprocess, "check_output", wraps=subprocess.check_output) as command:
                def output(argv, **kwargs):
                    if argv[0] == "colima":
                        return "Filesystem 1B-blocks Used Available Use% Mounted\nworker 999999999999 0 17179869184 0% /var/lib/docker\n"
                    return original_check_output(argv, **kwargs)
                command.side_effect = output
                result = prep.publish_environment(inputs, inspection, {}, fake, disk_headroom_mib=1024,
                                                  source_seconds=120, agent_seconds=100)
            ready = json.loads((self.fixture.output / "environment-ready.json").read_text())
            base = json.loads((self.fixture.output / "base-manifest.json").read_text())
            self.assertEqual(result["gateway_requests"], 1)
            self.assertEqual(result["gateway_unknown_usage"], 1)
            self.assertEqual(ready["gateway_ledger_sha256"], inputs["baseline"]["sha256"])
            self.assertEqual(ready["future_two_slot_disk_admission"]["required_free_bytes"], 5120 * 1024 ** 2)
            self.assertEqual(base["preparation"]["required_agent_platform"], "linux-x64-musl")
            self.assertFalse(base["preparation"]["source_dispatch_authorized_by_this_file"])
            self.assertNotIn(str((self.fixture.task_path / "tests/config.json").relative_to(self.fixture.root)), ready["evidence"])

    def test_loader_elf_and_tar_bounds_are_validated_without_extraction(self):
        for data in (b"not elf", elf(machine=183), elf(endian=2), elf(elf_class=1)):
            with self.assertRaises(ValueError):
                prep.loader_identity(data, "glibc", "/loader")
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            item = tarfile.TarInfo("loader")
            item.size = 64
            archive.addfile(item, io.BytesIO(elf()))
        self.assertEqual(prep.copied_metadata(buffer.getvalue()), elf())
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            item = tarfile.TarInfo("link")
            item.type = tarfile.SYMTYPE
            item.linkname = "/outside"
            archive.addfile(item)
        with self.assertRaises(ValueError):
            prep.copied_metadata(buffer.getvalue())


def shutil_remove(path):
    shutil.rmtree(path)


if __name__ == "__main__":
    unittest.main()
