"""Run one frozen repository attempt, then replay its patch in a fresh sandbox."""

import argparse
import datetime
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / ".velaros-workspace/bench"
DATASET = BENCH / "datasets/swebench-pro-v2"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def environment():
    env = {key: value for key, value in os.environ.items()
           if key in ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR")}
    token_path = BENCH / "campaign/gateway-token"
    token = token_path.read_text().strip()
    env.update({"DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(BENCH / "docker-config"),
        "PYTHONPATH": str(ROOT) + os.pathsep + str(DATASET / "v2/tooling"),
        "HARBOR_TELEMETRY": "0", "SCRIPTACT_BENCH_TOKEN_FILE": str(token_path),
        "SCRIPTACT_BENCH_BASE_URL": "http://host.docker.internal:48761/v1",
        "OPENAI_API_KEY": token, "OPENAI_BASE_URL": "http://host.docker.internal:48761/v1",
        "OPENAI_API_BASE": "http://127.0.0.1:48761/v1", "ANTHROPIC_API_KEY": token,
        "ANTHROPIC_BASE_URL": "http://host.docker.internal:48762",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32768"})
    return env


def health(env):
    request = urllib.request.Request("http://127.0.0.1:48761/health",
        headers={"Authorization": "Bearer " + env["OPENAI_API_KEY"]})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def guard_idle(env):
    state = health(env)
    if state["activeUpstreamRequests"] or subprocess.check_output(
            ["docker", "ps", "--quiet"], env=env, text=True).strip():
        raise RuntimeError("Repository launch requires an idle gateway and empty dedicated VM")
    if state["model"] != "gpt-6-sol" or state["limitUsd"] > 1000 or state["committedUpperUsd"] + 20 > state["limitUsd"]:
        raise RuntimeError("Campaign model/budget guard failed")
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
    if manifest["model"] != "gpt-6-sol" or manifest["reasoning_effort"] != "high" or manifest["trial_concurrency"] != 1:
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
    for path, expected in manifest["files_sha256"].items():
        if digest(ROOT / path) != expected:
            raise ValueError("Frozen execution file changed: " + path)
    task = DATASET / "v2/tasks" / row["task"]
    validate_task_files(task, manifest["tasks"][row["task"]]["files_sha256"])
    participant = manifest["participants"][row["participant"]]
    if participant.get("model", "openai/gpt-6-sol").split("/")[-1] != manifest["model"]:
        raise ValueError("Participant model differs from the campaign")
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
        command += ["-a", participant["agent"], "-m", participant.get("model", "openai/gpt-6-sol"), "--disable-verification"]
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
    args = parser.parse_args()
    if args.install_only and args.replay_only:
        parser.error("Choose install-only or replay-only")
    manifest = json.loads(args.manifest.read_text())
    if not 1 <= args.attempt <= len(manifest["attempts"]):
        parser.error("Attempt is outside the frozen schedule")
    row = manifest["attempts"][args.attempt - 1]
    env = environment()
    task, participant = validate(manifest, row, env)
    if args.replay_only and not (BENCH / "jobs" / row["source_job"] / "result.json").exists():
        raise ValueError("Source job is not complete")
    phases = [True] if args.replay_only else [False] if args.install_only else [False, True]
    for replay in phases:
        job, command = command_for(row, participant, task, replay=replay, install_only=args.install_only,
                                   execution_env=manifest.get("execution_env"))
        if (BENCH / "jobs" / job).exists():
            raise FileExistsError("Keep original results; this job already exists: " + job)
        if args.dry_run:
            print(json.dumps({"job": job, "command": command}))
            continue
        before = guard_idle(env)
        receipt = BENCH / "campaign" / (job + "-dispatch.json")
        data = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "manifest": str(args.manifest.resolve()), "manifest_sha256": digest(args.manifest),
            "attempt": args.attempt, "phase": "install" if args.install_only else "replay" if replay else "source",
            "budget_before": before, "command": command, "status": "running"}
        with receipt.open("x") as stream:
            json.dump(data, stream, indent=2)
        print("Running " + job, flush=True)
        try:
            # Harbor owns per-phase deadlines and cancellation; no outer kill may
            # bypass its sandbox cleanup or the reserved patch-capture interval.
            with (BENCH / (job + ".log")).open("x") as log:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            data.update({"exit_code": result.returncode, "status": "finished"})
            if result.returncode:
                raise RuntimeError("Harbor process failed; inspect retained job logs: " + job)
            trial_files = list((BENCH / "jobs" / job).glob("*/result.json"))
            if not (BENCH / "jobs" / job / "result.json").exists() or len(trial_files) != 1:
                raise RuntimeError("Harbor process returned without exactly one completed trial")
            trial = json.loads(trial_files[0].read_text())
            data["trial_result"] = str(trial_files[0])
            if args.install_only:
                if health(env)["requests"] != before["requests"]:
                    raise RuntimeError("Install-only unexpectedly called a model")
                if trial.get("exception_info") or not (trial.get("agent_setup") or {}).get("finished_at"):
                    raise RuntimeError("Agent installation preflight failed; inspect retained trial result")
        except BaseException as error:
            data.update({"status": "failed", "error_type": type(error).__name__, "error": str(error)})
            raise
        finally:
            data.update({"finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "budget_after": health(env)})
            receipt.write_text(json.dumps(data, indent=2) + "\n")


if __name__ == "__main__":
    main()
