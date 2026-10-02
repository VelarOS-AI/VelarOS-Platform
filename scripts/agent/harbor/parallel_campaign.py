"""Run one frozen development batch; retain uncertain dispatches without replaying them.

The repository launcher owns resource leases, per-phase credentials and cleanup.
This controller owns scheduling/checkpoints only. Neither dry-run nor reporting
reads task instructions, reference answers, or starts a model request.
"""

import argparse
import concurrent.futures
import contextlib
import datetime
import fcntl
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import Counter
from pathlib import Path

from metrics import compare_jobs, request_failure_kind, request_metrics, request_transport_code, trial_infrastructure_issue
from report import codex_execution_status, context_diagnostics_markdown, finish_summary, pricing_basis_markdown, summarize
from repository_report import merge_trial
from request_identity import validate_identity, validate_request_ledger, verify_unique_attribution
from task_exposure import task_exposure
from tool_metrics import aggregate_tool_usage
from resource_leases import ResourceLeases
from worker_admission import admission_session, scope_for
from campaign_diagnostics import no_symlinks, safe_failure, write_new

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / ".velaros-workspace/bench"
DIAGNOSTIC_RUN_SECONDS = 120
DIAGNOSTIC_CLOSE_SECONDS = 5


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def atomic_json(path, value):
    """A checkpoint precedes dispatch and survives process/host interruption."""
    path = Path(path)
    temporary = path.with_name(path.name + ".writing")
    with temporary.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def controller_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "controller.lock").open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("This checkpoint already has a live controller") from error
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def safe_name(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,180}", value))


def load_plan(path, jobs_root):
    """Only frozen IDs/metadata are inspected; exposed development roles are mandatory."""
    path = Path(path).resolve()
    raw = path.read_bytes()
    plan = json.loads(raw)
    manifest_path = Path(plan["manifest"])
    if not manifest_path.is_absolute():
        manifest_path = path.parent / manifest_path
    manifest_path = manifest_path.resolve()
    manifest_raw = manifest_path.read_bytes()
    if plan.get("schema") != 1 or sha256(manifest_raw) != plan.get("manifest_sha256"):
        raise ValueError("Plan schema or frozen manifest identity differs")
    if not isinstance(plan.get("gateway_directory"), str) or not Path(plan["gateway_directory"]).is_absolute():
        raise ValueError("Freeze the absolute campaign gateway directory")
    manifest = json.loads(manifest_raw)
    participants = plan.get("participants", {})
    if (set(participants) != set(manifest["participants"]) or len(participants) != 2
            or set(participants.values()) != {"codex", "scriptact"}):
        raise ValueError("This campaign requires exactly Codex and ScriptAct")
    workers = plan.get("workers")
    pool = manifest.get("resource_pool", {})
    if (type(workers) is not int or workers < 1 or type(pool.get("max_active_attempts")) is not int
            or workers > pool["max_active_attempts"]):
        raise ValueError("Workers must fit the frozen resource pool")
    if not manifest.get("model") or not manifest.get("reasoning_effort") or manifest.get("trial_concurrency") != 1:
        raise ValueError("Freeze one model, reasoning effort and one trial per attempt")
    for participant in manifest["participants"].values():
        if participant.get("model", "").split("/")[-1] != manifest["model"]:
            raise ValueError("Both participants must explicitly use the frozen model")
        if not participant.get("files_sha256"):
            raise ValueError("Each participant requires frozen candidate files")
        if participant.get("kwargs", {}).get("reasoning_effort") != manifest["reasoning_effort"]:
            raise ValueError("Both participants must explicitly use the frozen reasoning effort")
    exposure = task_exposure(manifest, jobs_root, require_definition=True)
    if exposure["independent_held_out_tasks"] or exposure["unknown_tasks"]:
        raise ValueError("Parallel development batches cannot contain held-out or unknown tasks")
    snapshot = read_json(manifest["evaluation"]["exposure_snapshot"]["file"])
    observed = {row["task"] for row in snapshot["observations"]}
    if any(row["task"] not in observed for row in manifest["attempts"]):
        raise ValueError("This entry requires already exposed development tasks")
    jobs = []
    for row in manifest["attempts"]:
        if row["participant"] not in participants or not safe_name(row["task"]):
            raise ValueError("Invalid participant or task ID")
        jobs.extend((row["source_job"], row["replay_job"], row["source_job"] + "-install"))
    if any(not safe_name(job) for job in jobs) or len(set(jobs)) != len(jobs):
        raise ValueError("Every attempt/phase needs a unique safe job name")
    scheduled, batch_names = [], []
    for batch in plan.get("batches", []):
        indices = batch.get("attempts", [])
        if not safe_name(batch.get("id")) or not indices or batch.get("role") != "development":
            raise ValueError("Each batch requires an ID, development role and attempt indices")
        if any(type(index) is not int or not 1 <= index <= len(manifest["attempts"]) for index in indices):
            raise ValueError("Batch attempt index is outside the frozen schedule")
        pairs = {name: Counter(manifest["attempts"][index - 1]["task"] for index in indices
                               if manifest["attempts"][index - 1]["participant"] == name) for name in participants}
        if len({tuple(sorted(value.items())) for value in pairs.values()}) != 1:
            raise ValueError("Each batch must pair the same tasks/repetitions for both participants")
        scheduled.extend(indices)
        batch_names.append(batch["id"])
    if (sorted(scheduled) != list(range(1, len(manifest["attempts"]) + 1))
            or len(set(batch_names)) != len(batch_names)):
        raise ValueError("Batches must partition all frozen attempts exactly once")
    return plan, manifest, manifest_path, sha256(raw), exposure


