"""Run one frozen repository attempt, then replay its patch in a fresh sandbox."""

import argparse
import contextlib
import datetime
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import signal
import urllib.parse
import urllib.request
from pathlib import Path

from worker_admission import admission_session, joined_admission, scope_for, member_identity
from task_exposure import task_exposure
from request_identity import prepare_attempt_environment
from resource_leases import (DispatchError, ResourceLeases, capacity_policy, guard_gateway,
    task_resources, wait_for_settlement, verify_job_containers_stopped, run_attempt_process)

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / ".velaros-workspace/bench"
DATASET = BENCH / "datasets/swebench-pro-v2"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def environment(gateway_directory=None, gateway_url="http://127.0.0.1:48761"):
    gateway = urllib.parse.urlsplit(gateway_url)
    if gateway.scheme != "http" or gateway.hostname not in ("127.0.0.1", "localhost") or gateway.path not in ("", "/"):
        raise ValueError("Gateway must be an explicit local HTTP origin")
    container_url = "http://host.docker.internal:" + str(gateway.port or 80)
    env = {key: value for key, value in os.environ.items()
           if key in ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR")}
    token_path = Path(gateway_directory or BENCH / "campaign") / "gateway-token"
    token = token_path.read_text().strip()
    env.update({"DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(BENCH / "docker-config"),
        "PYTHONPATH": str(ROOT) + os.pathsep + str(DATASET / "v2/tooling"),
        "HARBOR_TELEMETRY": "0", "SCRIPTACT_BENCH_TOKEN_FILE": str(token_path),
        "SCRIPTACT_BENCH_BASE_URL": container_url + "/v1",
        "OPENAI_API_KEY": token, "OPENAI_BASE_URL": container_url + "/v1",
        "OPENAI_API_BASE": gateway_url.rstrip("/") + "/v1", "ANTHROPIC_API_KEY": token,
        "ANTHROPIC_BASE_URL": "http://host.docker.internal:48762",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32768", "SCRIPTACT_GATEWAY_HEALTH_URL": gateway_url.rstrip("/") + "/health"})
    return env


def health(env):
    request = urllib.request.Request(env.get("SCRIPTACT_GATEWAY_HEALTH_URL", "http://127.0.0.1:48761/health"),
        headers={"Authorization": "Bearer " + env["OPENAI_API_KEY"]})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def guard_idle(env):
    """Preparation-only guard: shared image mutation still requires a quiescent worker."""
    state = health(env)
    if (state["activeUpstreamRequests"] or state.get("scheduler", {}).get("queued", 0) or
            subprocess.check_output(["docker", "ps", "--quiet"], env=env, text=True).strip()):
        raise DispatchError("PREPARATION_REQUIRES_IDLE", "Image preparation requires an idle gateway and empty dedicated VM")
    return state



def validate_task_files(task, expected, dataset=DATASET):
    """Reject metadata-only sparse checkouts before Harbor or a paid dispatch."""
    required = {"instruction.md", "task.toml", "environment/Dockerfile", "tests/test.sh"}
    if not required <= expected.keys():
        raise ValueError("Frozen task manifest is incomplete: " + ", ".join(sorted(required - expected.keys())))
    relative = task.relative_to(dataset).as_posix() + "/"
    tracked = subprocess.check_output(["git", "-C", str(dataset), "ls-tree", "-rz", "--name-only",
        "HEAD", "--", relative], text=True).split("\0")
    official = {path[len(relative):] for path in tracked if path.startswith(relative)}
    if set(expected) != official:
        raise ValueError("Frozen task file set differs from the official revision")
    missing = [path for path in sorted(official) if not (task / path).is_file()]
    if missing:
        raise ValueError("Official task checkout is incomplete: " + ", ".join(missing))
    for path, identity in expected.items():
        if digest(task / path) != identity:
            raise ValueError("Official task file changed: " + path)


def validate(manifest, row, env):
    task_exposure(manifest, BENCH / "jobs", require_definition=True)
    if not isinstance(manifest.get("model"), str) or not manifest["model"] or not isinstance(manifest.get("reasoning_effort"), str) or not manifest["reasoning_effort"]:
        raise ValueError("Unexpected campaign configuration")
    for package, version in manifest["dependencies"].items():
        if importlib.metadata.version(package) != version:
            raise ValueError("Frozen harness dependency changed: " + package)
    for key in ("task", "source_job", "replay_job"):
        value = row[key]
        if not value or value in (".", "..") or Path(value).name != value:
            raise ValueError("Invalid task/job name")
    revision = subprocess.check_output(["git", "-C", str(DATASET), "rev-parse", "HEAD"], text=True).strip()
    if revision != manifest["dataset_revision"]:
        raise ValueError("Dataset revision changed")
    for name in ("runtime_artifacts.py", "task_exposure.py", "request_identity.py", "request-identity.mjs", "budget-proxy.mjs", "request-scheduler.mjs", "resource_leases.py", "worker_admission.py", "disk_admission.py", "repository_launch.py", "bundle_integrity.py"):
        if "scripts/agent/harbor/" + name not in manifest["files_sha256"]:
            raise ValueError("Freeze " + name + " in a new execution manifest before dispatch")
    for path, expected in manifest["files_sha256"].items():
        if digest(ROOT / path) != expected:
            raise ValueError("Frozen execution file changed: " + path)
    task = DATASET / "v2/tasks" / row["task"]
    validate_task_files(task, manifest["tasks"][row["task"]]["files_sha256"])
    participant = manifest["participants"][row["participant"]]
    if participant.get("model", "").split("/")[-1] != manifest["model"]:
        raise ValueError("Participant model differs from the campaign")
    if participant.get("kwargs", {}).get("reasoning_effort") != manifest["reasoning_effort"]:
        raise ValueError("Participant reasoning effort differs from the frozen campaign")
    for path, expected in participant["files_sha256"].items():
        if digest(ROOT / path) != expected:
            raise ValueError("Frozen participant file changed: " + path)
    if digest(DATASET / "v2/tooling/patch_replay.py") != manifest["official_replay_sha256"]:
        raise ValueError("Official replay agent changed")
    image = manifest["tasks"][row["task"]]["image"]
    info = json.loads(subprocess.check_output(["docker", "image", "inspect", image["name"]], env=env, text=True))[0]
    if info["Id"] != image["id"] or info["Architecture"] != "amd64" or info["Os"] != "linux":
        raise ValueError("Official task image identity/platform changed")
    system = json.loads(subprocess.check_output(["docker", "info", "--format", "{{json .}}"], env=env, text=True))
    if system["NCPU"] != manifest["vm"]["cpus"] or system["MemTotal"] != manifest["vm"]["memory_bytes"]:
        raise ValueError("Frozen VM CPU/memory changed")
    return task, participant


def command_for(row, participant, task, *, replay=False, install_only=False, execution_env=None):
    execution_env = {} if execution_env is None else execution_env
    if not isinstance(execution_env, dict) or any(
            not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
            or not isinstance(value, str) or "\0" in value
            for key, value in execution_env.items()):
        raise ValueError("Frozen execution environment must contain valid string entries")
    if any(key in participant.get("environment", {}) and participant["environment"][key] != value
           for key, value in execution_env.items()):
        raise ValueError("Participant environment conflicts with the shared execution environment")
    job = row["replay_job"] if replay else row["source_job"]
    if install_only:
        job += "-install"
    command = [str(BENCH / "venv/bin/harbor"), "run", "--path", str(task), "--job-name", job,
        "--jobs-dir", str(BENCH / "jobs"), "--max-retries", "0", "-n", "1", "-k", "1",
        "-e", "scripts.agent.harbor.repository_environment:RepositoryBenchmarkDocker",
        "--allow-agent-host", "host.docker.internal"]
    if replay:
        command += ["-a", "patch_replay:PatchReplayAgent", "-m", "replay",
            "--ak", "source_job=" + str(BENCH / "jobs" / row["source_job"])]
    else:
        command += ["-a", participant["agent"], "-m", participant.get("model", "fixture-unspecified"), "--disable-verification"]
        for key, value in participant["kwargs"].items():
            rendered = json.dumps(value, separators=(",", ":")) if not isinstance(value, str) else value
            command += ["--ak", key + "=" + rendered]
        for key, value in participant.get("environment", {}).items():
            command += ["--ae", key + "=" + str(value)]
    if install_only:
        command.append("--install-only")
    for flag in ("--ae", "--ve"):
        for value in ("UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple",
                      "PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple", "UV_NATIVE_TLS=true",
                      "UV_HTTP_TIMEOUT=30", "UV_HTTP_RETRIES=5"):
            command += [flag, value]
        for key, value in execution_env.items():
            command += [flag, key + "=" + value]
    return job, command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--attempt", type=int, required=True, help="One-based frozen attempt index")
    parser.add_argument("--install-only", action="store_true")
    parser.add_argument("--replay-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--capacity", type=Path)
    parser.add_argument("--admission-id", help="Join an exact phase authorized by the parent worker epoch")
    parser.add_argument("--gateway-directory", type=Path)
    parser.add_argument("--gateway-url")
    parser.add_argument("--allow-unlimited", action="store_true")
    parser.add_argument("--lease-timeout", type=float, default=300)
    parser.add_argument("--settle-timeout", type=float, default=900)
    args = parser.parse_args()
    if args.install_only and args.replay_only:
        parser.error("Choose install-only or replay-only")
    if min(args.lease_timeout, args.settle_timeout) < 0:
        parser.error("Timeouts must be nonnegative")
    manifest = json.loads(args.manifest.read_text())
    manifest_hash = digest(args.manifest)
    if not 1 <= args.attempt <= len(manifest["attempts"]):
        parser.error("Attempt is outside the frozen schedule")
    row = manifest["attempts"][args.attempt - 1]
    gateway = manifest.get("gateway", {})
    if "upstream" in gateway and not isinstance(gateway["upstream"], dict):
        raise ValueError("Frozen gateway upstream must declare baseURL and endpointId")
    gateway_url = args.gateway_url or gateway.get("url", "http://127.0.0.1:48761")
    if args.gateway_url and gateway.get("url") and args.gateway_url != gateway["url"]:
        raise ValueError("Gateway endpoint differs from the frozen manifest")
    env = environment(args.gateway_directory or gateway.get("directory"), gateway_url)
    task, participant = validate(manifest, row, env)
    configured = json.loads(args.capacity.read_text()) if args.capacity else manifest.get("resource_pool")
    capacity = capacity_policy(configured or {"max_active_attempts": 1, "cpus": manifest["vm"]["cpus"],
        "memory_mb": manifest["vm"]["memory_bytes"] // (1024 * 1024)})
    if manifest.get("resource_pool") and manifest["resource_pool"] != capacity:
        raise ValueError("Capacity differs from the frozen resource_pool")
    if capacity["cpus"] > manifest["vm"]["cpus"] or capacity["memory_mb"] * 1024 * 1024 > manifest["vm"]["memory_bytes"]:
        raise ValueError("Resource capacity exceeds the frozen VM")
    demand = task_resources(task, capacity)
    leases = ResourceLeases(BENCH / "campaign/resource-leases", capacity)
    if args.replay_only:
        source_identity = member_identity(manifest, manifest_hash, args.attempt, "source")
        source_job = BENCH / "jobs" / row["source_job"]
        source_receipt = BENCH / "campaign" / (row["source_job"] + "-dispatch.json")
        if not (source_job / "result.json").exists() or not source_receipt.is_file():
            raise DispatchError("SOURCE_NOT_SETTLED", "Replay requires an authenticated, fully settled source")
        previous = json.loads(source_receipt.read_text())
        if (previous.get("status") != "finished" or previous.get("request_identity") != source_identity or
                previous.get("cleanup_error") or previous.get("cleanup_error_code") or
                json.loads((source_job / "request-identity.json").read_text()) != source_identity):
            raise DispatchError("SOURCE_NOT_SETTLED", "Replay cannot reuse an uncertain or mismatched source")
    phases = [True] if args.replay_only else [False] if args.install_only else [False, True]
    def ready_gateway():
        return guard_gateway(health(env), manifest["model"],
            args.allow_unlimited or gateway.get("budget_mode") == "unlimited", manifest["reasoning_effort"],
            upstream=gateway.get("upstream"))
    def cancelled(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, cancelled)
    allowed_phases = ["install"] if args.install_only else ["replay"] if args.replay_only else ["source", "replay"]
    if args.dry_run:
        admission_context = contextlib.nullcontext(None)
        initial_gateway = None
    else:
        initial_gateway = ready_gateway()
        scope = scope_for(manifest, manifest_hash, {args.attempt: allowed_phases},
                          owner=str(args.manifest.resolve()) + ":" + str(args.attempt), batch_id="standalone")
        if (not env.get("DOCKER_HOST", "").startswith("unix://") or
                str(Path(env["DOCKER_HOST"][7:]).resolve()) != scope["worker"]["socket"]):
            raise DispatchError("WORKER_IDENTITY", "Launcher Docker socket differs from the admitted worker")
        admission_context = (joined_admission(leases, args.admission_id, scope["members"].values()) if args.admission_id
            else admission_session(leases, scope, manifest_path=args.manifest, bench=BENCH,
                                   tasks_root=DATASET / "v2/tasks"))
    with admission_context as admission:
        admission_id = admission if isinstance(admission, str) else admission.admission_id if admission else None
        for replay in phases:
            if digest(args.manifest) != manifest_hash:
                raise ValueError("Frozen manifest changed during dispatch")
            job, command = command_for(row, participant, task, replay=replay, install_only=args.install_only,
                                       execution_env=manifest.get("execution_env"))
            if (BENCH / "jobs" / job).exists():
                raise FileExistsError("Keep original results; this job already exists: " + job)
            if args.dry_run:
                print(json.dumps({"job": job, "command": command, "resource_pool": capacity, "demand": demand}))
                continue
            before = initial_gateway if replay == phases[0] else ready_gateway()
            phase = "install" if args.install_only else "replay" if replay else "source"
            identity = {"campaignId": manifest_hash,
                "candidateId": hashlib.sha256(json.dumps(participant, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                "participantId": row["participant"], "taskId": row["task"],
                "attemptId": hashlib.sha256(f"{manifest_hash}:{args.attempt}:{phase}".encode()).hexdigest(),
                "jobId": job, "phase": phase}
            leases.check_admission(admission_id, identity)
            receipt = BENCH / "campaign" / (job + "-dispatch.json")
            data = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "manifest": str(args.manifest.resolve()), "manifest_sha256": manifest_hash,
                "attempt": args.attempt, "phase": phase, "request_identity": identity,
                "budget_before": before, "command": command, "status": "waiting", "resource_pool": capacity, "demand": demand}
            receipt.parent.mkdir(parents=True, exist_ok=True)
            with receipt.open("x") as stream:
                json.dump(data, stream, indent=2)
            lease = None
            started = False
            attempt_env = None
            failure = None
            print("Running " + job, flush=True)
            try:
                lease = leases.acquire(identity, demand, args.lease_timeout, admission_id=admission_id)
                data["lease"] = lease
                # Capacity waits can outlive an upstream switch or authentication failure.
                data["dispatch_budget_before"] = ready_gateway()
                data["status"] = "running"
                receipt.write_text(json.dumps(data, indent=2) + "\n")
                attempt_env = prepare_attempt_environment(env, identity, BENCH / "campaign/attempt-credentials")
                with (BENCH / (job + ".log")).open("x") as log:
                    started = True
                    exit_code = run_attempt_process(command, cwd=ROOT, environment=attempt_env, log=log)
                data.update({"exit_code": exit_code, "status": "finished"})
                if exit_code:
                    raise DispatchError("HARBOR_PROCESS_FAILED", "Harbor process failed; inspect retained job logs: " + job)
                trial_files = list((BENCH / "jobs" / job).glob("*/result.json"))
                if not (BENCH / "jobs" / job / "result.json").exists() or len(trial_files) != 1:
                    raise DispatchError("TRIAL_RESULT_MISSING", "Harbor returned without exactly one completed trial")
                trial = json.loads(trial_files[0].read_text())
                data["trial_result"] = str(trial_files[0])
                if args.install_only:
                    own = health(attempt_env)
                    if own["requests"] or own.get("rejectedRequests", 0):
                        raise DispatchError("INSTALL_MODEL_REQUEST", "Install-only unexpectedly called a model")
                    if trial.get("exception_info") or not (trial.get("agent_setup") or {}).get("finished_at"):
                        raise DispatchError("INSTALL_FAILED", "Agent installation preflight failed")
            except BaseException as error:
                failure = error
                data.update({"status": "failed", "error_type": type(error).__name__,
                             "error_code": getattr(error, "code", "DISPATCH_FAILED"), "error": str(error)})
                raise
            finally:
                cleanup_error = None
                try:
                    job_directory = BENCH / "jobs" / job
                    if job_directory.is_dir():
                        with (job_directory / "request-identity.json").open("x") as stream:
                            json.dump(identity, stream, indent=2)
                    if started:
                        data["attempt_budget_after"] = wait_for_settlement(lambda: health(attempt_env), args.settle_timeout)
                        verify_job_containers_stopped(job_directory, env)
                    if lease:
                        leases.finish(lease, settled=True)
                except BaseException as error:
                    cleanup_error = error
                    data.update({"status": "blocked", "cleanup_error_code": getattr(error, "code", "SETTLEMENT_UNKNOWN"),
                                 "cleanup_error": str(error)})
                    if lease:
                        leases.finish(lease, settled=False, reason=data["cleanup_error_code"])
                data["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                receipt.write_text(json.dumps(data, indent=2) + "\n")
                if cleanup_error and not failure:
                    raise cleanup_error

if __name__ == "__main__":
    main()
