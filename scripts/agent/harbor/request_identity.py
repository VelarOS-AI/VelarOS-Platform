"""Controller-owned request attribution; signed credentials never enter public evidence."""
import base64
import datetime
import hashlib
import hmac
import json
import os
import re
from pathlib import Path

IDENTITY_FIELDS = ("campaignId", "candidateId", "participantId", "taskId", "attemptId", "jobId", "phase")


def validate_identity(value):
    if (not isinstance(value, dict) or set(value) != set(IDENTITY_FIELDS)
            or any(not isinstance(value[key], str) or not re.fullmatch(r"[A-Za-z0-9_.:@+/-]{1,256}", value[key])
                   for key in IDENTITY_FIELDS) or value["phase"] not in ("source", "install", "replay")):
        raise ValueError("Invalid attempt identity")
    return {key: value[key] for key in IDENTITY_FIELDS}


def attempt_credential(identity, secret):
    def encode(value):
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode()
    payload = encode(json.dumps(validate_identity(identity), separators=(",", ":")).encode())
    signature = encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
    return "sa1." + payload + "." + signature



def authenticate_attempt(credential, secret):
    """Verify before parsing caller-supplied identity; used by the optional protocol bridge."""
    if not isinstance(credential, str) or not re.fullmatch(r"sa1\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43}", credential):
        return None
    _, payload, signature = credential.split(".")
    expected = base64.urlsafe_b64encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        return validate_identity(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))))
    except (ValueError, TypeError):
        return None


def prepare_attempt_environment(environment, identity, directory):
    """Keep the controller token on the host; all tested agents receive the same scoped credential."""
    identity = validate_identity(identity)
    secret = Path(environment["SCRIPTACT_BENCH_TOKEN_FILE"]).read_text().strip()
    token = attempt_credential(identity, secret)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (hashlib.sha256(identity["attemptId"].encode()).hexdigest() + ".token")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(token)
    return {**environment, "SCRIPTACT_BENCH_TOKEN_FILE": str(path),
            "OPENAI_API_KEY": token, "ANTHROPIC_API_KEY": token}


def attributed_requests(job, directory, result, config, requests):
    """Identity is authoritative. Legacy single-trial evidence uses its explicitly serial time window."""
    path = job / "request-identity.json"
    if path.exists():
        identity = validate_identity(json.loads(path.read_text()))
        if identity["jobId"] != job.name or Path(identity["taskId"]).name != Path(result["task_name"]).name:
            raise ValueError("Attempt identity does not match its job/task")
        # A controller credential belongs to exactly one trial; do not fan it out across retries.
        trials = [item for item in job.iterdir() if item.is_dir() and (item / "config.json").exists()]
        if len(trials) != 1:
            raise ValueError("A scoped attempt must contain exactly one trial")
        calls = []
        seen = set()
        for call in requests:
            owner = call.get("identity")
            if owner is None:
                continue
            owner = validate_identity(owner)
            if owner["jobId"] == identity["jobId"] and owner["attemptId"] != identity["attemptId"]:
                raise ValueError("A job was dispatched with multiple attempt identities")
            if owner["attemptId"] != identity["attemptId"]:
                continue
            if owner != identity:
                raise ValueError("Request attempt identity conflicts with the frozen identity")
            if not call.get("id") or call["id"] in seen:
                raise ValueError("Duplicate or missing request identity")
            seen.add(call["id"])
            calls.append(call)
        return calls, {"mode": "identity", "identity": identity, "request_ids": sorted(seen)}
    if config.get("n_concurrent_trials", 1) != 1:
        raise ValueError("Concurrent trials require explicit request identities")
    if any((call.get("identity") or {}).get("jobId") == job.name for call in requests):
        raise ValueError("Attributed requests exist but the attempt manifest is missing")
    return None, {"mode": "legacy-serial-window", "identity": None}


def validate_request_ledger(requests):
    """A gateway request is an immutable accounting unit, independent of trial timing."""
    seen = set()
    for call in requests:
        if not call.get("id") or call["id"] in seen:
            raise ValueError("Duplicate or missing gateway request ID")
        seen.add(call["id"])
        if call.get("identity") is not None:
            validate_identity(call["identity"])


def verify_unique_attribution(summaries):
    owners = {}
    for summary in summaries:
        trials = summary["trials"] + [row["source"] for row in summary.get("ungraded_sources", [])]
        for trial in trials:
            owner = trial["result"]
            for identifier in trial.get("request_attribution", {}).get("request_ids", []):
                if identifier in owners and owners[identifier] != owner:
                    raise ValueError("A gateway request was attributed to multiple trials")
                owners[identifier] = owner


def legacy_requests(job, directory, requests, start, finish):
    """Historical time attribution is valid only when no other local legacy trial claims that request."""
    calls = [call for call in requests if not call.get("identity")
             and start <= datetime.datetime.fromisoformat(call["startedAt"]) <= finish]
    if not calls:
        return calls
    own_result = (directory / "result.json").resolve()
    for candidate in job.parent.glob("*/*/result.json"):
        other_job = candidate.parent.parent
        if candidate.resolve() == own_result or not (other_job / "config.json").exists() or (other_job / "request-identity.json").exists():
            continue
        result = json.loads(candidate.read_text())
        execution = result.get("agent_execution") or {}
        if not execution.get("started_at"):
            continue
        begin = datetime.datetime.fromisoformat(execution["started_at"])
        end_text = result.get("finished_at") or execution.get("finished_at")
        end = datetime.datetime.fromisoformat(end_text) if end_text else None
        if any(begin <= datetime.datetime.fromisoformat(call["startedAt"]) and
               (end is None or datetime.datetime.fromisoformat(call["startedAt"]) <= end) for call in calls):
            raise ValueError("Legacy gateway requests overlap another trial; request ownership is ambiguous")
    return calls