def phase_identity(manifest, manifest_hash, index, phase):
    row = manifest["attempts"][index - 1]
    participant = manifest["participants"][row["participant"]]
    return {"campaignId": manifest_hash,
            "candidateId": sha256(json.dumps(participant, sort_keys=True, separators=(",", ":")).encode()),
            "participantId": row["participant"], "taskId": row["task"],
            "attemptId": sha256(f"{manifest_hash}:{index}:{phase}".encode()),
            "jobId": row["source_job"] if phase == "source" else row["replay_job"], "phase": phase}


def phase_evidence(bench, row, identity):
    job = bench / "jobs" / identity["jobId"]
    receipt_path = bench / "campaign" / (identity["jobId"] + "-dispatch.json")
    try:
        receipt = read_json(receipt_path) if receipt_path.exists() else None
    except json.JSONDecodeError:
        # The launcher may be replacing its running receipt during a live report.
        receipt = None
    if receipt and receipt.get("request_identity") != identity:
        raise ValueError("Dispatch identity differs from frozen attempt")
    identity_path = job / "request-identity.json"
    terminal = bool(receipt and receipt.get("status") in ("finished", "failed", "blocked"))
    if terminal and identity_path.exists():
        if validate_identity(read_json(identity_path)) != identity:
            raise ValueError("Job identity differs from frozen attempt")
    results = list(job.glob("*/result.json"))
    if len(results) > 1:
        raise ValueError("One attempt contains multiple trial results")
    complete = bool(terminal and (job / "result.json").exists() and identity_path.exists() and results)
    result = read_json(results[0]) if complete else None
    if result and Path(result.get("task_name", "")).name != row["task"]:
        raise ValueError("Trial task differs from frozen attempt")
    credential = bench / "campaign/attempt-credentials" / (sha256(identity["attemptId"].encode()) + ".token")
    touched = job.exists() or receipt_path.exists() or credential.exists() or (bench / (identity["jobId"] + ".log")).exists()
    return {"complete": complete, "touched": touched, "result": result,
            "result_path": str(results[0]) if results else None,
            "receipt_status": receipt.get("status") if receipt else None,
            "receipt_error": (receipt.get("cleanup_error_code") or receipt.get("error_code")) if receipt else None}


def observe_attempt(manifest, manifest_hash, index, bench, prior):
    """Never infer that a lost dispatch is free to repeat. Reconcile only durable evidence."""
    row = manifest["attempts"][index - 1]
    try:
        phases = {phase: phase_evidence(bench, row, phase_identity(manifest, manifest_hash, index, phase))
                  for phase in ("source", "replay")}
    except (ValueError, KeyError, OSError) as error:
        return {"status": "identity_failed", "issue": str(error)}
    source, replay = phases["source"], phases["replay"]
    if any(phase["receipt_status"] == "blocked" for phase in phases.values()):
        return {"status": "uncertain", "issue": "resource_or_settlement_cleanup_unconfirmed", "phases": phases}
    if any(phase["receipt_status"] == "failed" for phase in phases.values()):
        return {"status": "infrastructure_failed", "issue": "launcher_phase_failed", "phases": phases}
    if source["complete"] and (source["result"].get("exception_info") or {}).get("exception_type") == "AgentAuthenticationError":
        rewards = ((replay.get("result") or {}).get("verifier_result") or {}).get("rewards") or {}
        return {"status": "infrastructure_failed", "issue": "model_authentication_failed", "phases": phases,
                "reward": rewards.get("reward")}
    if source["complete"] and replay["complete"]:
        verifier = replay["result"].get("verifier_result") or {}
        reward = (verifier.get("rewards") or {}).get("reward")
        for phase in (source, replay):
            path = Path(phase["result_path"]).parent / "verifier/test-stdout.txt"
            issue = trial_infrastructure_issue(phase["result"], path.read_text(errors="replace") if path.exists() else "")
            if issue:
                return {"status": "infrastructure_failed", "issue": issue, "phases": phases, "reward": reward}
        if (replay["result"].get("exception_info") or type(reward) not in (float, int)
                or not math.isfinite(reward)):
            return {"status": "infrastructure_failed", "issue": "official_replay_incomplete", "phases": phases, "reward": reward}
        native = codex_execution_status(Path(source["result_path"]).parent)
        failed = reward != 1 or bool(source["result"].get("exception_info")) or bool(native and native["status"] != "completed")
        return {"status": "solve_failed" if failed else "completed", "reward": reward, "phases": phases}
    if (source["complete"] and not replay["touched"]
            and not (prior.get("replay_only") and prior.get("dispatch_started_at"))):
        return {"status": "replay_ready", "phases": phases}
    if not source["touched"] and not replay["touched"] and prior.get("status") == "pending":
        return {"status": "pending"}
    return {"status": "uncertain", "issue": "retained_dispatch_requires_reconciliation", "phases": phases}


def scoped_requests(manifest, manifest_hash, requests):
    validate_request_ledger(requests)
    identities = {phase_identity(manifest, manifest_hash, index, phase)["attemptId"]:
                  phase_identity(manifest, manifest_hash, index, phase)
                  for index in range(1, len(manifest["attempts"]) + 1) for phase in ("source", "replay")}
    jobs = {identity["jobId"] for identity in identities.values()}
    selected = []
    for call in requests:
        owner = call.get("identity")
        if owner is None:
            continue
        expected = identities.get(owner["attemptId"])
        if expected is None:
            if owner["campaignId"] == manifest_hash or owner["jobId"] in jobs:
                raise ValueError("Campaign request has an unknown attempt identity")
            continue
        if owner != expected or owner["phase"] != "source":
            raise ValueError("Request has conflicting identity or replay unexpectedly called a model")
        if call.get("model") != manifest["model"] or (call.get("metadata") or {}).get("reasoningEffort") != manifest["reasoning_effort"]:
            raise ValueError("Observed model/reasoning differs from frozen protocol")
        selected.append(call)
    return selected


