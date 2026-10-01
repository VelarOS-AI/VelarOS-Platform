"""One persistent worker epoch around a quiescent disk snapshot and all child phases.

The epoch fences cooperating dispatchers; it does not implement a filesystem quota.
No PID/TTL recovery is automatic. A blocked owner must reconcile physical work first.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path

import disk_admission
from request_identity import validate_identity
from resource_leases import DispatchError, admission_scope


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def member_identity(manifest, manifest_hash, index, phase):
    if type(index) is not int or not 1 <= index <= len(manifest["attempts"]) or phase not in {"source", "install", "replay"}:
        raise ValueError("Admission member index or phase is invalid")
    row = manifest["attempts"][index - 1]
    participant = manifest["participants"][row["participant"]]
    job = row["replay_job"] if phase == "replay" else row["source_job"] + ("-install" if phase == "install" else "")
    return validate_identity({"campaignId": manifest_hash, "candidateId": canonical_hash(participant),
        "participantId": row["participant"], "taskId": row["task"],
        "attemptId": hashlib.sha256(f"{manifest_hash}:{index}:{phase}".encode()).hexdigest(),
        "jobId": job, "phase": phase})


def scope_for(manifest, manifest_hash, phases, *, owner, batch_id, plan_sha256=None,
              kind="standalone", colima_home=None):
    home = Path(colima_home or Path.home() / ".colima").resolve()
    profile = manifest.get("vm", {}).get("profile")
    members = [member_identity(manifest, manifest_hash, index, phase)
               for index, allowed in phases.items() for phase in allowed]
    if len({item["attemptId"] for item in members}) != len(members):
        raise ValueError("Duplicate admission members")
    return admission_scope({"kind": kind, "manifest_sha256": manifest_hash, "plan_sha256": plan_sha256,
        "batch_id": batch_id, "owner": str(owner),
        "worker": {"profile": profile, "socket": str(home / str(profile) / "docker.sock")},
        "members": {item["attemptId"]: item for item in members}})


def write_evidence(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, indent=2) + "\n").encode()
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return hashlib.sha256(raw).hexdigest()


class Admission:
    def __init__(self, leases, claim):
        self.leases, self.claim = leases, claim
        self.admission_id = claim["admission_id"]
        self.settled = True
        self.reason = None

    def drain(self):
        self.leases.drain_admission(self.claim)

    def block(self, reason):
        self.settled, self.reason = False, reason
        self.drain()


@contextlib.contextmanager
def admission_session(leases, scope, *, manifest_path, bench, tasks_root, probe_fn=None):
    """Probe outside the flock while a persisted probing epoch fences all writers."""
    claim = leases.begin_admission(scope)
    handle = Admission(leases, claim)
    evidence_path = Path(bench) / "worker-admissions" / claim["admission_id"] / "result.json"
    # A failed durable evidence write leaves the probing claim intact for review.
    try:
        probe = probe_fn or disk_admission.probe
        result = probe(manifest_path, scope["manifest_sha256"], tasks_root, bench,
            profile=scope["worker"]["profile"],
            colima_home=Path(scope["worker"]["socket"]).parent.parent,
            docker_config=Path(bench) / "docker-config")
        envelope = {"schema": 1, "admission_id": claim["admission_id"], "scope": scope,
                    "capacity": leases.capacity, "probe": result}
        evidence_hash = write_evidence(evidence_path, envelope)
    except BaseException:
        # Unknown probe/durability outcome is not permission to erase a persistent claim.
        raise
    if result.get("status") != "passed":
        leases.finish_admission(claim, settled=True, reason="disk_probe_rejected")
        raise DispatchError("WORKER_DISK_ADMISSION", "Worker disk snapshot rejected; retained evidence: " + str(evidence_path))
    if (result.get("manifest_sha256") != scope["manifest_sha256"] or
            result.get("environment_paths", {}).get("socket") != scope["worker"]["socket"] or
            result.get("plan", {}).get("max_active_attempts") != leases.capacity["max_active_attempts"]):
        leases.finish_admission(claim, settled=True, reason="disk_probe_identity_rejected")
        raise DispatchError("ADMISSION_EVIDENCE", "Disk snapshot does not bind this worker and capacity")
    leases.complete_admission(claim, {"status": "passed", "manifest_sha256": scope["manifest_sha256"],
        "scope_sha256": canonical_hash(scope), "evidence_path": str(evidence_path.resolve()), "evidence_sha256": evidence_hash})
    try:
        yield handle
    finally:
        handle.drain()
        with leases.state() as state:
            has_members = bool(state["leases"])
        leases.finish_admission(claim, settled=handle.settled and not has_members,
                                reason=handle.reason or ("member_settlement_pending" if has_members else None))


@contextlib.contextmanager
def joined_admission(leases, admission_id, identities):
    for identity in identities:
        leases.check_admission(admission_id, identity)
    # Only the parent may drain/retire the epoch, including between member phases.
    yield admission_id


@contextlib.contextmanager
def maintenance_session(leases, *, owner, manifest_sha256, worker):
    """Exclusive ownership spans cache writes, import and its physical settlement."""
    scope = admission_scope({"kind": "maintenance", "manifest_sha256": manifest_sha256,
        "plan_sha256": None, "batch_id": "maintenance", "owner": str(owner), "worker": worker, "members": {}})
    claim = leases.begin_admission(scope)
    handle = Admission(leases, claim)
    try:
        yield handle
    finally:
        leases.finish_admission(claim, settled=handle.settled, reason=handle.reason)
