"""Cross-process resource reservations for one dedicated worker; never reclaim uncertain work."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import time
import tomllib
import urllib.parse
import uuid
from pathlib import Path

from request_identity import validate_identity


class DispatchError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def capacity_policy(value):
    keys = ("max_active_attempts", "cpus", "memory_mb")
    if (not isinstance(value, dict) or set(value) != set(keys) or
            any(type(value[key]) is not int or value[key] < 1 for key in keys)):
        raise ValueError("resource_pool requires positive integer max_active_attempts, cpus, memory_mb")
    return {key: value[key] for key in keys}


def task_resources(task, capacity):
    config = tomllib.loads((Path(task) / "task.toml").read_text())
    environment = config.get("environment", {})
    # A task without an explicit bound reserves the whole worker, rather than undercounting it.
    requested = {key: environment.get(key) or capacity[key] for key in ("cpus", "memory_mb")}
    if any(type(value) is not int or value < 1 for value in requested.values()):
        raise ValueError("Task CPU/memory requirements must be positive integers")
    return requested


def admission_scope(value):
    """An epoch authorizes exact members, not arbitrary work carrying its ID."""
    if not isinstance(value, dict) or set(value) != {"kind", "manifest_sha256", "plan_sha256", "batch_id", "owner", "worker", "members"}:
        raise ValueError("Invalid admission scope")
    scope = json.loads(json.dumps(value))
    if (scope["kind"] not in ("batch", "standalone", "maintenance") or
            not re.fullmatch(r"[a-f0-9]{64}", scope["manifest_sha256"] or "") or
            (scope["plan_sha256"] is not None and not re.fullmatch(r"[a-f0-9]{64}", scope["plan_sha256"])) or
            any(not isinstance(scope[key], str) or not scope[key] for key in ("owner", "batch_id"))):
        raise ValueError("Invalid admission identity")
    worker = scope["worker"]
    if (not isinstance(worker, dict) or set(worker) != {"profile", "socket"} or
            not isinstance(worker["profile"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", worker["profile"]) or
            worker["profile"] == "default" or not isinstance(worker["socket"], str) or not Path(worker["socket"]).is_absolute()):
        raise ValueError("Admission requires an explicit worker identity")
    if not isinstance(scope["members"], dict) or (not scope["members"] and scope["kind"] != "maintenance"):
        raise ValueError("Admission requires scoped members")
    for attempt, member in scope["members"].items():
        member = validate_identity(member)
        if attempt != member["attemptId"] or member["campaignId"] != scope["manifest_sha256"]:
            raise ValueError("Admission member identity mismatch")
    if scope["kind"] == "maintenance" and scope["members"]:
        raise ValueError("Maintenance cannot authorize model attempts")
    return scope


def guard_gateway(state, model, allow_unlimited=False, reasoning_effort=None, *, upstream=None):
    if state.get("attribution") != "signed-attempt-v1" or state.get("model") != model:
        raise DispatchError("GATEWAY_PROTOCOL", "Gateway identity protocol/model differs from the frozen attempt")
    if reasoning_effort is not None and state.get("reasoningEffort") != reasoning_effort:
        raise DispatchError("GATEWAY_PROTOCOL", "Gateway reasoning effort differs from the frozen attempt")
    if state.get("authenticationBlocker") is not None:
        raise DispatchError("UPSTREAM_AUTHENTICATION_BLOCKED", "Gateway upstream authentication is blocked; preserve this attempt and verify credentials before a new campaign")
    if upstream is not None:
        if (not isinstance(upstream, dict) or set(upstream) != {"baseURL", "endpointId"}
                or not isinstance(upstream["baseURL"], str) or not isinstance(upstream["endpointId"], str)):
            raise DispatchError("GATEWAY_PROTOCOL", "Frozen upstream must contain baseURL and endpointId")
        try:
            origin = urllib.parse.urlsplit(upstream["baseURL"])
            valid = (origin.scheme in ("http", "https") and origin.hostname and origin.username is None
                and origin.password is None and not origin.query and not origin.fragment
                and origin.path.endswith("/v1") and origin.port != 0)
        except ValueError:
            valid = False
        if not valid or hashlib.sha256(upstream["baseURL"].encode()).hexdigest() != upstream["endpointId"]:
            raise DispatchError("GATEWAY_PROTOCOL", "Frozen upstream has an invalid API root or endpoint identity")
        actual = state.get("upstream")
        if not isinstance(actual, dict) or any(actual.get(key) != value for key, value in upstream.items()):
            raise DispatchError("GATEWAY_PROTOCOL", "Gateway upstream differs from the frozen attempt")
    unlimited = state.get("budgetMode") == "unlimited" and state.get("limitUsd") is None
    if unlimited:
        if not allow_unlimited:
            raise DispatchError("UNLIMITED_NOT_AUTHORIZED", "Explicit --allow-unlimited or frozen gateway.budget_mode is required")
    elif (not isinstance(state.get("limitUsd"), (int, float)) or
          state["committedUpperUsd"] + state.get("reservationUsd", 20) > state["limitUsd"]):
        raise DispatchError("CAMPAIGN_BUDGET_EXHAUSTED", "Campaign has insufficient unreserved funds")
    return state


class ResourceLeases:
    def __init__(self, directory, capacity):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.capacity = capacity_policy(capacity)
        self.path = self.directory / "resources.json"

    @contextlib.contextmanager
    def state(self):
        with (self.directory / "resources.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = json.loads(self.path.read_text()) if self.path.exists() else {
                "schema": 1, "capacity": self.capacity, "leases": {}, "history": []}
            if (not isinstance(state, dict) or state.get("schema") != 1 or
                    not isinstance(state.get("leases"), dict) or not isinstance(state.get("history"), list)):
                raise DispatchError("RESOURCE_PROTOCOL", "Resource state schema is invalid; reconcile retained evidence")
            current = state.get("admission")
            if current is not None:
                try:
                    admission_scope(current["scope"])
                    valid = (current["status"] in {"probing", "admitted", "draining", "blocked"} and
                             all(isinstance(current[k], str) and current[k] for k in ("admission_id", "owner_nonce")) and
                             current["capacity"] == state["capacity"])
                except (KeyError, TypeError, ValueError):
                    valid = False
                if not valid:
                    raise DispatchError("RESOURCE_PROTOCOL", "Persisted admission is malformed; automatic recovery is forbidden")
            if state["capacity"] != self.capacity:
                if state["leases"] or state.get("admission"):
                    raise DispatchError("RESOURCE_PROTOCOL", "Active work uses another frozen capacity policy")
                state["capacity"] = self.capacity
            yield state
            temporary = self.directory / ("resources." + uuid.uuid4().hex + ".tmp")
            try:
                with temporary.open("x") as stream:
                    json.dump(state, stream, indent=2)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                descriptor = os.open(self.directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            finally:
                temporary.unlink(missing_ok=True)

    def begin_admission(self, scope):
        scope = admission_scope(scope)
        with self.state() as state:
            if state.get("admission") or state["leases"]:
                raise DispatchError("WORKER_ADMISSION_BUSY", "Worker has an admission or unsettled lease; explicit reconciliation is required")
            claim = {"admission_id": uuid.uuid4().hex, "owner_nonce": uuid.uuid4().hex,
                     "owner_pid": os.getpid(), "scope": scope, "capacity": dict(self.capacity),
                     "status": "probing", "members_started": [], "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            state["admission"] = claim
            return json.loads(json.dumps(claim))

    @staticmethod
    def _owned_admission(state, claim):
        current = state.get("admission")
        if not current or any(current.get(key) != claim.get(key) for key in ("admission_id", "owner_nonce", "scope", "capacity")):
            raise DispatchError("ADMISSION_OWNER_MISMATCH", "Admission ownership or frozen scope differs")
        return current

    def complete_admission(self, claim, evidence_binding):
        with self.state() as state:
            current = self._owned_admission(state, claim)
            required = {"status", "manifest_sha256", "scope_sha256", "evidence_path", "evidence_sha256"}
            scope_hash = hashlib.sha256(json.dumps(current["scope"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            if (current["status"] != "probing" or not isinstance(evidence_binding, dict) or set(evidence_binding) != required or
                    evidence_binding["status"] != "passed" or evidence_binding["manifest_sha256"] != current["scope"]["manifest_sha256"] or
                    evidence_binding["scope_sha256"] != scope_hash or not Path(evidence_binding["evidence_path"]).is_absolute() or
                    not re.fullmatch(r"[a-f0-9]{64}", evidence_binding["evidence_sha256"] or "")):
                raise DispatchError("ADMISSION_EVIDENCE", "Passed disk evidence must bind the entire frozen admission scope")
            current.update({"status": "admitted", "evidence": dict(evidence_binding)})

    def check_admission(self, admission_id, identity):
        identity = validate_identity(identity)
        with self.state() as state:
            self._check_member(state, admission_id, identity)

    @staticmethod
    def _check_member(state, admission_id, identity):
        current = state.get("admission")
        if current is None and admission_id is None:
            return  # Legacy external acquirers still participate in the same exclusion lock.
        if (not current or current["status"] != "admitted" or admission_id != current["admission_id"] or
                current["scope"]["members"].get(identity["attemptId"]) != identity):
            raise DispatchError("WORKER_ADMISSION_FENCED", "No admitted epoch authorizes this exact attempt and phase")

    def drain_admission(self, claim):
        with self.state() as state:
            current = self._owned_admission(state, claim)
            if current["status"] != "blocked":
                current["status"] = "draining"

    def finish_admission(self, claim, *, settled, reason=None):
        with self.state() as state:
            current = self._owned_admission(state, claim)
            if settled and state["leases"]:
                raise DispatchError("ADMISSION_UNSETTLED", "Admission still has active or blocked member leases")
            current.update({"status": "released" if settled else "blocked", "reason": reason,
                            "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
            if settled:
                state.setdefault("admission_history", []).append(current)
                state["admission"] = None

    def acquire(self, identity, demand, timeout=300, cancelled=None, *, admission_id=None):
        identity = validate_identity(identity)
        if (set(demand) != {"cpus", "memory_mb"} or
                any(type(value) is not int or value < 1 for value in demand.values())):
            raise ValueError("Invalid task resource demand")
        if any(demand[key] > self.capacity[key] for key in demand):
            raise DispatchError("RESOURCE_TOO_LARGE", "Task resources exceed the worker capacity")
        started = time.monotonic()
        while True:
            if cancelled and cancelled.is_set():
                raise KeyboardInterrupt
            with self.state() as state:
                self._check_member(state, admission_id, identity)
                if identity["attemptId"] in state["leases"]:
                    raise DispatchError("ATTEMPT_ALREADY_LEASED", "Attempt already owns a resource lease")
                if state.get("admission") and identity["attemptId"] in state["admission"].get("members_started", []):
                    raise DispatchError("ADMISSION_MEMBER_CONSUMED", "This member phase already acquired capacity; do not replay it")
                active = list(state["leases"].values())
                fits = len(active) < self.capacity["max_active_attempts"] and all(
                    sum(item["demand"][key] for item in active) + demand[key] <= self.capacity[key]
                    for key in demand)
                if fits:
                    lease = {"lease_id": uuid.uuid4().hex, "identity": identity, "demand": dict(demand),
                             "owner_pid": os.getpid(), "acquired_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                             "queue_wait_seconds": time.monotonic() - started, "status": "active",
                             "admission_id": admission_id}
                    state["leases"][identity["attemptId"]] = lease
                    if state.get("admission"):
                        state["admission"].setdefault("members_started", []).append(identity["attemptId"])
                    return lease
            if time.monotonic() - started >= timeout:
                raise DispatchError("RESOURCE_CAPACITY_TIMEOUT", "Timed out waiting for worker resource capacity")
            time.sleep(min(0.1, max(0, timeout - (time.monotonic() - started))))

    def finish(self, lease, *, settled, reason=None):
        with self.state() as state:
            attempt = lease["identity"]["attemptId"]
            current = state["leases"].get(attempt)
            if not current or current["lease_id"] != lease["lease_id"]:
                raise DispatchError("LEASE_OWNER_MISMATCH", "Only the lease owner may release capacity")
            current.update({"status": "released" if settled else "blocked", "reason": reason,
                            "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
            if settled:
                state["history"].append(state["leases"].pop(attempt))


def wait_for_settlement(read_health, timeout=900):
    started = time.monotonic()
    while True:
        state = read_health()
        if not state["activeUpstreamRequests"] and not state.get("scheduler", {}).get("queued", 0):
            return state
        if time.monotonic() - started >= timeout:
            raise DispatchError("ATTEMPT_UNSETTLED", "Attempt still has model requests settling; retain its lease")
        time.sleep(min(0.2, max(0, timeout - (time.monotonic() - started))))


def verify_job_containers_stopped(job, environment):
    # Match Harbor's exact session names, including its 63-character verifier hash suffix.
    configurations = list(Path(job).glob("*/config.json"))
    if not configurations:
        raise DispatchError("ATTEMPT_CLEANUP_UNKNOWN", "No trial identity exists to confirm container cleanup")
    names, expected, uncertain_prefixes = [], set(), set()
    def compose_name(value):
        lowered = value.lower()
        return re.sub(r"[^a-z0-9_-]", "-", lowered if re.match(r"^[a-z0-9]", lowered) else "0" + lowered)
    for path in configurations:
        config = json.loads(path.read_text())
        name = config.get("trial_name")
        if not isinstance(name, str) or not name:
            raise DispatchError("ATTEMPT_CLEANUP_UNKNOWN", "Trial has no persisted container identity")
        names.append(compose_name(name))
        keys = set()
        complete_keys = False
        task_path = (config.get("task") or {}).get("path")
        if isinstance(task_path, str) and (Path(task_path) / "task.toml").is_file():
            task = tomllib.loads((Path(task_path) / "task.toml").read_text())
            keys.update(step["name"] for step in task.get("steps", []) if isinstance(step.get("name"), str))
            complete_keys = True
        result_path = path.with_name("result.json")
        if result_path.is_file():
            result = json.loads(result_path.read_text())
            keys.update(step["step_name"] for step in result.get("step_results") or [] if isinstance(step.get("step_name"), str))
        steps = path.parent / "steps"
        if steps.is_dir():
            keys.update(step.name for step in steps.iterdir() if step.is_dir())
        for key in keys:
            raw = f"{name}__verifier__{key}"
            safe = "".join(char if char.isalnum() or char in "-._" else "_" for char in raw)
            if len(safe) > 63:
                suffix = "__" + hashlib.sha1(raw.encode()).hexdigest()[:8]
                safe = safe[:63 - len(suffix)].rstrip("-._") + suffix
            expected.add(compose_name(safe))
        if not complete_keys:
            # An interrupted trial may lack step results; do not release a possibly owned hashed session.
            prefix = "".join(char if char.isalnum() or char in "-._" else "_" for char in name + "__verifier__")
            uncertain_prefixes.add(compose_name(prefix[:53].rstrip("-._")))
    running = subprocess.check_output(["docker", "ps", "--format", '{{.Label "com.docker.compose.project"}}'],
                                      env=environment, text=True).splitlines()
    if any(project in expected or project == name + "__env" or project.startswith(name + "__verifier__")
           for project in running for name in names):
        raise DispatchError("ATTEMPT_CONTAINERS_ACTIVE", "This attempt still owns active containers; retain its lease")
    if any(project.startswith(prefix) and re.search(r"__[a-f0-9]{8}$", project)
           for project in running for prefix in uncertain_prefixes):
        raise DispatchError("ATTEMPT_CLEANUP_UNKNOWN", "Verifier step identity is incomplete; retain its lease")


def run_attempt_process(command, *, cwd, environment, log=None, cancelled=None):
    """Each attempt owns one process group; cancellation asks Harbor to perform its normal cleanup."""
    process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=True)
    try:
        while True:
            try:
                return process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                if cancelled and cancelled.is_set():
                    raise KeyboardInterrupt
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=180)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        raise