def request_infrastructure_failure(calls, terminal_failed=False):
    """Classify only attributed provider evidence, never task text or error prose.

    Authentication is immediately actionable. Transient service errors remain
    provisional while the SDK can recover; only an unrecovered failed source
    can block its queue. A later completed success breaks the failure streak.
    """
    settled = sorted((call for call in calls if call.get("finishedAt")),
                     key=lambda call: (call["startedAt"], call["id"]))
    auth = [call for call in settled if request_failure_kind(call) == "model_authentication_failed"]
    if auth:
        kind, evidence = "model_authentication_failed", auth
    else:
        if not terminal_failed or any(not call.get("finishedAt") for call in calls):
            return None
        evidence = []
        for call in reversed(settled):
            if request_failure_kind(call) not in {"model_rate_limited", "model_service_unavailable", "model_transport_failed"}:
                break
            evidence.append(call)
        evidence.reverse()
        if not evidence:
            return None
        kinds = {request_failure_kind(call) for call in evidence}
        kind = ("model_service_unavailable" if "model_service_unavailable" in kinds else
                "model_transport_failed" if "model_transport_failed" in kinds else "model_rate_limited")
    return {"kind": kind, "request_ids": [call["id"] for call in evidence],
            "evidence": [{**{key: call.get(key) for key in ("id", "status", "startedAt", "finishedAt")},
                          "failure_kind": request_failure_kind(call), "transport_code": request_transport_code(call)}
                         for call in evidence]}


def retain_request_failure(state, failure=None):
    """An observed blocker survives reconciliation and requires explicit release."""
    prior = state.get("request_failure")
    if failure:
        if prior and prior["kind"] == failure["kind"]:
            evidence = {row["id"]: row for row in prior["evidence"] + failure["evidence"]}
            failure = {**failure, "request_ids": list(evidence), "evidence": list(evidence.values())}
        # Authentication remains the primary blocker if service responses follow it.
        if not prior or prior["kind"] != "model_authentication_failed":
            state["request_failure"] = failure
        elif failure["kind"] == prior["kind"]:
            state["request_failure"] = failure
    failure = state.get("request_failure")
    if failure and state["status"] not in {"identity_failed", "uncertain"}:
        state.update({"status": "infrastructure_failed", "issue": failure["kind"]})


def repository_snapshot(manifest, manifest_hash, bench, requests, request_failures=None):
    """Only committed phase results enter grading; live/partial jobs stay pending."""
    summaries = []
    for participant in manifest["participants"]:
        planned = [(index, row) for index, row in enumerate(manifest["attempts"], 1) if row["participant"] == participant]
        trials, pending, ungraded, calls_by_attempt, unstarted = [], [], [], [], []
        for index, row in planned:
            source_phase = phase_evidence(bench, row, phase_identity(manifest, manifest_hash, index, "source"))
            if not source_phase["complete"]:
                if source_phase["touched"]:
                    pending.append(row["source_job"] + ":source-pending")
                else:
                    unstarted.append(row["source_job"])
                continue
            data = summarize(bench / "jobs" / row["source_job"], requests)
            if data["planned"] != 1 or data["completed"] != 1:
                raise ValueError("Completed source must contain exactly one frozen trial")
            if any(model.split("/")[-1] != manifest["model"] for model in data["models"]):
                raise ValueError("Completed source model differs from the frozen protocol")
            source = data["trials"][0]
            failure = (request_failures or {}).get(index)
            if not failure and source["reported_exception"] == "AgentAuthenticationError":
                failure = {"kind": "model_authentication_failed", "request_ids": [], "evidence": []}
            if failure:
                source["controller_request_failure"] = failure
                source["infrastructure_issue"] = source["infrastructure_issue"] or failure["kind"]
                source["exception"] = source["exception"] or "ControllerModelInfrastructureFailure"
                source["error"] = source["error"] or failure["kind"]
            calls_by_attempt.append({"source_job": row["source_job"], "metrics": source["metrics"], "agent_seconds": source["agent_seconds"]})
            replay_phase = phase_evidence(bench, row, phase_identity(manifest, manifest_hash, index, "replay"))
            if not replay_phase["complete"]:
                ungraded.append({"source_job": row["source_job"], "source": source})
                pending.append(row["replay_job"] + ":replay-pending")
                continue
            merged = merge_trial(source, replay_phase["result"], Path(replay_phase["result_path"]).parent)
            phase_statuses = {"source": source_phase["receipt_status"], "replay": replay_phase["receipt_status"]}
            merged["controller_phase_statuses"] = phase_statuses
            if any(status != "finished" for status in phase_statuses.values()):
                merged["infrastructure_issue"] = merged["infrastructure_issue"] or "controller_phase_cleanup_or_execution_failed"
                merged["exception"] = merged["exception"] or "ControllerPhaseFailure"
                merged["error"] = merged["error"] or "Controller phase execution or cleanup did not finish successfully"
            trials.append({**merged, "source_job": row["source_job"], "replay_job": row["replay_job"]})
        summaries.append(finish_summary({"job": participant, "models": [manifest["model"]],
            "ungraded_sources": ungraded, "unstarted_sources": unstarted, "completed_source_usage": calls_by_attempt,
            "source_tool_usage": aggregate_tool_usage(trials + [item["source"] for item in ungraded])},
            len(planned), trials, pending))
    verify_unique_attribution(summaries)
    return summaries


