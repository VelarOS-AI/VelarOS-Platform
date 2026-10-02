"""Read-only, identity-bound campaign evidence discovery; never export payload text."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

from request_identity import validate_identity, validate_request_ledger
from trace_artifact import _key as invocation_key, decode_trace_artifact

BENCH = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\Z")


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def _identity(manifest, manifest_hash, index, phase):
    row = manifest["attempts"][index - 1]
    return validate_identity({"campaignId": manifest_hash,
        "candidateId": _digest(_canonical(manifest["participants"][row["participant"]])),
        "participantId": row["participant"], "taskId": row["task"],
        "attemptId": _digest(f"{manifest_hash}:{index}:{phase}".encode()),
        "jobId": row[phase + "_job"], "phase": phase})


class _Index:
    def __init__(self, bench):
        self.root = Path(bench).absolute()
        self.artifacts, self.issues = [], []

    def path(self, path):
        value = Path(path)
        if not value.is_absolute():
            value = self.root / value
        try:
            relative = value.relative_to(self.root)
        except ValueError:
            raise ValueError("path_outside_bench") from None
        if ".." in relative.parts or any(parent.is_symlink() for parent in (self.root, *self.root.parents)):
            raise ValueError("unsafe_path")
        current = self.root
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                raise ValueError("symlink_not_allowed")
        return value

    def issue(self, code, severity="unknown", **fields):
        self.issues.append({"code": code, "severity": severity, **fields})

    def file(self, path, role, required=True):
        # Open each component beneath the trusted root without following links.
        # O_NONBLOCK prevents an unexpected FIFO/device from blocking discovery.
        item = {"artifact_id": _digest((role + "\0" + str(path)).encode()),
                "role": role, "path": str(path), "sha256": None, "size_bytes": None,
                "state": "unknown", "reason": None, "required": required}
        self.artifacts.append(item)
        descriptor = None
        try:
            path = self.path(path)
            descriptor = os.open(self.root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            parts = path.relative_to(self.root).parts
            if not parts:
                raise ValueError("not_regular_file")
            for part in (*self.root.parts[1:], *parts[:-1]):
                next_descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = next_descriptor
            leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            with os.fdopen(leaf, "rb") as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError("not_regular_file")
                raw = stream.read()
                after = os.fstat(stream.fileno())
            item.update(sha256=_digest(raw), size_bytes=len(raw))
            if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                raise ValueError("file_changed_during_read")
            item["state"] = "verified"
            return item, raw
        except FileNotFoundError:
            item["state"], item["reason"] = "missing", "file_missing"
        except (ValueError, OSError) as error:
            item["reason"] = str(error) if isinstance(error, ValueError) else "file_unreadable_or_unsafe"
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if required:
            self.issue(item["reason"], "blocker" if item["reason"] != "file_missing" else "unknown", artifact_id=item["artifact_id"])
        return item, None

    def json(self, path, role, required=True):
        item, raw = self.file(path, role, required)
        if raw is None:
            return item, None
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("json_object_required")
            return item, value
        except (ValueError, UnicodeError):
            item.update(state="unknown", reason="invalid_json_object")
            if required:
                self.issue("invalid_json_object", artifact_id=item["artifact_id"])
            return item, None


def _jsonl(raw):
    rows = []
    if raw and not raw.endswith(b"\n"):
        raise ValueError("incomplete_jsonl_tail")
    for line in raw.splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError("jsonl_object_required")
        rows.append(value)
    return rows


def _cli_events(raw):
    """CLI stdout may have plain startup notices before its JSON event stream."""
    if raw and not raw.endswith(b"\n"):
        raise ValueError("incomplete_cli_tail")
    rows, prefix = [], []
    for line in raw.splitlines():
        if not line.strip():
            continue
        if not rows and not line.lstrip().startswith(b"{"):
            prefix.append(line)
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError("cli_object_required")
        rows.append(value)
    return rows, {"prefix_text_lines": len(prefix), "prefix_text_sha256": _digest(b"\n".join(prefix)) if prefix else None}


def _trace(index, agent, phase):
    item, raw = index.file(agent / "traces.json", "scriptact_trace")
    phase["artifact_ids"].append(item["artifact_id"])
    if raw is None:
        return
    try:
        source = json.loads(raw)
        if not isinstance(source, dict):
            raise ValueError("invalid_trace")
        blobs = {}
        if "artifactSchema" in source:
            blob_item, blob_raw = index.file(agent / "trace-invocations.jsonl", "scriptact_invocation_blobs")
            phase["artifact_ids"].append(blob_item["artifact_id"])
            if blob_raw is None:
                raise ValueError("invocation_blobs_missing")
            for row in _jsonl(blob_raw):
                key = invocation_key(row)
                if row.get("schema") != 1 or not isinstance(row.get("json"), str) or _digest(row["json"].encode()) != row["sha256"]:
                    raise ValueError("invalid_invocation_blob")
                invocation = json.loads(row["json"])
                if not isinstance(invocation, dict) or invocation.get("id") != row["id"]:
                    raise ValueError("invalid_invocation_identity")
                if key in blobs and blobs[key] != invocation:
                    raise ValueError("conflicting_invocation_blob")
                blobs[key] = invocation
        # Official lossless decoder verifies every referenced material's hash/session identity.
        data = decode_trace_artifact(source, blobs)
        prefix = "data." if "artifactSchema" in source else ""
        sessions = [("root", prefix + "traces", data["traces"])] + [
            ("branch", prefix + f"branches[{number}].turns", branch["turns"])
            for number, branch in enumerate(data.get("branches", []))]
        sdk = []
        for kind, locator, turns in sessions:
            if not isinstance(turns, list):
                raise ValueError("invalid_trace_turns")
            for ordinal, turn in enumerate(turns):
                request = turn.get("request") or {}
                body = request.get("body")
                envelope = json.loads(body) if isinstance(body, str) and body else {}
                provider = envelope.get("providerRequest") if isinstance(envelope, dict) else None
                valid = bool(body) and not request.get("truncated") and isinstance(provider, dict) and isinstance(provider.get("messages"), list)
                location = locator + f"[{ordinal}].request"
                sdk.append({"artifact_id": _digest(("sdk_record\0" + str(agent / "traces.json") + "\0" + location).encode()),
                            "role": "scriptact_compiled_provider_snapshot", "path": str(agent / "traces.json"),
                            "locator": location, "kind": kind, "ordinal": ordinal,
                            "sha256": _digest(body.encode()) if isinstance(body, str) and body else None,
                            "size_bytes": len(body.encode()) if isinstance(body, str) and body else None,
                            "state": "verified" if valid else "unknown", "reason": None if valid else "compiled_provider_snapshot_missing_or_truncated"})
        phase["sdk_records"] = sdk
        phase["trace_validation"] = {"reader": "trace_artifact.decode_trace_artifact",
            "artifact_schema": source.get("artifactSchema", "legacy_raw"), "root_turns": len(data["traces"]),
            "branch_turns": sum(len(branch["turns"]) for branch in data.get("branches", [])),
            "referenced_materials_verified": True, "sdk_scope": "recorded_compiled_provider_payload_not_wire_acceptance"}
        if any(row["state"] != "verified" for row in sdk):
            index.issue("compiled_provider_snapshot_unknown", attempt_id=phase["identity"]["attemptId"])
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        item.update(state="unknown", reason="trace_integrity_or_shape_invalid")
        index.issue("trace_integrity_or_shape_invalid", "blocker", artifact_id=item["artifact_id"])


def _native(index, agent, phase):
    item, raw = index.file(agent / "codex.txt", "codex_cli_jsonl")
    phase["artifact_ids"].append(item["artifact_id"])
    if raw is None:
        return
    try:
        events, preamble = _cli_events(raw)
        phase["native_cli_format"] = preamble
        threads = {event["thread_id"] for event in events if event.get("type") == "thread.started" and isinstance(event.get("thread_id"), str)}
        if not threads:
            raise ValueError("native_cli_thread_identity_missing")
    except (ValueError, UnicodeError):
        item.update(state="unknown", reason="native_cli_jsonl_or_thread_invalid")
        index.issue("native_cli_jsonl_or_thread_invalid", artifact_id=item["artifact_id"])
        return
    sources, headers = [], {}
    for folder in (agent / "sessions", agent / ".codex/sessions"):
        try:
            folder = index.path(folder)
        except ValueError:
            index.issue("native_session_directory_unsafe", "blocker", attempt_id=phase["identity"]["attemptId"])
            continue
        if not folder.exists():
            continue
        for directory, subdirs, files in os.walk(folder, followlinks=False):
            subdirs.sort()
            for name in list(subdirs):
                if (Path(directory) / name).is_symlink():
                    subdirs.remove(name)
                    index.issue("native_session_directory_unsafe", "blocker", attempt_id=phase["identity"]["attemptId"])
            for name in sorted(files):
                if not name.endswith(".jsonl"):
                    continue
                native, raw = index.file(Path(directory) / name, "codex_native_session_jsonl")
                phase["artifact_ids"].append(native["artifact_id"])
                if raw is None:
                    continue
                try:
                    rows = _jsonl(raw)
                    head = rows[0] if rows else {}
                    session_id = (head.get("payload") or {}).get("id") if head.get("type") == "session_meta" else None
                    if session_id not in threads:
                        native.update(state="excluded", reason="session_not_in_bound_cli_threads")
                        continue
                    if session_id in headers:
                        if headers[session_id] != native["sha256"]:
                            raise ValueError("conflicting_native_session_exports")
                        native.update(state="excluded", reason="duplicate_native_session_export")
                        continue
                    headers[session_id] = native["sha256"]
                    native["session_id"] = session_id
                    sources.append(str(Path(directory) / name))
                except (ValueError, TypeError, AttributeError, UnicodeError):
                    native.update(state="unknown", reason="native_session_integrity_or_identity_invalid")
                    index.issue("native_session_integrity_or_identity_invalid", artifact_id=native["artifact_id"])
    phase["native_sources"] = sources
    if set(headers) != threads:
        index.issue("native_session_export_missing", attempt_id=phase["identity"]["attemptId"])


def _phase(index, manifest, manifest_hash, ordinal, kind):
    row = manifest["attempts"][ordinal - 1]
    identity = _identity(manifest, manifest_hash, ordinal, kind)
    job = index.root / "jobs" / identity["jobId"]
    receipt_path = index.root / "campaign" / (identity["jobId"] + "-dispatch.json")
    phase = {"identity": identity, "state": "unknown", "trial_directory": None, "artifact_ids": []}
    receipt_item, receipt = index.json(receipt_path, "dispatch_receipt", required=False)
    phase["artifact_ids"].append(receipt_item["artifact_id"])
    try:
        index.path(job)
        if receipt is None:
            phase["state"] = "unstarted" if receipt_item["state"] == "missing" and not job.exists() else "unknown"
            index.issue("phase_not_started" if phase["state"] == "unstarted" else "dispatch_receipt_unverified", attempt_id=identity["attemptId"])
            return phase
        if receipt.get("request_identity") != identity or receipt.get("manifest_sha256") != manifest_hash or receipt.get("phase") != kind:
            raise ValueError("dispatch_identity_mismatch")
        phase["state"] = "terminal" if receipt.get("status") in ("finished", "failed", "blocked") and receipt.get("finished_at") else "active"
        identity_item, actual = index.json(job / "request-identity.json", "job_request_identity")
        phase["artifact_ids"].append(identity_item["artifact_id"])
        if actual != identity:
            raise ValueError("job_identity_unverified")
        config_item, config = index.json(job / "config.json", "job_config")
        phase["artifact_ids"].append(config_item["artifact_id"])
        if config is None:
            raise ValueError("job_config_unverified")
        trials = []
        for directory in sorted(job.iterdir()):
            index.path(directory)
            if directory.is_dir() and ((directory / "config.json").exists() or (directory / "result.json").exists()):
                trials.append(directory)
        if len(trials) != 1:
            raise ValueError("unique_trial_unverified")
        trial = trials[0]
        phase["trial_directory"] = str(trial)
        if receipt.get("trial_result") and index.path(receipt["trial_result"]) != trial / "result.json":
            raise ValueError("dispatch_result_path_mismatch")
        trial_config_item, trial_config = index.json(trial / "config.json", "trial_config")
        result_item, result = index.json(trial / "result.json", "trial_result")
        phase["artifact_ids"] += [trial_config_item["artifact_id"], result_item["artifact_id"]]
        if trial_config is None or result is None:
            phase["state"] = "active" if phase["state"] == "active" else "unknown"
            return phase
        task = (trial_config.get("task") or {}).get("path") or (trial_config.get("task") or {}).get("name")
        result_task = result.get("task_name")
        if not isinstance(task, str) or Path(task).name != row["task"] or not isinstance(result_task, str) or Path(result_task).name != row["task"] or result.get("trial_name") != trial.name:
            raise ValueError("trial_task_or_identity_mismatch")
        if phase["state"] == "terminal" and not result.get("finished_at"):
            raise ValueError("terminal_result_unfinished")
        job_result_item, _ = index.json(job / "result.json", "job_result", required=phase["state"] == "terminal")
        phase["artifact_ids"].append(job_result_item["artifact_id"])
        agent = trial / "agent"
        atif, _ = index.json(agent / "trajectory.json", "atif_trajectory", required=kind == "source")
        phase["artifact_ids"].append(atif["artifact_id"])
        if kind == "source":
            agent_type = manifest["participants"][row["participant"]].get("agent", "")
            if agent_type.endswith(":RepositoryScriptAct"):
                status_item, status = index.json(agent / "status.json", "scriptact_status")
                phase["artifact_ids"].append(status_item["artifact_id"])
                if not status or status.get("status") not in ("completed", "failed", "cancelled") or (status.get("traceProgress") or {}).get("provisional") is not False:
                    index.issue("scriptact_export_not_final", attempt_id=identity["attemptId"])
                _trace(index, agent, phase)
            elif agent_type.endswith(":RepositoryCodex"):
                _native(index, agent, phase)
            else:
                index.issue("agent_evidence_layout_unknown", attempt_id=identity["attemptId"])
    except (ValueError, OSError, TypeError, AttributeError) as error:
        phase["state"] = "unknown"
        code = str(error) if isinstance(error, ValueError) and NAME.fullmatch(str(error)) else "phase_identity_or_path_unverified"
        index.issue(code, "blocker", attempt_id=identity["attemptId"])
    return phase


def collect_campaign_evidence(manifest, state_directory, *, manifest_path=None,
                              bench_directory=None, ledger_path=None, resource_paths=()):
    """Return stable hashes and exact-attempt discovery, with no writes or dispatch.

    Completeness concerns available, identity-bound evidence, not task success or
    physical resource/provider fairness. Missing provenance is never guessed.
    Fingerprints exclude timestamps and collection duration for diagnostic reuse.
    """
    started = time.monotonic()
    index = _Index(bench_directory if bench_directory is not None else BENCH)
    output = {"schema": 1, "status": "unknown", "manifest_sha256": None, "attempts": [],
              "artifacts": index.artifacts, "issues": index.issues, "ledger": {"state": "unknown"}, "resources": []}
    try:
        index.path(state_directory)
        if manifest_path is None:
            raise ValueError("manifest_path_required")
        item, frozen = index.json(manifest_path, "frozen_manifest")
        if frozen != manifest or item["state"] != "verified":
            raise ValueError("manifest_binding_unverified")
        manifest_hash = output["manifest_sha256"] = item["sha256"]
        jobs = []
        if not isinstance(manifest.get("participants"), dict) or not isinstance(manifest.get("attempts"), list) or not manifest["attempts"]:
            raise ValueError("manifest_shape_invalid")
        for row in manifest["attempts"]:
            if not isinstance(row, dict) or row.get("participant") not in manifest["participants"] or any(not isinstance(row.get(key), str) or not NAME.fullmatch(row[key]) for key in ("participant", "task", "source_job", "replay_job")):
                raise ValueError("manifest_attempt_invalid")
            jobs.extend((row["source_job"], row["replay_job"]))
        if len(jobs) != len(set(jobs)):
            raise ValueError("duplicate_manifest_job")
        for ordinal, row in enumerate(manifest["attempts"], 1):
            output["attempts"].append({"index": ordinal, "participant": row["participant"], "task": row["task"],
                "phases": {kind: _phase(index, manifest, manifest_hash, ordinal, kind) for kind in ("source", "replay")}})
        if ledger_path is None:
            directory = (manifest.get("gateway") or {}).get("directory")
            ledger_path = Path(directory) / "budget.json" if isinstance(directory, str) else None
        if ledger_path is None:
            index.issue("request_ledger_path_missing")
        else:
            ledger_item, ledger = index.json(ledger_path, "signed_request_ledger")
            if ledger is not None:
                try:
                    requests = ledger["requests"]
                    if not isinstance(requests, list):
                        raise ValueError("request_ledger_invalid")
                    validate_request_ledger(requests)
                    expected = {phase["identity"]["attemptId"]: phase["identity"] for attempt in output["attempts"] for phase in attempt["phases"].values()}
                    selected = []
                    for call in requests:
                        owner = call.get("identity")
                        if not owner:
                            continue
                        if owner["attemptId"] in expected:
                            if owner != expected[owner["attemptId"]] or owner["phase"] != "source":
                                raise ValueError("request_attribution_conflict")
                            if call.get("model") != manifest.get("model") or (call.get("metadata") or {}).get("reasoningEffort") != manifest.get("reasoning_effort"):
                                raise ValueError("request_model_or_reasoning_conflict")
                            selected.append(call)
                        elif owner["campaignId"] == manifest_hash or owner["jobId"] in jobs:
                            raise ValueError("request_attribution_conflict")
                    output["ledger"] = {"state": "verified", "artifact_id": ledger_item["artifact_id"],
                        "global_requests": len(requests), "request_ids": [call["id"] for call in selected],
                        "active_requests": sum(not call.get("finishedAt") for call in selected),
                        "unknown_cost_requests": sum(call.get("estimatedUsd") is None for call in selected),
                        "signature_scope": "Gateway-recorded authenticated identity; this reader does not hold signing secrets or independently verify credential HMAC."}
                    selected_attempts = {call["identity"]["attemptId"] for call in selected}
                    for attempt in output["attempts"]:
                        source = attempt["phases"]["source"]
                        if source["identity"]["attemptId"] in selected_attempts and source["state"] in ("unknown", "unstarted"):
                            source["state"] = "unknown"
                            index.issue("request_without_bound_dispatch", "blocker", attempt_id=source["identity"]["attemptId"])
                    if output["ledger"]["active_requests"]:
                        index.issue("attributed_requests_active")
                except (ValueError, KeyError, TypeError, AttributeError):
                    index.issue("request_ledger_integrity_or_attribution_invalid", "blocker", artifact_id=ledger_item["artifact_id"])
        for path in resource_paths:
            item, raw = index.file(path, "resource_samples")
            output["resources"].append({"artifact_id": item["artifact_id"], "binding": "Explicit caller-selected path; campaign/lease attribution requires separate validation."})
            if raw is not None:
                try:
                    _jsonl(raw)
                except (ValueError, UnicodeError):
                    item.update(state="unknown", reason="resource_jsonl_incomplete_or_invalid")
                    index.issue("resource_jsonl_incomplete_or_invalid", artifact_id=item["artifact_id"])
        index.json(index.root / "campaign/resource-leases/resources.json", "resource_leases", required=False)
        if any(issue["severity"] == "blocker" for issue in index.issues):
            output["status"] = "unknown"
        elif index.issues or any(item["state"] == "unknown" for item in index.artifacts) or any(phase["state"] != "terminal" for attempt in output["attempts"] for phase in attempt["phases"].values()):
            output["status"] = "partial"
        else:
            output["status"] = "complete"
    except (ValueError, OSError, TypeError, KeyError) as error:
        code = str(error) if isinstance(error, ValueError) and NAME.fullmatch(str(error)) else "campaign_index_binding_invalid"
        index.issue(code, "blocker")
    output["input_fingerprint"] = _digest(_canonical(output))
    output["observed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    output["collection_seconds"] = time.monotonic() - started
    return output
