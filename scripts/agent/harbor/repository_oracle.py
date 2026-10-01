"""Run one official zero-model Oracle under a frozen, persistent worker admission."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import math
import os
import re
import signal
import threading
import uuid
from urllib.parse import unquote, urlsplit
from pathlib import Path

from repository_launch import BENCH, DATASET, ROOT, digest, environment, health, validate
from request_identity import prepare_attempt_environment, validate_identity
from resource_leases import (DispatchError, ResourceLeases, admission_scope, capacity_policy,
    guard_gateway, run_attempt_process, task_resources, verify_job_containers_stopped, wait_for_settlement)
from worker_admission import admission_session, joined_admission, write_evidence


PARTICIPANT = "official-oracle-preflight"


def oracle_identity(manifest_hash, task, job):
    return validate_identity({"campaignId": manifest_hash, "candidateId": manifest_hash,
        "participantId": PARTICIPANT, "taskId": task,
        "attemptId": hashlib.sha256(f"{manifest_hash}:{job}:oracle".encode()).hexdigest(),
        "jobId": job, "phase": "install"})


def oracle_scope(manifest, manifest_hash, task, job, owner):
    identity = oracle_identity(manifest_hash, task, job)
    profile = manifest.get("vm", {}).get("profile")
    return admission_scope({"kind": "standalone", "manifest_sha256": manifest_hash,
        "plan_sha256": None, "batch_id": "oracle-preflight", "owner": str(owner),
        "worker": {"profile": profile, "socket": str((Path.home() / ".colima").resolve() / str(profile) / "docker.sock")},
        "members": {identity["attemptId"]: identity}})


def oracle_command(task, job, execution_env):
    if not isinstance(execution_env, dict) or any(
            not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or
            not isinstance(value, str) or "\0" in value or
            re.search(r"API_KEY|TOKEN|SECRET|CREDENTIAL", key, re.I) or
            key.startswith(("OPENAI_", "ANTHROPIC_", "SCRIPTACT_", "AZURE_OPENAI_"))
            for key, value in execution_env.items()):
        raise ValueError("Oracle execution environment must contain valid non-credential string entries")
    command = [str(BENCH / "venv/bin/harbor"), "run", "--path", str(task), "--job-name", job,
        "--jobs-dir", str(BENCH / "jobs"), "--max-retries", "0", "-n", "1", "-k", "1",
        "-e", "scripts.agent.harbor.repository_environment:RepositoryBenchmarkDocker",
        "--allow-agent-host", "host.docker.internal", "-a", "oracle"]
    for flag in ("--ae", "--ve"):
        for value in ("UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple",
                      "PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple",
                      "UV_NATIVE_TLS=true", "UV_HTTP_TIMEOUT=30", "UV_HTTP_RETRIES=5"):
            command.extend([flag, value])
        for key, value in execution_env.items():
            command.extend([flag, key + "=" + value])
    return command


def oracle_environment(env):
    # Harbor's host execution barrier needs scoped health access. These host
    # settings are not --ae/--ve container exports; raw provider keys and model
    # endpoints remain excluded.
    allowed = {"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR",
               "DOCKER_HOST", "DOCKER_CONFIG", "PYTHONPATH", "HARBOR_TELEMETRY",
               "SCRIPTACT_BENCH_TOKEN_FILE", "SCRIPTACT_GATEWAY_HEALTH_URL"}
    return {key: value for key, value in env.items() if key in allowed}


def ledger_snapshot(path, identity):
    raw = Path(path).read_bytes()
    calls = json.loads(raw)["requests"]
    if not isinstance(calls, list):
        raise DispatchError("ORACLE_LEDGER_INVALID", "Model ledger requests must be a list")
    ids, own = [], []
    for call in calls:
        request_id = call.get("id")
        if not isinstance(request_id, str) or not request_id or request_id in ids:
            raise DispatchError("ORACLE_LEDGER_INVALID", "Model ledger contains missing or duplicate request identities")
        ids.append(request_id)
        owner = call.get("identity")
        if isinstance(owner, dict) and (owner.get("attemptId") == identity["attemptId"] or owner.get("jobId") == identity["jobId"]):
            if owner != identity:
                raise DispatchError("ORACLE_LEDGER_IDENTITY", "Oracle ledger identity conflicts with the frozen member")
            own.append(request_id)
    return {"sha256": hashlib.sha256(raw).hexdigest(), "requests": len(ids), "request_ids": ids,
            "oracle_request_ids": own}


def verify_result_identity(job, result_path, task):
    """Bind successful result metadata to this exact task, trial and job directory."""
    trial = json.loads(result_path.read_text())
    job_result = json.loads((job / "result.json").read_text())
    persisted = json.loads((result_path.parent / "config.json").read_text())
    embedded = trial.get("config", {})
    def same_path(value, expected):
        return isinstance(value, str) and Path(value).is_absolute() and Path(value).resolve() == expected.resolve()
    uri = urlsplit(trial.get("trial_uri", ""))
    valid = (result_path.resolve().parent == result_path.parent.resolve() and result_path.parent.parent.resolve() == job.resolve() and
        trial.get("trial_name") == result_path.parent.name and
        isinstance(trial.get("task_name"), str) and Path(trial["task_name"]).name == task.name and
        same_path((trial.get("task_id") or {}).get("path"), task) and
        uri.scheme == "file" and uri.netloc in ("", "localhost") and not uri.query and not uri.fragment and
        same_path(unquote(uri.path), result_path.parent) and bool(job_result.get("finished_at")))
    try:
        uuid.UUID(job_result["id"])
        uuid.UUID(trial["id"])
    except (KeyError, TypeError, ValueError, AttributeError):
        valid = False
    for config in (persisted, embedded):
        agent = config.get("agent") or {}
        valid = (valid and config.get("job_id") == job_result.get("id") and
            config.get("trial_name") == result_path.parent.name and same_path(config.get("trials_dir"), job) and
            same_path((config.get("task") or {}).get("path"), task) and agent.get("name") == "oracle" and
            agent.get("import_path") is None and config.get("install_only", False) is False and
            config.get("source_trial") is None and (config.get("verifier") or {}).get("disable", False) is False)
    if not valid:
        raise DispatchError("ORACLE_RESULT_IDENTITY", "Oracle result metadata does not match this exact task, trial and job")
    return trial


def zero_activity(state):
    scheduler = state.get("scheduler") if isinstance(state, dict) else None
    values = [state.get("activeUpstreamRequests")] if isinstance(state, dict) else [None]
    values.extend([scheduler.get("active"), scheduler.get("queued")] if isinstance(scheduler, dict) else [None, None])
    if any(type(value) is not int or value != 0 for value in values):
        raise DispatchError("ORACLE_ACTIVITY_UNVERIFIED", "Oracle activity counters must all be explicit integer zero")


def zero_requests(state):
    zero_activity(state)
    for key in ("requests", "rejectedRequests", "unknownUsage"):
        value = state.get(key)
        if type(value) is not int or value != 0:
            raise DispatchError("ORACLE_MODEL_REQUEST", "Oracle request counters must all be explicit integer zero")


def update_receipt(path, data):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        write_evidence(temporary, data)
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--attempt", type=int, help="One-based task selector; omitted only for a single-task manifest")
    parser.add_argument("--job-name", "--job", dest="job_name", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--admission-id", help="Join a parent epoch containing the exact official Oracle identity")
    parser.add_argument("--lease-timeout", type=float, default=900)
    parser.add_argument("--timeout", type=float, default=7800)
    parser.add_argument("--settle-timeout", type=float, default=300)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,180}", args.job_name):
        raise ValueError("A new single-component job name is required")
    if any(not math.isfinite(value) or value <= 0 for value in (args.lease_timeout, args.timeout, args.settle_timeout)):
        raise ValueError("Preflight timeouts must be positive and finite")
    manifest_path, output = args.manifest.resolve(), args.output.resolve()
    manifest_hash = digest(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    attempts = manifest["attempts"]
    if not attempts or (args.attempt is not None and not 1 <= args.attempt <= len(attempts)):
        raise ValueError("Attempt is outside the frozen manifest")
    if args.attempt is None and len({row["task"] for row in attempts}) != 1:
        raise ValueError("A multi-task manifest requires --attempt")
    row = attempts[(args.attempt or 1) - 1]
    task_name = row["task"]
    script_hash = digest(__file__)
    if manifest.get("files_sha256", {}).get("scripts/agent/harbor/repository_oracle.py") != script_hash:
        raise ValueError("Freeze repository_oracle.py in a new manifest before dispatch")
    gateway = manifest["gateway"]
    env = environment(Path(gateway["directory"]), gateway["url"])
    def ready_gateway():
        return guard_gateway(health(env), manifest["model"], gateway.get("budget_mode") == "unlimited",
                             manifest["reasoning_effort"], upstream=gateway.get("upstream"))
    ready_gateway()
    task, _ = validate(manifest, row, env)
    capacity = capacity_policy(manifest["resource_pool"])
    demand = task_resources(task, capacity)
    leases = ResourceLeases(BENCH / "campaign/resource-leases", capacity)
    job, log_path = BENCH / "jobs" / args.job_name, output.with_suffix(".log")
    if job.exists() or output.exists() or log_path.exists() or log_path == output:
        raise FileExistsError("Preserve existing preflight job, receipt and log evidence")
    identity = oracle_identity(manifest_hash, task_name, args.job_name)
    scope = oracle_scope(manifest, manifest_hash, task_name, args.job_name, output)
    if (not env.get("DOCKER_HOST", "").startswith("unix://") or
            str(Path(env["DOCKER_HOST"][7:]).resolve()) != scope["worker"]["socket"]):
        raise DispatchError("WORKER_IDENTITY", "Oracle Docker socket differs from the frozen worker")
    command = oracle_command(task, args.job_name, manifest.get("execution_env", {}))
    oracle_path = Path(importlib.util.find_spec("harbor.agents.oracle").origin)
    data = {"schema": 1, "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "waiting",
        "manifest": str(manifest_path), "manifest_sha256": manifest_hash, "task": task_name, "job": args.job_name,
        "model_requests_authorized": 0, "request_identity": identity, "command": command, "demand": demand,
        "resource_pool": capacity, "execution_env": manifest.get("execution_env", {}),
        "script": str(Path(__file__).resolve()), "script_sha256": script_hash,
        "official_oracle_source_sha256": digest(oracle_path),
        "official_task_files_sha256": manifest["tasks"][task_name]["files_sha256"]}
    cancelled, timed_out = threading.Event(), threading.Event()
    def interrupt(_number, _frame):
        cancelled.set()
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
    for number in previous:
        signal.signal(number, interrupt)
    context = (joined_admission(leases, args.admission_id, [identity]) if args.admission_id else
               admission_session(leases, scope, manifest_path=manifest_path, bench=BENCH, tasks_root=DATASET / "v2/tasks"))
    try:
        with context as admission:
            admission_id = admission if isinstance(admission, str) else admission.admission_id
            if cancelled.is_set():
                raise DispatchError("ORACLE_CANCELLED", "Oracle was cancelled before dispatch")
            leases.check_admission(admission_id, identity)
            with leases.state() as state:
                current = state["admission"]
                if (current["admission_id"] != admission_id or current["scope"]["worker"] != scope["worker"] or
                        current["scope"]["manifest_sha256"] != manifest_hash):
                    raise DispatchError("WORKER_IDENTITY", "Parent admission belongs to another worker or manifest")
                data.update(admission_id=admission_id, admission_scope=current["scope"])
            write_evidence(output, data)  # Disk admission precedes the first permanent receipt.
            run_oracle(args, manifest_path, manifest_hash, env, ready_gateway, leases, admission_id,
                       identity, demand, job, command, output, log_path, data, cancelled, timed_out,
                       ledger_path=Path(gateway["directory"]) / "budget.json", task=task)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def run_oracle(args, manifest_path, manifest_hash, env, ready_gateway, leases, admission_id,
               identity, demand, job, command, output, log_path, data, cancelled, timed_out, *, ledger_path, task):
    lease, attempt_env, failure, cleanup_failure = None, None, None, None
    started, settled, process_settled = False, False, False
    try:
        lease = leases.acquire(identity, demand, args.lease_timeout, cancelled=cancelled, admission_id=admission_id)
        data["lease"] = lease
        ready_gateway()
        if digest(manifest_path) != manifest_hash or cancelled.is_set():
            raise DispatchError("ORACLE_CANCELLED" if cancelled.is_set() else "MANIFEST_CHANGED", "Oracle dispatch boundary changed")
        data["ledger_before"] = ledger_snapshot(ledger_path, identity)
        if data["ledger_before"]["oracle_request_ids"]:
            raise DispatchError("ORACLE_MODEL_REQUEST", "Oracle identity already has model requests")
        attempt_env = prepare_attempt_environment(env, identity, BENCH / "campaign/attempt-credentials")
        data["attempt_budget_before"] = health(attempt_env)
        zero_requests(data["attempt_budget_before"])
        data["status"] = "running"
        update_receipt(output, data)
        def deadline():
            timed_out.set()
            cancelled.set()
        timer = threading.Timer(args.timeout, deadline)
        try:
            with log_path.open("x") as log:
                if cancelled.is_set():
                    raise DispatchError("ORACLE_CANCELLED", "Oracle cancelled before process creation")
                timer.start()
                started = True
                try:
                    code = run_attempt_process(command, cwd=ROOT, environment=oracle_environment(attempt_env), log=log, cancelled=cancelled)
                    process_settled = True
                except KeyboardInterrupt:
                    # The shared runner re-raises cancellation only after its
                    # SIGINT/TERM/KILL + wait cleanup. Other exceptions do not
                    # prove its process-reaping path completed.
                    process_settled = True
                    raise
        finally:
            timer.cancel()
        data["exit_code"] = code
        results = list(job.glob("*/result.json"))
        if code or not (job / "result.json").exists() or len(results) != 1:
            raise DispatchError("ORACLE_RESULT_MISSING", "Oracle did not finish exactly one trial")
        trial = verify_result_identity(job, results[0], task)
        reward = ((trial.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        data.update(result=str(results[0]), result_sha256=digest(results[0]),
            exception_type=(trial.get("exception_info") or {}).get("exception_type"), reward=reward)
        if trial.get("exception_info") or not trial.get("finished_at") or type(reward) not in (int, float) or reward != 1:
            raise DispatchError("ORACLE_NOT_HEALTHY", "Official Oracle must finish without exception and receive numeric reward 1")
        if cancelled.is_set():
            raise DispatchError("ORACLE_TIMEOUT" if timed_out.is_set() else "ORACLE_CANCELLED", "Oracle completed after cancellation")
        data["status"] = "healthy"
    except BaseException as error:
        failure = error
        data.update(status="failed", error_type=type(error).__name__,
            error_code="ORACLE_TIMEOUT" if timed_out.is_set() else "ORACLE_CANCELLED" if cancelled.is_set() else getattr(error, "code", "PREFLIGHT_FAILED"))
        raise
    finally:
        # Physical settlement and preflight correctness are separate facts. A
        # known reward-0/process failure can release resources after cleanup.
        settled = not started or process_settled
        data["harbor_process_settled"] = settled
        if not settled:
            cleanup_failure = DispatchError("ORACLE_PROCESS_SETTLEMENT_UNKNOWN", "Harbor process reaping was not confirmed")
        if attempt_env is not None:
            try:
                after = wait_for_settlement(lambda: health(attempt_env), args.settle_timeout)
                data.update(attempt_budget_after=after, model_calls_added=after.get("requests"),
                            rejected_model_requests=after.get("rejectedRequests"))
                zero_activity(after)
            except BaseException as error:
                settled, cleanup_failure = False, error
        if started:
            try:
                verify_job_containers_stopped(job, env)
                data["containers_stopped"] = True
            except BaseException as error:
                settled, cleanup_failure = False, error
        validation_failure = None
        try:
            if job.is_dir():
                write_evidence(job / "request-identity.json", identity)
            if data.get("attempt_budget_after") is not None:
                zero_requests(data["attempt_budget_after"])
            if data.get("ledger_before"):
                after = ledger_snapshot(ledger_path, identity)
                data["ledger_after"] = after
                if after["oracle_request_ids"] or set(after["request_ids"]) != set(data["ledger_before"]["request_ids"]):
                    raise DispatchError("ORACLE_MODEL_REQUEST", "Zero-model preflight changed the model request set")
                data["ledger_request_set_unchanged"] = True
            if digest(manifest_path) != manifest_hash:
                raise DispatchError("MANIFEST_CHANGED", "Frozen manifest changed during Oracle preflight")
        except BaseException as error:
            validation_failure = error
            data.update(status="failed", validation_error_code=getattr(error, "code", "PREFLIGHT_EVIDENCE_FAILED"),
                        validation_error_type=type(error).__name__)
        if cleanup_failure:
            data.update(status="blocked", cleanup_error_code=getattr(cleanup_failure, "code", "SETTLEMENT_UNKNOWN"),
                        cleanup_error_type=type(cleanup_failure).__name__)
        if lease:
            leases.finish(lease, settled=settled, reason=data.get("cleanup_error_code"))
        data.update(finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), physical_settlement_confirmed=settled,
                    resource_lease_released=bool(lease) and settled)
        update_receipt(output, data)
        print(json.dumps({key: data.get(key) for key in ("status", "task", "job", "reward", "error_code", "cleanup_error_code",
            "validation_error_code", "model_calls_added", "rejected_model_requests", "containers_stopped", "admission_id",
            "physical_settlement_confirmed")}), flush=True)
        if not failure and (cleanup_failure or validation_failure):
            raise cleanup_failure or validation_failure


if __name__ == "__main__":
    main()