class Campaign:
    def __init__(self, plan, manifest, manifest_path, plan_hash, directory, bench=BENCH, launcher=None, admission_probe=None,
                 diagnostics_enabled=True, diagnostics_launcher=None):
        self.plan, self.manifest, self.manifest_path = plan, manifest, Path(manifest_path)
        self.plan_hash, self.directory, self.bench = plan_hash, Path(directory), Path(bench)
        self.manifest_hash = plan["manifest_sha256"]
        self.launcher = launcher or self.launch
        self.admission_probe = admission_probe
        self.admission = None
        self.stop_requested = threading.Event()
        self.stop_signal = None
        self.launcher_processes = {}
        self.launcher_lock = threading.Lock()
        self.cancelled_launchers = set()
        self.diagnostics_enabled = diagnostics_enabled
        self.diagnostics_launcher = diagnostics_launcher or subprocess.Popen
        self.diagnostic_process = None
        self.diagnostic_pending = None
        self.diagnostic_sources = set()
        self.diagnostic_active = False
        self.observation_started = None
        self.source_observed = None
        self.diagnostic_wait_seconds = 0.
        self.path = self.directory / "checkpoint.json"
        if self.path.exists():
            self.state = read_json(self.path)
            if self.state.get("plan_sha256") != plan_hash or self.state.get("manifest_sha256") != self.manifest_hash:
                raise ValueError("Checkpoint belongs to a different frozen plan")
        else:
            self.state = {"schema": 1, "plan_sha256": plan_hash, "manifest_sha256": self.manifest_hash,
                          "created_at": now(), "attempts": {str(index): {"status": "pending"}
                          for index in range(1, len(manifest["attempts"]) + 1)},
                          "queue_releases": [], "batches": {}}

    def save(self):
        self.state["updated_at"] = now()
        atomic_json(self.path, self.state)

    def request_stop(self, number, frame=None):
        # Signal handlers only set intent; they never interrupt cleanup or take
        # the process-registry lock held by a launching worker.
        if self.stop_signal is None:
            self.stop_signal = number
        self.stop_requested.set()

    @contextlib.contextmanager
    def cancellation_signals(self):
        previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
        for number in previous:
            signal.signal(number, self.request_stop)
        try:
            yield
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)

    def cancel_launchers(self):
        # Target only our launcher PIDs. The launcher alone cancels Harbor and
        # waits for container cleanup/provider settlement; no process-group kill.
        with self.launcher_lock:
            for index, process in self.launcher_processes.items():
                if index not in self.cancelled_launchers and process.poll() is None:
                    try:
                        process.send_signal(signal.SIGTERM)
                    except ProcessLookupError:
                        # Natural exit between poll and signal is already settled
                        # by the owning worker's wait; continue cancelling peers.
                        pass
                    self.cancelled_launchers.add(index)

    def reconcile(self, indices):
        for index in indices:
            prior = self.state["attempts"][str(index)]
            observed = observe_attempt(self.manifest, self.manifest_hash, index, self.bench, prior)
            retained = {key: value for key, value in prior.items() if key not in ("issue", "phases", "reward")}
            self.state["attempts"][str(index)] = {**retained, **observed, "observed_at": now()}
            retain_request_failure(self.state["attempts"][str(index)])
        self.save()

    def blocked_queues(self):
        blocked = {}
        for key, state in self.state["attempts"].items():
            if state["status"] not in {"infrastructure_failed", "identity_failed", "uncertain"}:
                continue
            # Acknowledgement allows later work only; it never replays this attempt.
            if any(item["attempt"] == int(key) and item["issue"] == state.get("issue")
                   and item.get("request_ids") == (state.get("request_failure") or {}).get("request_ids")
                   for item in self.state["queue_releases"]):
                continue
            queue = "*" if state["status"] == "identity_failed" else self.manifest["attempts"][int(key) - 1]["participant"]
            blocked.setdefault(queue, []).append(int(key))
        if self.state.get("accounting_fault"):
            blocked["*"] = ["accounting"]
        return blocked

    def launch(self, index, replay_only):
        command = [str(self.bench / "venv/bin/python"), str(Path(__file__).with_name("repository_launch.py")),
                   "--manifest", str(self.manifest_path), "--attempt", str(index),
                   "--gateway-directory", self.plan["gateway_directory"]]
        if self.admission is None:
            raise RuntimeError("Dispatch requires an admitted worker epoch")
        command.extend(["--admission-id", self.admission.admission_id])
        if self.manifest.get("gateway", {}).get("budget_mode") == "unlimited":
            command.append("--allow-unlimited")
        if replay_only:
            command.append("--replay-only")
        # Never kill Harbor on a controller deadline; Harbor owns safe cancellation.
        log = self.directory / f"attempt-{index}-{'replay' if replay_only else 'source'}.controller.log"
        with log.open("x") as stream:
            if self.stop_requested.is_set():
                return -signal.SIGTERM
            # A terminal SIGINT reaches the controller only. Its explicit single
            # SIGTERM to the launcher must not also hit Harbor grandchildren.
            process = subprocess.Popen(command, cwd=ROOT, stdout=stream,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            with self.launcher_lock:
                self.launcher_processes[index] = process
            try:
                # Close the race where cancellation preceded registry insertion.
                while True:
                    if self.stop_requested.is_set():
                        self.cancel_launchers()
                    try:
                        return process.wait(timeout=.2)
                    except subprocess.TimeoutExpired:
                        pass
            finally:
                with self.launcher_lock:
                    self.launcher_processes.pop(index, None)

    def refresh_report(self, budget_path):
        try:
            budget = read_json(budget_path)
            requests = scoped_requests(self.manifest, self.manifest_hash, budget["requests"])
            self.state.pop("accounting_fault", None)
        except (ValueError, KeyError, OSError) as error:
            self.state["accounting_fault"] = {"type": type(error).__name__, "message": str(error)}
            self.save()
            return
        attempts = []
        report_errors = []
        for index, row in enumerate(self.manifest["attempts"], 1):
            own = [call for call in requests if call["identity"]["attemptId"] == phase_identity(
                self.manifest, self.manifest_hash, index, "source")["attemptId"]]
            state = self.state["attempts"][str(index)]
            if own and state["status"] == "pending":
                state.update({"status": "uncertain", "issue": "existing_request_without_dispatch_evidence"})
            source = state.get("phases", {}).get("source", {})
            terminal_failed = False
            if source.get("complete"):
                native = codex_execution_status(Path(source["result_path"]).parent)
                terminal_failed = bool(source["result"].get("exception_info") or
                                       (native and native["status"] == "failed"))
            retain_request_failure(state, request_infrastructure_failure(own, terminal_failed))
            attempts.append({"index": index, **row, "state": self.state["attempts"][str(index)],
                             "request_ids": [call["id"] for call in own], "metrics": request_metrics(own),
                             "unsettled_requests": sum(not call.get("finishedAt") for call in own)})
        try:
            jobs = repository_snapshot(self.manifest, self.manifest_hash, self.bench, requests,
                {int(index): state["request_failure"] for index, state in self.state["attempts"].items()
                 if state.get("request_failure")})
        except (ValueError, KeyError, OSError) as error:
            # Partial jobs were excluded above; malformed committed evidence is a fault.
            jobs = []
            report_errors.append({"type": type(error).__name__, "message": str(error)})
            self.state["accounting_fault"] = report_errors[0]
        issues = []
        for attempt in attempts:
            state = attempt["state"]
            if state["status"] in {"solve_failed", "infrastructure_failed", "identity_failed", "uncertain"}:
                kind = state.get("issue") or "solve_or_execution_failure"
                issues.append({"id": sha256(f'{attempt["index"]}:{kind}'.encode())[:16],
                    "attempt": attempt["index"], "participant": attempt["participant"], "task": attempt["task"],
                    "kind": kind, "severity": "diagnostic" if state["status"] == "solve_failed" else "queue_blocker",
                    "root_cause": "unconfirmed", "evidence": state.get("phases"),
                    "request_evidence": (state.get("request_failure") or {}).get("evidence", []),
                    "owner": None, "verification": "pending"})
        report = {"schema": 1, "generated_at": now(), "plan_sha256": self.plan_hash,
                  "manifest_sha256": self.manifest_hash, "model": self.manifest["model"],
                  "reasoning_effort": self.manifest["reasoning_effort"], "attempts": attempts,
                  "jobs": jobs, "all_attempt_requests": request_metrics(requests),
                  "unsettled_requests": sum(not call.get("finishedAt") for call in requests),
                  "blocked_queues": self.blocked_queues(), "issues": issues, "report_errors": report_errors,
                  "comparisons": [compare_jobs(jobs[0], job) for job in jobs[1:]] if jobs else [],
                  "supports_general_superiority": False,
                  "interpretation": "Exposed development evidence only. Official rewards and all-attempt spend remain separate; unknown usage stays unknown. Refresh after late settlement; no source attempt is retried."}
        atomic_json(self.directory / "report.json", report)
        atomic_json(self.directory / "issues.json", issues)
        basis = report["all_attempt_requests"].get("pricing_basis")
        pricing = pricing_basis_markdown([("全部尝试", basis)] if basis else [])
        lines = ["# 并行开发批次", "", f'模型 `{report["model"]}`；推理档位 `{report["reasoning_effort"]}`。', "",
                 "先看官方质量与运行稳定性，再看完整耗时和费用。开发证据不支持独立泛化结论。费用覆盖失败、运行中和迟到结算；未知用量与实际完整扣费保持未知。原始请求、身份和重试计数保留在 JSON 归账与故障审计中。", ""]
        if pricing:
            lines += pricing + [""]
        known_label, unknown_label = ("已知估算美元", "未知估算请求") if pricing else ("已知美元", "未知费用请求")
        lines += [f"| 尝试 | 参与者 / 任务 | 状态 | 官方 reward | agent 秒 | 完整 attempt 秒 | {known_label} | 实际完整费用美元 | {unknown_label} | 未结算 |",
                  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|"]
        trials_by_source = {trial["source_job"]: trial for job in jobs for trial in job["trials"]}
        source_usage = {source["source_job"]: source for job in jobs for source in job["completed_source_usage"]}
        def shown_seconds(value):
            return f"{value:.6f}" if value is not None else "未知"

        for item in attempts:
            metrics, state = item["metrics"], item["state"]
            trial = trials_by_source.get(item["source_job"], {})
            source = source_usage.get(item["source_job"], {})
            lines.append(f'| {item["index"]} | {item["participant"]} / {item["task"]} | {state["status"]} | {state.get("reward", "待定")} | {shown_seconds(source.get("agent_seconds"))} | {shown_seconds(trial.get("attempt_wall_seconds"))} | {metrics["known_cost_usd"]:.6f} | {shown_seconds(trial.get("complete_task_cost_usd"))} | {metrics["unknown_cost_requests"]} | {item["unsettled_requests"]} |')
        lines += ["", "trial 跨阶段耗时：源 trial 开始到 replay trial 结束，含中间空隙；旧 end_to_end_seconds 保留此口径。attempt 完整耗时：源 dispatch receipt 开始到 replay receipt 确认清理结算完成，含容量排队和所有阶段空隙。receipt 身份、结果路径或清理终态未确认时保持未知；不包含首个 receipt 之前的 controller 启动及最后 receipt 之后的报告写入。并发 attempt 的时间不能相加作为批次墙钟时间。", "",
                  "| 参与者 / 已判分任务 | 源解题秒数 | trial 跨阶段秒数 | attempt 完整秒数 |",
                  "|---|---:|---:|---:|"]
        for job in jobs:
            for trial in job["trials"]:
                lines.append(f'| {job["job"]} / {trial["task"]} | {shown_seconds(trial["agent_seconds"])} | {shown_seconds(trial["trial_lifecycle_seconds"])} | {shown_seconds(trial["attempt_wall_seconds"])} |')
        lines += context_diagnostics_markdown(jobs)
        lines += ["", "| 固定参考 → 候选 | 两组完成 | 共同正常成功题数 | agent 耗时比 | 完整 attempt 耗时比 | 模型费估算比 |",
                  "|---|---|---:|---:|---:|---:|"]
        for comparison in report["comparisons"]:
            ratios = comparison["candidate_over_reference"]
            values = [shown_seconds(ratios[key]) for key in ("agent_seconds", "attempt_wall_seconds", "cost_usd")]
            lines.append(f'| {comparison["reference"]} → {comparison["candidate"]} | {"是" if comparison["complete"] else "否"} | {comparison["jointly_solved_tasks"]} | ' + " | ".join(values) + " |")
        lines += ["", "共同成功比较按题等权，并排除运行及基础设施异常；缺少完整 attempt 耗时保持未知。费用比只表示完整用量的模型费估算，参考估价的 dominance 不代表实际完整任务费用优势。"]
        lines += ["", "详细时间、上下文、缓存和分层工具次数见 report.json 的 jobs/trials；运行中请求见 attempts。", "",
                  f'当前阻断队列：`{json.dumps(report["blocked_queues"], ensure_ascii=False)}`。', "",
                  "问题列表保留症状与证据；未经诊断不自动推断或合并根因。"]
        (self.directory / "report.md").write_text("\n".join(lines) + "\n")
        self.save()
        completed_sources = {item["source_job"] for job in jobs for item in job["completed_source_usage"]}
        if self.diagnostic_active and completed_sources - self.diagnostic_sources:
            self.diagnostic_sources.update(completed_sources)
            self.source_observed = time.monotonic()
            self.queue_diagnostic("source-terminal", budget_path)

    def diagnostic_event(self, value):
        """Auxiliary status never changes the paid checkpoint or queue decisions."""
        try:
            directory = no_symlinks(self.directory / "diagnostics")
            directory.mkdir(parents=True, exist_ok=True)
            path = no_symlinks(directory / "controller-events.jsonl")
            with path.open("a") as stream:
                stream.write(json.dumps({"at": now(), **value}, allow_nan=False) + "\n")
        except (OSError, ValueError):
            # Even an unavailable diagnostic sink cannot interrupt launcher cleanup.
            pass

    def queue_diagnostic(self, stage, budget_path):
        if not self.diagnostics_enabled or self.stop_requested.is_set():
            return
        self.diagnostic_pending = (stage, Path(budget_path))
        self.poll_diagnostic()

    def stop_diagnostic(self, reason):
        entry = self.diagnostic_process
        if entry is None:
            return
        process = entry["process"]
        verified = process.poll() is not None
        try:
            if not verified:
                process.terminate()
                try:
                    process.wait(timeout=.1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1)
                verified = True
        except (OSError, subprocess.TimeoutExpired):
            # Retain unknown physical completion rather than inventing success.
            pass
        entry["log"].close()
        self.diagnostic_event({"run_id": entry["run_id"], "stage": entry["stage"],
            "status": "unknown", "reason": reason, "exit_verified": verified,
            "observed_seconds": time.monotonic() - entry["started"]})
        self.diagnostic_process = None if verified else entry
        if not verified:
            self.diagnostic_pending = None

    def poll_diagnostic(self):
        entry = self.diagnostic_process
        if entry is not None:
            code = entry["process"].poll()
            if code is not None:
                entry["log"].close()
                status, receipt_hash = "unknown", None
                try:
                    receipt_path = no_symlinks(self.directory / "diagnostics/invocations" / entry["run_id"] / "receipt.json")
                    raw = receipt_path.read_bytes()
                    receipt = json.loads(raw)
                    if (code == 0 and receipt.get("run_id") == entry["run_id"]
                            and receipt.get("stage") == entry["stage"]
                            and receipt.get("status") in {"complete", "partial"}):
                        status, receipt_hash = receipt["status"], sha256(raw)
                except (OSError, ValueError, TypeError):
                    pass
                self.diagnostic_event({"run_id": entry["run_id"], "stage": entry["stage"],
                    "status": status, "exit_code": code, "receipt_sha256": receipt_hash,
                    "observed_seconds": time.monotonic() - entry["started"]})
                self.diagnostic_process = None
            elif time.monotonic() - entry["started"] >= DIAGNOSTIC_RUN_SECONDS:
                self.stop_diagnostic("diagnostic_deadline")
        if self.diagnostic_process is not None or self.diagnostic_pending is None:
            return
        if self.stop_requested.is_set():
            self.diagnostic_pending = None
            return
        stage, budget_path = self.diagnostic_pending
        self.diagnostic_pending = None
        stream = None
        try:
            run_id = uuid.uuid4().hex
            root = no_symlinks(self.directory / "diagnostics")
            invocation = no_symlinks(root / "invocations" / run_id)
            invocation.mkdir(parents=True)
            current = time.monotonic()
            timing = {"source_seconds": None, "replay_seconds": None, "integration_seconds": None,
                "controller_observation_seconds": current - self.observation_started if self.observation_started is not None else None,
                "source_terminal_observed_after_seconds": self.source_observed - self.observation_started
                    if self.source_observed is not None and self.observation_started is not None else None,
                "replay_observation_after_last_source_seconds": current - self.source_observed
                    if stage == "controller-terminal" and self.source_observed is not None else None,
                "waiting_seconds": self.diagnostic_wait_seconds,
                "interpretation": "Monotonic controller observation windows, not historical source/replay stage durations."}
            timing_path = invocation / "workflow-timing.json"
            write_new(timing_path, timing)
            resources = self.plan.get("diagnostics", {}).get("resource_paths", [])
            command = [sys.executable, str(Path(__file__).with_name("campaign_diagnostics.py")),
                "--manifest", str(self.manifest_path), "--state-dir", str(self.directory),
                "--bench", str(self.bench), "--budget", str(budget_path), "--output-root", str(root),
                "--stage", stage, "--run-id", run_id, "--workflow-timing", str(timing_path)]
            for path in resources:
                command.extend(["--resource", str(path)])
            stream = (invocation / "diagnostic.log").open("x")
            # Only this read-only process is cancellable here. Never target the
            # paid launcher, Harbor, gateway, worker VM or a process group.
            process = self.diagnostics_launcher(command, cwd=ROOT, stdout=stream,
                stderr=subprocess.DEVNULL, start_new_session=True)
            self.diagnostic_process = {"process": process, "log": stream, "run_id": run_id,
                "stage": stage, "started": current}
            self.diagnostic_event({"run_id": run_id, "stage": stage, "status": "pending"})
        except Exception as error:
            if stream is not None:
                stream.close()
            self.diagnostic_event({"stage": stage, "status": "unknown",
                "failure": safe_failure(error, "diagnostic_launch_failed")})

    def finish_diagnostics(self, budget_path, *, cancelled=False):
        """Finite close, including cancellation; no executor/atexit wait exists."""
        self.diagnostic_active = False
        if not self.diagnostics_enabled:
            return
        if cancelled or self.stop_requested.is_set():
            self.diagnostic_pending = None
            self.stop_diagnostic("controller_cancelled_or_failed")
            return
        self.queue_diagnostic("controller-terminal", budget_path)
        started = time.monotonic()
        deadline = started + DIAGNOSTIC_CLOSE_SECONDS
        while (self.diagnostic_process is not None or self.diagnostic_pending is not None) and time.monotonic() < deadline:
            if self.stop_requested.is_set():
                self.diagnostic_pending = None
                break
            self.poll_diagnostic()
            if self.diagnostic_process is not None:
                try:
                    self.diagnostic_process["process"].wait(timeout=min(.1, max(0., deadline - time.monotonic())))
                except subprocess.TimeoutExpired:
                    pass
        self.diagnostic_wait_seconds += time.monotonic() - started
        self.poll_diagnostic()
        if self.diagnostic_process is not None:
            self.stop_diagnostic("controller_close_deadline")
        if self.diagnostic_pending is not None:
            self.diagnostic_event({"stage": self.diagnostic_pending[0], "status": "unknown",
                "reason": "controller_close_deadline_before_launch"})
            self.diagnostic_pending = None
        self.diagnostic_event({"stage": "controller-close", "waiting_seconds": self.diagnostic_wait_seconds,
            "unfinished_diagnostic": self.diagnostic_process is not None})

    def run_batch(self, batch_id, budget_path):
        with self.cancellation_signals():
            return self.run_interruptible_batch(batch_id, budget_path)

    def run_interruptible_batch(self, batch_id, budget_path):
        batch = next((item for item in self.plan["batches"] if item["id"] == batch_id), None)
        if batch is None:
            raise ValueError("Unknown frozen batch")
        indices = batch["attempts"]
        self.reconcile(range(1, len(self.manifest["attempts"]) + 1))
        self.refresh_report(budget_path)
        blocked = self.blocked_queues()
        eligible = {index: (["replay"] if self.state["attempts"][str(index)]["status"] == "replay_ready" else ["source", "replay"])
                    for index in indices if self.state["attempts"][str(index)]["status"] in {"pending", "replay_ready"}
                    and "*" not in blocked and self.manifest["attempts"][index - 1]["participant"] not in blocked}
        if not eligible or self.stop_requested.is_set():
            try:
                return self._run_admitted_batch(batch_id, indices, budget_path)
            except BaseException:
                self.finish_diagnostics(budget_path, cancelled=True)
                raise
        leases = ResourceLeases(self.bench / "campaign/resource-leases", self.manifest["resource_pool"])
        scope = scope_for(self.manifest, self.manifest_hash, eligible, owner=str(self.directory.resolve()),
                          batch_id=batch_id, plan_sha256=self.plan_hash, kind="batch")
        with admission_session(leases, scope, manifest_path=self.manifest_path, bench=self.bench,
                               tasks_root=self.bench / "datasets/swebench-pro-v2/v2/tasks",
                               probe_fn=self.admission_probe) as admission:
            self.admission = admission
            try:
                return self._run_admitted_batch(batch_id, indices, budget_path)
            except BaseException:
                self.finish_diagnostics(budget_path, cancelled=True)
                # ThreadPool context has joined workers; ambiguous checkpoint
                # completion still requires explicit physical reconciliation.
                if any(self.state["attempts"][str(i)]["status"] in {"dispatching", "uncertain", "identity_failed"} for i in indices):
                    admission.block("controller_completion_unknown")
                raise
            finally:
                self.admission = None

    def _run_admitted_batch(self, batch_id, indices, budget_path):
        self.diagnostic_active = True
        self.observation_started = time.monotonic()
        self.state["batches"][batch_id] = {"started_at": now(), "status": "running"}
        self.save()
        running = {}
        interrupted = False
        next_report = time.monotonic() + 5
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.plan["workers"]) as pool:
            try:
                while True:
                    self.poll_diagnostic()
                    if self.stop_requested.is_set():
                        if not interrupted:
                            interrupted = True
                            if self.admission:
                                self.admission.drain()
                            self.state["batches"][batch_id].update({"status": "draining", "interruption": {
                                "signal": self.stop_signal, "requested_at": now()}})
                            for index in running.values():
                                self.state["attempts"][str(index)]["cancellation_requested_at"] = now()
                            self.save()
                        self.cancel_launchers()
                        self.diagnostic_pending = None
                        self.stop_diagnostic("controller_cancelled")
                    blocked = self.blocked_queues()
                    for index in indices:
                        if self.stop_requested.is_set() or len(running) >= self.plan["workers"] or "*" in blocked:
                            break
                        entry = self.state["attempts"][str(index)]
                        participant = self.manifest["attempts"][index - 1]["participant"]
                        if entry["status"] not in {"pending", "replay_ready"} or participant in blocked:
                            continue
                        replay_only = entry["status"] == "replay_ready"
                        entry.update({"status": "dispatching", "dispatch_started_at": now(), "replay_only": replay_only})
                        self.save()
                        running[pool.submit(self.launcher, index, replay_only)] = index
                    if not running:
                        break
                    done, _ = concurrent.futures.wait(running, timeout=.2, return_when=concurrent.futures.FIRST_COMPLETED)
                    for future in done:
                        index = running.pop(future)
                        entry = self.state["attempts"][str(index)]
                        try:
                            entry["launcher_exit_code"] = future.result()
                        except Exception as error:
                            entry["launcher_error"] = {"type": type(error).__name__, "message": str(error)}
                        entry["dispatch_finished_at"] = now()
                        self.reconcile([index])
                    if done or time.monotonic() >= next_report:
                        self.refresh_report(budget_path)
                        next_report = time.monotonic() + 5
            except KeyboardInterrupt:
                self.request_stop(signal.SIGINT)
                if self.admission:
                    self.admission.drain()
                self.cancel_launchers()
                interrupted = True
                self.state["batches"][batch_id].update({"status": "draining", "interruption": {
                    "signal": self.stop_signal, "requested_at": now()}})
                self.save()
        self.reconcile(indices)
        self.refresh_report(budget_path)
        states = [self.state["attempts"][str(index)]["status"] for index in indices]
        if self.admission and any(state in {"uncertain", "identity_failed", "dispatching"} for state in states):
            self.admission.block("attempt_outcome_requires_reconciliation")
        status = "completed" if all(state in {"completed", "solve_failed"} for state in states) else "blocked"
        self.state["batches"][batch_id].update({"status": "interrupted" if interrupted else status, "finished_at": now()})
        if interrupted:
            self.state["batches"][batch_id]["interruption"]["launcher_attempts"] = sorted(self.cancelled_launchers)
        self.save()
        self.finish_diagnostics(budget_path, cancelled=interrupted)
        return self.state["batches"][batch_id]["status"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--batch", help="Exactly one predeclared batch; subsequent batches require a new invocation")
    parser.add_argument("--run", action="store_true", help="Dispatch paid source attempts; default only reports")
    parser.add_argument("--budget", type=Path, help="Defaults to the frozen gateway directory/budget.json")
    parser.add_argument("--release-queue-after", type=int, help="Acknowledge one diagnosed blocker; never retry its source")
    parser.add_argument("--reason", help="Evidence/reason for resuming later attempts after a blocker")
    args = parser.parse_args()
    if args.run and not args.batch:
        parser.error("--run requires --batch")
    plan, manifest, manifest_path, plan_hash, _ = load_plan(args.plan, BENCH / "jobs")
    budget_path = args.budget or Path(plan["gateway_directory"]) / "budget.json"
    with controller_lock(args.state_dir):
        campaign = Campaign(plan, manifest, manifest_path, plan_hash, args.state_dir)
        campaign.reconcile(range(1, len(manifest["attempts"]) + 1))
        if args.release_queue_after is not None:
            campaign.refresh_report(budget_path)
            item = campaign.state["attempts"].get(str(args.release_queue_after))
            if not args.reason or item is None or item["status"] != "infrastructure_failed":
                parser.error("Only a diagnosed infrastructure blocker can be acknowledged, with --reason")
            campaign.state["queue_releases"].append({"attempt": args.release_queue_after,
                "issue": item.get("issue"), "request_ids": (item.get("request_failure") or {}).get("request_ids"),
                "reason": args.reason, "at": now()})
            campaign.save()
        if args.run:
            status = campaign.run_batch(args.batch, budget_path)
        else:
            campaign.refresh_report(budget_path)
            status = "report_only"
        print(json.dumps({"status": status, "checkpoint": str(campaign.path.resolve()),
                          "blocked_queues": campaign.blocked_queues()}))
        return 0 if status in {"completed", "report_only"} and not campaign.blocked_queues() else 2


if __name__ == "__main__":
    sys.exit(main())
