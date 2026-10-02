"""Verify an imported repository image without starting its container, then publish preparation evidence.

The default CLI validates local inputs only. --execute performs the exclusive,
zero-model worker inspection. Existing or uncertain evidence is never overwritten.
"""

import argparse
import base64
import datetime
import hashlib
import http.client
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import subprocess
import tarfile
import tomllib
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from repository_launch import BENCH, DATASET, ROOT, environment, guard_idle, validate_task_files
from repository_oracle import zero_activity
from resource_leases import ResourceLeases, capacity_policy
import runtime_artifacts
from worker_admission import maintenance_session, write_evidence

LOADERS = {
    "musl": ("/lib/ld-musl-x86_64.so.1",),
    "glibc": ("/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"),
}
SHA256 = re.compile(r"[a-f0-9]{64}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def safe_path(value, *, root=None, must_exist=True):
    """Reject aliases before resolving: no symlink ancestor, traversal or external input."""
    root = Path(ROOT if root is None else root).absolute()
    path = Path(value)
    path = path.absolute() if path.is_absolute() else (root / path).absolute()
    require(".." not in path.parts and path.is_relative_to(root), "Path is outside the repository")
    for candidate in (*reversed(path.parents), path):
        require(not candidate.is_symlink(), "Symlink paths are not preparation identities")
    if must_exist:
        require(path.exists(), "Preparation input is missing")
    return path


def digest(path):
    path = safe_path(path)
    require(path.is_file(), "Preparation input must be a regular file")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    value = json.loads(safe_path(path).read_bytes())
    require(isinstance(value, dict), "Preparation JSON must be an object")
    return value


def identity(path):
    return {"file": str(path), "sha256": digest(path)}


def ledger_snapshot(path):
    path = safe_path(path)
    raw = path.read_bytes()
    rows = json.loads(raw).get("requests")
    require(isinstance(rows, list), "Request ledger is not a request list")
    require(all(isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"]
                and row.get("finishedAt") and "estimatedUsd" in row for row in rows),
            "Request ledger has unfinished or unverified rows")
    ids = [row["id"] for row in rows]
    require(len(ids) == len(set(ids)), "Duplicate request ledger identity")
    return {"sha256": hashlib.sha256(raw).hexdigest(), "requests": len(rows),
            "unknown": sum(row["estimatedUsd"] is None for row in rows),
            "request_ids": ids, "all_finishedAt": True}


def local_inputs(args):
    manifest_path = safe_path(args.manifest)
    import_path = safe_path(args.import_result)
    config_path = safe_path(args.registry_config or manifest_path.parent / "registry-config.json")
    output = safe_path(args.output, must_exist=False)
    gateway = safe_path(args.gateway_directory)
    dataset = safe_path(args.dataset)
    validator = safe_path(args.environment_validator)
    require(validator.suffix == ".py", "Environment validator must be an explicit Python source")
    for path, expected in ((manifest_path, args.expected_manifest_sha256),
                           (import_path, args.expected_import_result_sha256)):
        if expected is not None:
            require(SHA256.fullmatch(expected) and digest(path) == expected, "Pinned input hash differs")
    origin = urlsplit(args.gateway_url)
    require(origin.scheme == "http" and origin.hostname in ("localhost", "127.0.0.1")
            and origin.path in ("", "/") and origin.username is None and origin.password is None
            and not origin.query and not origin.fragment and origin.port != 0,
            "Gateway must be an explicit local HTTP origin")
    gateway_url = args.gateway_url.rstrip("/")
    require(isinstance(args.task, str) and args.task not in ("", ".", "..")
            and Path(args.task).name == args.task, "Task identity must be one path component")
    manifest = read(manifest_path)
    task = manifest.get("tasks", {}).get(args.task)
    require(isinstance(task, dict), "Task is absent from the preparation manifest")
    image = task.get("image", {})
    require(isinstance(image, dict) and isinstance(image.get("name"), str) and image["name"]
            and image.get("id") == image.get("manifest_digest")
            and all(isinstance(image.get(key), str) and re.fullmatch(r"sha256:[a-f0-9]{64}", image[key])
                    for key in ("id", "manifest_digest", "config_digest")), "Pinned image identity is invalid")
    config = read(config_path)
    require("sha256:" + digest(config_path) == image["config_digest"], "Registry config digest differs")
    diff_ids = config.get("rootfs", {}).get("diff_ids")
    require(config.get("architecture") == "amd64" and config.get("os") == "linux"
            and isinstance(diff_ids, list) and bool(diff_ids)
            and all(isinstance(item, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", item) for item in diff_ids),
            "Registry config has unsupported platform or unverified root filesystem")
    workdir = config.get("config", {}).get("WorkingDir")
    require(isinstance(workdir, str) and workdir.startswith("/") and ".." not in Path(workdir).parts,
            "Registry working directory is invalid")
    imported = read(import_path)
    manifest_sha = digest(manifest_path)
    require(imported.get("status") == "ready" and imported.get("task") == args.task
            and imported.get("image") == image and imported.get("image_id") == image["id"]
            and safe_path(imported.get("manifest_file", "")) == manifest_path
            and imported.get("manifest_sha256") == manifest_sha,
            "Import receipt does not bind this task and manifest")
    require(safe_path(imported.get("gateway_directory", "")) == gateway
            and imported.get("gateway_health_url") == gateway_url + "/health", "Import gateway differs")
    require(type(imported.get("layers_verified")) is int
            and imported["layers_verified"] == imported.get("uncompressed_diff_ids_verified") == len(diff_ids),
            "Imported layers were not completely verified")
    profile = manifest.get("vm", {}).get("profile")
    require(isinstance(profile, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", profile)
            and profile != "default", "Preparation requires an explicit dedicated worker")
    pool = capacity_policy(manifest.get("resource_pool"))
    resources = task.get("resources")
    require(isinstance(resources, dict) and resources.get("os") == "linux"
            and all(type(resources.get(key)) is int and resources[key] > 0 for key in ("cpus", "memory_mb", "storage_mb"))
            and resources["cpus"] <= pool["cpus"] and resources["memory_mb"] <= pool["memory_mb"],
            "Task resource requirements differ from the worker")
    files = task.get("files_sha256")
    require(isinstance(files, dict) and bool(files), "Opaque official task hashes are missing")
    task_path = safe_path(dataset / "v2/tasks" / args.task)
    for name, expected in files.items():
        require(isinstance(name, str) and bool(name) and not Path(name).is_absolute()
                and ".." not in Path(name).parts and SHA256.fullmatch(expected or ""), "Invalid task file identity")
        safe_path(task_path / name)
    validate_task_files(task_path, files, dataset=dataset)
    revision = subprocess.check_output(["git", "-C", str(dataset), "rev-parse", "HEAD"], text=True, timeout=15).strip()
    require(revision == manifest.get("dataset_revision"), "Official dataset revision differs")
    task_metadata = tomllib.loads((task_path / "task.toml").read_text())
    metadata_env = task_metadata.get("environment", {})
    require(metadata_env.get("docker_image") == image["name"]
            and {key: metadata_env.get(key) for key in resources} == resources, "Official task metadata differs")
    execution_env = metadata_env.get("env", {})
    require(isinstance(execution_env, dict) and all(isinstance(key, str) and isinstance(value, str)
                                                 for key, value in execution_env.items()), "Invalid task environment metadata")
    replay_path = safe_path(dataset / "v2/tooling/patch_replay.py")
    extra_evidence = {}
    for key in ("registry_resolution", "registry_plan", "materialization"):
        item = manifest.get(key)
        if item is None:
            continue
        require(isinstance(item, dict) and isinstance(item.get("path"), str), "Invalid metadata evidence identity")
        path = safe_path(item["path"])
        require(digest(path) == item.get("sha256"), "Metadata evidence changed")
        row = read(path)
        if key == "materialization":
            require(row.get("status") == "verified" and row.get("task") == args.task
                    and row.get("dataset_revision") == revision
                    and {name: value.get("sha256") for name, value in row.get("files", {}).items()} == files,
                    "Opaque materialization evidence differs")
        extra_evidence[path] = digest(path)
    selection = safe_path(manifest.get("selection_manifest", ""))
    require(digest(selection) == manifest.get("selection_sha256"), "Preparation selection identity differs")
    socket_path = Path.home() / ".colima" / profile / "docker.sock"
    # Socket itself may be a Unix socket; no Docker contact during local validation.
    for parent in socket_path.parents:
        require(not parent.is_symlink(), "Worker socket has a symlink ancestor")
    baseline = ledger_snapshot(gateway / "budget.json")
    if args.expected_ledger_sha256 is not None:
        require(baseline["sha256"] == args.expected_ledger_sha256, "Pinned ledger baseline differs")
    pins = {manifest_path: manifest_sha, import_path: digest(import_path), config_path: digest(config_path),
            selection: digest(selection), replay_path: digest(replay_path), validator: digest(validator),
            safe_path(__file__): digest(__file__), safe_path(runtime_artifacts.__file__): digest(runtime_artifacts.__file__), **extra_evidence,
            **{task_path / name: expected for name, expected in files.items()}}
    return {"manifest": manifest, "manifest_path": manifest_path, "manifest_sha256": manifest_sha,
            "import_path": import_path, "config_path": config_path, "config": config, "task": args.task,
            "task_data": task, "task_path": task_path, "dataset": dataset, "revision": revision,
            "replay_path": replay_path, "execution_env": execution_env, "output": output,
            "gateway": gateway, "gateway_url": gateway_url, "validator": validator, "profile": profile,
            "socket": socket_path, "pool": pool, "resources": resources, "baseline": baseline, "pins": pins,
            "metadata_evidence": [selection, *extra_evidence]}


def verify_pins(inputs):
    require(all(digest(path) == expected for path, expected in inputs["pins"].items()), "Preparation input changed")
    require(ledger_snapshot(inputs["gateway"] / "budget.json") == inputs["baseline"], "Request ledger changed during preparation")


def loader_identity(data, kind, path):
    require(len(data) >= 64 and data[:4] == b"\x7fELF" and data[4:7] == bytes((2, 1, 1))
            and int.from_bytes(data[18:20], "little") == 62, "Loader is not little-endian ELF64 x86_64")
    return {"kind": kind, "loader_path": path, "loader_sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data), "elf_class": 64, "elf_machine": "x86_64", "actual_image_overlay_verified": True}


def shell_interpreter(data):
    """Read the system shell's ELF PT_INTERP; installed secondary loaders do not choose its ABI."""
    parsed = runtime_artifacts.elf_interpreter(data, "x64")
    return {"path": "/bin/sh", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "elf_class": 64, "elf_machine": "x86_64", "pt_interp": parsed["interpreter"],
            "libc_kind": parsed["libc"], "actual_image_overlay_verified": True}


def copied_metadata(raw):
    require(len(raw) <= 8 * 1024 ** 2, "Environment metadata archive exceeds bound")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        members = archive.getmembers()
        require(len(members) == 1 and members[0].isfile() and members[0].size <= 4 * 1024 ** 2,
                "Metadata archive must contain exactly one bounded regular file")
        source = archive.extractfile(members[0])
        require(source is not None, "Metadata archive file is missing")
        data = source.read(4 * 1024 ** 2 + 1)
        require(len(data) == members[0].size, "Metadata archive file is incomplete")
        return data


class DockerMetadata:
    """Only command hashes/structural facts are published; stderr and environment stay private."""

    def __init__(self, inputs, env):
        self.inputs, self.env, self.commands = inputs, env, []
        self.cli = ["docker", "--host", "unix://" + str(inputs["socket"])]

    def command(self, argv, *, effect=False):
        index = len(self.commands) + 1
        record = {"argv": self.cli + argv, "started_at": now(), "effect_possible": effect}
        self.commands.append(record)
        write_evidence(self.inputs["output"] / f"command-{index:03}-intent.json", record)
        try:
            result = subprocess.run(self.cli + argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=60, env=self.env, cwd=ROOT)
            record.update(finished_at=now(), exit_code=result.returncode,
                          stdout_bytes=len(result.stdout), stdout_sha256=hashlib.sha256(result.stdout).hexdigest(),
                          stderr_bytes=len(result.stderr), stderr_sha256=hashlib.sha256(result.stderr).hexdigest())
            require(result.returncode == 0, "Docker metadata command failed")
            return result.stdout
        except BaseException as error:
            record.update(finished_at=now(), status="effect_settlement_unknown" if effect else "read_failed",
                          error_type=type(error).__name__)
            raise
        finally:
            write_evidence(self.inputs["output"] / f"command-{index:03}-receipt.json", record)

    def head(self, cid, path):
        connection = http.client.HTTPConnection("localhost", timeout=30)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(30)
        try:
            connection.sock.connect(str(self.inputs["socket"]))
            connection.request("HEAD", "/containers/" + cid + "/archive?" + urlencode({"path": path}))
            response = connection.getresponse()
            response.read()
            if response.status == 404:
                return None
            require(response.status == 200, "Docker archive stat failed")
            encoded = response.getheader("X-Docker-Container-Path-Stat")
            require(isinstance(encoded, str) and len(encoded) <= 16384, "Docker archive stat is invalid")
            stat = json.loads(base64.b64decode(encoded, validate=True))
            require(isinstance(stat, dict) and type(stat.get("mode")) is int, "Docker archive stat is invalid")
            return stat
        finally:
            connection.close()

    def copy(self, cid, path):
        return copied_metadata(self.command(["cp", "-L", cid + ":" + path, "-"]))


def inspect_overlay(inputs, leases, claim, docker, env):
    baseline = inputs["baseline"]
    record = {"schema": 1, "observed_at": now(), "task": inputs["task"],
              "source_sha256": digest(__file__), "import_result_sha256": digest(inputs["import_path"]),
              "image_manifest_sha256": inputs["manifest_sha256"], "ledger_before": baseline,
              "inspection_container_started": False, "model_requests": 0, "oracle_or_install_run": False,
              "task_semantic_content_read": False, "maintenance_admission_id": claim.admission_id}

    def activity(cid=None):
        state = guard_idle(env)
        zero_activity(state)
        require(state.get("requests") == baseline["requests"] and state.get("unknownUsage") == baseline["unknown"],
                "Gateway counters differ from the ledger baseline")
        verify_pins(inputs)
        resources = read(leases.path)
        require(not resources["leases"] and resources.get("admission", {}).get("admission_id") == claim.admission_id,
                "Maintenance ownership differs")
        containers = docker.command(["ps", "-aq", "--no-trunc"]).decode().split()
        require(containers == ([] if cid is None else [cid]), "Unexpected worker containers")
        return state

    cid = None
    try:
        activity()
        fmt = ('{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},'
               '"layers":{{json .RootFS.Layers}},"workdir":{{json .Config.WorkingDir}},"size":{{json .Size}}}')
        expected = inputs["task_data"]["image"]
        image = json.loads(docker.command(["image", "inspect", "--format", fmt, expected["name"]]))
        require(image["id"] == expected["id"] and image["architecture"] == "amd64" and image["os"] == "linux"
                and image["layers"] == inputs["config"]["rootfs"]["diff_ids"]
                and image["workdir"] == inputs["config"]["config"]["WorkingDir"], "Actual image metadata differs")
        record.update(image_id=image["id"], platform={"architecture": image["architecture"], "os": image["os"]},
                      rootfs_diff_ids_match=True, image_size_bytes=image["size"])
        name = "velaros-metadata-" + claim.admission_id
        record["inspection_container_name"] = name
        try:
            value = docker.command(["create", "--pull=never", "--name", name, "--network", "none",
                "--cpus", str(inputs["resources"]["cpus"]), "--memory", str(inputs["resources"]["memory_mb"]) + "m",
                "--entrypoint", "/bin/true", "--label", "velaros.bench.metadata-owner=" + claim.admission_id,
                "--label", "velaros.bench.metadata-manifest=" + inputs["manifest_sha256"], image["id"]], effect=True).decode().strip()
            require(re.fullmatch(r"[a-f0-9]{64}", value), "Created container identity is unknown")
            cid = value
        except BaseException:
            claim.block("metadata_container_create_outcome_unknown")
            raise
        record["inspection_container_id"] = cid
        fmt = ('{"id":{{json .Id}},"image":{{json .Image}},"state":{{json .State}},'
               '"nano_cpus":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},'
               '"network":{{json .HostConfig.NetworkMode}},"workdir":{{json .Config.WorkingDir}},'
               '"owner":{{json (index .Config.Labels "velaros.bench.metadata-owner")}},'
               '"manifest":{{json (index .Config.Labels "velaros.bench.metadata-manifest")}}}')
        container = json.loads(docker.command(["inspect", "--format", fmt, cid]))
        require(container["id"] == cid and container["image"] == image["id"]
                and container["owner"] == claim.admission_id and container["manifest"] == inputs["manifest_sha256"],
                "Created container ownership differs")
        require(container["state"]["Status"] == "created" and container["state"]["Running"] is False
                and container["state"]["StartedAt"].startswith("0001-01-01")
                and container["nano_cpus"] == inputs["resources"]["cpus"] * 1000000000
                and container["memory"] == inputs["resources"]["memory_mb"] * 1024 ** 2
                and container["network"] == "none" and container["workdir"] == image["workdir"],
                "Container was started or its configuration differs")
        activity(cid)
        record["container_state"] = "created"
        record["container_resources"] = {"nano_cpus": container["nano_cpus"], "memory_bytes": container["memory"], "network_mode": "none"}
        stat = docker.head(cid, image["workdir"])
        require(stat and stat["mode"] & (1 << 31), "Image working directory does not exist")
        record["working_directory"] = {"path": image["workdir"], "exists_as_directory": True,
            "registry_image_container_metadata_match": True, "docker_head_stat": stat, "repository_content_read": False}
        facts = dict(line.split("=", 1) for line in docker.copy(cid, "/etc/os-release").decode().splitlines() if "=" in line)
        record["os_release"] = {key: facts[key].strip('"') for key in ("ID", "VERSION_ID", "PRETTY_NAME") if key in facts}
        require(docker.head(cid, "/bin/sh") is not None, "System shell is missing from the actual image")
        primary = shell_interpreter(docker.copy(cid, "/bin/sh"))
        record["primary_shell"] = primary
        probes = []
        for kind, paths in LOADERS.items():
            for path in paths:
                present = docker.head(cid, path) is not None
                probes.append({"kind": kind, "path": path, "present": present})
        record["loader_path_probes"] = probes
        if not any(item["path"] == primary["pt_interp"] for item in probes):
            probes.append({"kind": primary["libc_kind"], "path": primary["pt_interp"],
                           "present": docker.head(cid, primary["pt_interp"]) is not None, "role": "primary"})
        require(any(item["path"] == primary["pt_interp"] and item["present"] for item in probes),
                "System shell interpreter is missing from the actual image")
        record["libc"] = loader_identity(docker.copy(cid, primary["pt_interp"]), primary["libc_kind"], primary["pt_interp"])
        record["libc"]["selection_basis"] = "system_shell_elf_pt_interp"
        record["status"] = "ready"
    except BaseException as error:
        record.update(status="failed", error_type=type(error).__name__)
        raise
    finally:
        try:
            if cid:
                try:
                    require(docker.command(["rm", "-v", cid], effect=True).decode().strip() == cid,
                            "Container cleanup identity is unknown")
                    record["inspection_container_removed"] = True
                except BaseException:
                    claim.block("metadata_container_cleanup_unknown")
                    raise
            try:
                activity()
                record.update(containers_after=[], ledger_after=ledger_snapshot(inputs["gateway"] / "budget.json"))
                require(record["ledger_before"] == record["ledger_after"], "Preparation ledger changed")
            except BaseException:
                claim.block("metadata_inspection_physical_or_ledger_settlement_unknown")
                raise
        except BaseException as error:
            record.update(status="failed", error_type=type(error).__name__)
            raise
        finally:
            record["finished_at"] = now()
            write_evidence(inputs["output"] / "inspection-in-progress.json", record)
    return record


def publish_environment(inputs, inspection, env, docker, *, disk_headroom_mib, source_seconds, agent_seconds):
    verify_pins(inputs)
    require(subprocess.check_output(["git", "-C", str(inputs["dataset"]), "rev-parse", "HEAD"],
                                   text=True, timeout=15).strip() == inputs["revision"], "Dataset revision changed before publication")
    health = guard_idle(env)
    zero_activity(health)
    baseline = inputs["baseline"]
    require(health.get("requests") == baseline["requests"] and health.get("unknownUsage") == baseline["unknown"], "Gateway counters changed")
    require(inspection.get("status") == "ready" and inspection.get("inspection_container_removed") is True
            and inspection.get("active_leases_after") == 0 and inspection.get("admission_after") is None
            and inspection.get("released_admission", {}).get("status") == "released", "Inspection is not physically settled")
    resource_path = safe_path(BENCH / "campaign/resource-leases/resources.json")
    resource_sha = digest(resource_path)
    resources = read(resource_path)
    require(not resources["leases"] and resources.get("admission") is None, "Worker is not released")
    require(next((row for row in resources.get("admission_history", [])
                  if row["admission_id"] == inspection["maintenance_admission_id"]), None) == inspection["released_admission"],
            "Released maintenance identity differs")
    require(docker.command(["ps", "-aq", "--no-trunc"]).decode().split() == [], "Preparation containers remain")
    fmt = '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"layers":{{json .RootFS.Layers}}}'
    image = json.loads(docker.command(["image", "inspect", "--format", fmt, inputs["task_data"]["image"]["name"]]))
    require(image["id"] == inspection["image_id"] and image["os"] == "linux" and image["architecture"] == "amd64"
            and image["layers"] == inputs["config"]["rootfs"]["diff_ids"], "Image changed before publication")
    vm = subprocess.check_output(["colima", "-p", inputs["profile"], "ssh", "--", "df", "-B1", "/var/lib/docker"],
                                 env=env, text=True, timeout=30)
    vm_free = int(vm.strip().splitlines()[-1].split()[3])
    host_free = shutil.disk_usage(inputs["output"]).free
    threshold = (inputs["pool"]["max_active_attempts"] * inputs["resources"]["storage_mb"] + disk_headroom_mib) * 1024 ** 2
    require(vm_free >= threshold and host_free >= threshold, "Current full-plan physical disk capacity is insufficient")
    at, out = now(), inputs["output"]
    platform = "linux-x64-" + inspection["libc"]["kind"]
    evidence_paths = [inputs["import_path"], out / "inspection.json", inputs["manifest_path"], inputs["config_path"]]
    # Official task files stay opaque hashes, including any JSON under tests/solution.
    evidence_paths.extend(inputs["metadata_evidence"])
    evidence = {str(path.relative_to(ROOT)): digest(path) for path in evidence_paths}
    ready = {"schema": 1, "observed_at": at, "status": "environment_ready", "task": inputs["task"],
        "image_id": inspection["image_id"], "required_agent_platform": platform, "platform": inspection["platform"],
        "libc": inspection["libc"], "primary_shell": inspection["primary_shell"], "working_directory": inspection["working_directory"],
        "official_task_revision": inputs["revision"], "official_task_files_verified": len(inputs["task_data"]["files_sha256"]),
        "evidence": evidence, "helper_files_sha256": {str(Path(__file__).absolute().relative_to(ROOT)): digest(__file__),
                                                       str(Path(runtime_artifacts.__file__).absolute().relative_to(ROOT)): digest(runtime_artifacts.__file__),
                                                       str(inputs["validator"].relative_to(ROOT)): digest(inputs["validator"])},
        "container_ids": [], "active_lease_count": 0, "admission": None,
        "gateway_directory": str(inputs["gateway"]), "gateway_url": inputs["gateway_url"],
        "gateway_request_ids": baseline["request_ids"], "baseline_request_ids": baseline["request_ids"],
        "preparation_model_request_increment": 0, "gateway_request_count": baseline["requests"],
        "gateway_unknown_request_count": baseline["unknown"], "gateway_request_identity_unchanged": True,
        "gateway_ledger_sha256": baseline["sha256"], "gateway_ledger_bytes_unchanged": True,
        "gateway_active_requests": health["activeUpstreamRequests"], "gateway_queued_requests": health["scheduler"]["queued"],
        "host_free_bytes": host_free, "vm_docker_free_bytes": vm_free,
        "future_two_slot_disk_admission": {"required_free_bytes": threshold, "headroom_mib": disk_headroom_mib,
            "per_attempt_storage_mib": inputs["resources"]["storage_mb"], "max_concurrent_attempts": inputs["pool"]["max_active_attempts"],
            "host_passes": True, "vm_passes": True, "status": "requires_fresh_probe",
            "scope": "Physical capacity observation; runtime quota and source admission are separate gates."},
        "runtime_storage_quota_verified": False, "oracle_or_install_or_paid_source_run": False, "task_semantic_content_read": False}
    ready_raw = (json.dumps(ready, indent=2) + "\n").encode()
    manifest = inputs["manifest"]
    base = {"schema": 1, "role": "development_environment_preparation", "frozen_at": at,
        "selection_manifest": manifest["selection_manifest"], "selection_sha256": manifest["selection_sha256"],
        "dataset_revision": inputs["revision"], "official_replay_sha256": digest(inputs["replay_path"]),
        "tasks": {inputs["task"]: {"files_sha256": inputs["task_data"]["files_sha256"], "image": inputs["task_data"]["image"]}},
        "resources": inputs["resources"], "execution_env": inputs["execution_env"], "resource_pool": inputs["pool"],
        "trial_concurrency": 1, "source_phase_seconds": source_seconds, "agent_budget_seconds": agent_seconds,
        "attempts": [{"task": inputs["task"], "state": "preparation_only"}],
        "preparation": {"task_files_verified_against_official_git": len(inputs["task_data"]["files_sha256"]),
            "required_agent_platform": platform, "image_manifest": str(inputs["manifest_path"]),
            "image_manifest_sha256": inputs["manifest_sha256"], "image_import_evidence": str(inputs["import_path"]),
            "official_oracle_required": True, "participants_install_required": True, "source_dispatch_authorized_by_this_file": False},
        "provenance": {"environment_ready": {"file": str(out / "environment-ready.json"), "sha256": hashlib.sha256(ready_raw).hexdigest()},
            "actual_inspection": identity(out / "inspection.json"), "import_manifest": identity(inputs["manifest_path"])}}
    final = guard_idle(env)
    zero_activity(final)
    verify_pins(inputs)
    require(digest(resource_path) == resource_sha, "Worker epoch changed before publication")
    # Retain exclusive outputs on validator failure; only result.json authorizes their use.
    write_evidence(out / "environment-ready.json", ready)
    write_evidence(out / "base-manifest.json", base)
    spec = importlib.util.spec_from_file_location("repository_environment_validator", inputs["validator"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    preparation, verified = module.validate_environment_ready(out / "environment-ready.json", out / "base-manifest.json", base,
        inputs["task"], inspection["libc"]["kind"], {"directory": str(inputs["gateway"]), "url": inputs["gateway_url"]})
    verify_pins(inputs)
    require(digest(resource_path) == resource_sha, "Worker epoch changed during publication validation")
    return {"schema": 1, "status": "environment_ready", "observed_at": at, "task": inputs["task"],
        "required_agent_platform": platform, "image_id": inspection["image_id"],
        "environment_ready": identity(out / "environment-ready.json"), "base_manifest_preparation": identity(out / "base-manifest.json"),
        "actual_inspection": identity(out / "inspection.json"), "import": identity(inputs["import_path"]),
        "real_freezer_environment_contract_passed": True, "freezer_source_sha256": digest(inputs["validator"]),
        "freezer_evidence_count": len(verified), "freezer_preparation": preparation,
        "ledger_sha256": baseline["sha256"], "model_requests_added": 0, "gateway_requests": baseline["requests"],
        "gateway_unknown_usage": baseline["unknown"], "containers": 0, "active_leases": 0, "admission": None,
        "VM_free_gib": vm_free / 1024 ** 3, "host_free_gib": host_free / 1024 ** 3,
        "future_two_slot_disk_admission": ready["future_two_slot_disk_admission"], "runtime_storage_quota_verified": False}


def execute(inputs, args):
    require(not inputs["output"].exists(), "Preserve previous or uncertain preparation; choose a new output")
    inputs["output"].mkdir(parents=True, exist_ok=False)
    env = environment(inputs["gateway"], inputs["gateway_url"])
    env["DOCKER_HOST"] = "unix://" + str(inputs["socket"])
    leases = ResourceLeases(BENCH / "campaign/resource-leases", inputs["pool"])
    docker = DockerMetadata(inputs, env)
    result = {"schema": 1, "status": "preparing", "started_at": now(), "task": inputs["task"],
              "source_sha256": digest(__file__), "ledger_before": inputs["baseline"], "model_requests_added": 0}
    inspection = None
    try:
        with maintenance_session(leases, owner=str(inputs["output"]), manifest_sha256=inputs["manifest_sha256"],
                                 worker={"profile": inputs["profile"], "socket": str(inputs["socket"])}) as claim:
            inspection = inspect_overlay(inputs, leases, claim, docker, env)
        resources = read(leases.path)
        inspection.update(active_leases_after=len(resources["leases"]), admission_after=resources.get("admission"),
                          released_admission=next(row for row in resources.get("admission_history", []) if row["admission_id"] == claim.admission_id))
        require(inspection["active_leases_after"] == 0 and inspection["admission_after"] is None
                and inspection["released_admission"]["status"] == "released", "Inspection maintenance epoch is not released")
        write_evidence(inputs["output"] / "inspection.json", inspection)
        result.update(publish_environment(inputs, inspection, env, docker, disk_headroom_mib=args.disk_headroom_mib,
                                         source_seconds=args.source_phase_seconds, agent_seconds=args.agent_budget_seconds))
    except BaseException as error:
        result.update(status="failed", error_type=type(error).__name__)
        raise
    finally:
        resources = read(leases.path)
        result.update(finished_at=now(), active_leases_after=len(resources["leases"]), admission_after=resources.get("admission"))
        write_evidence(inputs["output"] / "result.json", result)
    return result


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    for name in ("manifest", "import-result", "output", "gateway-directory", "environment-validator"):
        cli.add_argument("--" + name, type=Path, required=True)
    cli.add_argument("--task", required=True)
    cli.add_argument("--gateway-url", required=True)
    cli.add_argument("--registry-config", type=Path)
    cli.add_argument("--dataset", type=Path, default=DATASET)
    cli.add_argument("--expected-source-sha256")
    cli.add_argument("--expected-manifest-sha256")
    cli.add_argument("--expected-import-result-sha256")
    cli.add_argument("--expected-ledger-sha256")
    cli.add_argument("--disk-headroom-mib", type=int, default=4096)
    cli.add_argument("--source-phase-seconds", type=int, default=3000)
    cli.add_argument("--agent-budget-seconds", type=int, default=2940)
    cli.add_argument("--execute", action="store_true")
    return cli


def main(argv=None):
    args = parser().parse_args(argv)
    require(args.disk_headroom_mib >= 0 and 0 < args.agent_budget_seconds < args.source_phase_seconds, "Invalid preparation budgets")
    if args.expected_source_sha256 is not None:
        require(digest(__file__) == args.expected_source_sha256, "Preparation source hash differs")
    inputs = local_inputs(args)
    if not args.execute:
        result = {"status": "prepared_inputs_verified_no_worker_execution", "task": args.task,
                  "manifest_sha256": inputs["manifest_sha256"], "import_result_sha256": digest(inputs["import_path"]),
                  "baseline": inputs["baseline"], "ABI": None}
    else:
        result = execute(inputs, args)
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    main()
