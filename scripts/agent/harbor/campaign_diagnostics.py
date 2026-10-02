"""Read-only, versioned campaign diagnostics; never dispatch or reconcile paid work."""

import argparse
import ast
import contextlib
import datetime
import fcntl
import hashlib
import json
import math
import os
import re
import sys
import time
import uuid
from pathlib import Path


HERE = Path(__file__).resolve().parent
BENCH = HERE.parents[2] / ".velaros-workspace/bench"
RUN_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\Z")
STAGES = frozenset({"manual", "source-terminal", "controller-terminal"})
PRIVATE_FIELDS = frozenset({"error", "message", "exception_message", "body", "content", "text",
    "prompt", "command", "stdout", "stderr", "stack", "traceback", "authorization", "api_key",
    "apiKey", "key", "token", "secret", "password"})


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def file_digest(path):
    return digest(Path(path).read_bytes())


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def no_symlinks(path):
    """Reject aliasing before resolve, including a dangling final symlink."""
    path = Path(os.path.abspath(path))
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("Diagnostic output cannot traverse symlinks")
    return path


def write_new(path, value):
    """Published evidence is append-only; a partial write is never a reusable receipt."""
    path = no_symlinks(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def safe_failure(error, category):
    # Arbitrary provider/error prose and tracebacks are deliberately not copied.
    return {"category": category, "type": type(error).__name__,
            "message_sha256": digest(str(error).encode())}


def report_failure_category(error):
    text = str(error).lower()
    if any(word in text for word in ("identity", "frozen", "candidate", "model differs", "task differs")):
        return "identity_evidence_failed"
    if any(word in text for word in ("ledger", "attribution", "request")):
        return "accounting_evidence_failed"
    if any(word in text for word in ("replay", "verifier", "reward")):
        return "grading_evidence_failed"
    return "diagnostic_reporting_failed"


def safe_projection(value, field=None):
    """Keep formal numeric/status findings, hash free-form error/prompt material."""
    if isinstance(value, dict):
        return {key: safe_projection(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [safe_projection(item, field) for item in value]
    if isinstance(value, str):
        if field in PRIVATE_FIELDS:
            return {"omitted": "free_form_or_private", "sha256": digest(value.encode()),
                    "chars": len(value)}
        # Structured metadata occasionally carries an upstream URL or token.
        if re.search(r"(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|Bearer\s+\S+)", value, re.I):
            return {"omitted": "credential_pattern", "sha256": digest(value.encode())}
    return value


def workflow_timing_fields(value):
    value = value if isinstance(value, dict) else {}
    fields = ("source_seconds", "replay_seconds", "integration_seconds", "waiting_seconds",
              "controller_observation_seconds", "source_terminal_observed_after_seconds",
              "replay_observation_after_last_source_seconds")
    result = {}
    for field in fields:
        number = value.get(field)
        result[field] = number if type(number) in (int, float) and math.isfinite(number) and number >= 0 else None
    result["interpretation"] = "Measured current invocation/observation only; unmeasured historical stages remain unknown."
    return result


def implementation_hashes():
    """Bind the local Python import closure of the actual reporting implementation."""
    pending = [HERE / name for name in ("campaign_diagnostics.py", "parallel_campaign.py", "evidence_index.py")]
    result = {}
    while pending:
        path = pending.pop()
        if str(path) in result:
            continue
        raw = path.read_bytes()
        result[str(path)] = digest(raw)
        for node in ast.walk(ast.parse(raw, filename=str(path))):
            names = ([alias.name for alias in node.names] if isinstance(node, ast.Import)
                     else [node.module] if isinstance(node, ast.ImportFrom) and node.module else [])
            for name in names:
                local = HERE / (name.split(".")[0] + ".py")
                if local.is_file() and str(local) not in result:
                    pending.append(local)
    return dict(sorted(result.items()))


def collect(manifest, state_directory, manifest_path, bench, budget_path, resource_paths):
    from evidence_index import collect_campaign_evidence
    return collect_campaign_evidence(manifest, state_directory, manifest_path=manifest_path,
        bench_directory=bench, ledger_path=budget_path, resource_paths=resource_paths)


def formal_report(manifest, manifest_hash, bench, budget_path):
    # Deferred import avoids a cycle when the live controller starts this entry.
    from parallel_campaign import repository_snapshot, scoped_requests
    from metrics import compare_jobs, request_metrics
    requests = scoped_requests(manifest, manifest_hash, json.loads(Path(budget_path).read_text())["requests"])
    jobs = repository_snapshot(manifest, manifest_hash, bench, requests)
    return {"schema": 1, "manifest_sha256": manifest_hash, "model": manifest["model"],
        "reasoning_effort": manifest["reasoning_effort"], "jobs": jobs,
        "all_attempt_requests": request_metrics(requests),
        "comparisons": [compare_jobs(jobs[0], job) for job in jobs[1:]] if jobs else [],
        "supports_general_superiority": False}


def reusable_version(versions, key):
    for directory in sorted(versions.glob(key + "-*")):
        if directory.is_symlink() or not directory.is_dir():
            continue
        receipt_path = directory / "publication.json"
        try:
            no_symlinks(receipt_path)
            receipt = json.loads(receipt_path.read_text())
            if receipt.get("status") != "complete" or receipt.get("input_key") != key:
                continue
            outputs = receipt["outputs"]
            if set(outputs) != {"evidence-index.json", "report.json", "diagnostics.json"}:
                continue
            for name, expected in outputs.items():
                path = no_symlinks(directory / name)
                if path.parent != directory or file_digest(path) != expected:
                    raise ValueError("Stored diagnostic output changed")
            return directory, receipt
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return None


def run_campaign_diagnostics(manifest_path, state_directory, *, budget_path=None, bench=BENCH,
                             output_root=None, stage="manual", workflow_timing=None,
                             resource_paths=(), run_id=None):
    """Only successful immutable evidence can be reused; races remain unknown."""
    started = time.monotonic()
    if stage not in STAGES:
        raise ValueError("Unknown diagnostic stage")
    manifest_path, state_directory, bench = map(lambda p: no_symlinks(p).resolve(),
        (manifest_path, state_directory, bench))
    output_root = no_symlinks(output_root or state_directory / "diagnostics")
    if output_root in (state_directory, manifest_path.parent, bench) or output_root.is_file():
        raise ValueError("Use an independent diagnostic output directory")
    output_root.mkdir(parents=True, exist_ok=True)
    run_id = run_id or uuid.uuid4().hex
    if not RUN_ID.fullmatch(run_id):
        raise ValueError("Invalid diagnostic run ID")
    invocation = no_symlinks(output_root / "invocations" / run_id)
    invocation.mkdir(parents=True, exist_ok=True)
    result = {"schema": 1, "run_id": run_id, "stage": stage, "started_at": now(),
              "status": "unknown", "reused": False, "workflow_timing": workflow_timing_fields(workflow_timing)}
    category = "diagnostic_input_failed"
    lock = no_symlinks(output_root / "diagnostics.lock").open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw = manifest_path.read_bytes()
        manifest = json.loads(raw)
        manifest_hash = digest(raw)
        budget_path = no_symlinks(budget_path or Path(manifest["gateway"]["directory"]) / "budget.json").resolve()
        resource_paths = [no_symlinks(path).resolve() for path in resource_paths]
        inputs_started = time.monotonic()
        code = implementation_hashes()
        index = collect(manifest, state_directory, manifest_path, bench, budget_path, resource_paths)
        if index.get("manifest_sha256") != manifest_hash:
            raise ValueError("Index manifest binding differs")
        key = digest(encoded({"evidence": index["input_fingerprint"], "implementation": code}))
        result["input_key"] = key
        result["input_collection_seconds"] = time.monotonic() - inputs_started
        versions = no_symlinks(output_root / "versions")
        versions.mkdir(exist_ok=True)
        category = "diagnostic_reporting_failed"
        reuse = reusable_version(versions, key) if index.get("status") == "complete" else None
        if reuse:
            directory, receipt = reuse
            # Publication can be reused only if inputs stayed stable during validation.
            after = collect(manifest, state_directory, manifest_path, bench, budget_path, resource_paths)
            if (after.get("input_fingerprint") != index["input_fingerprint"]
                    or manifest_path.read_bytes() != raw or implementation_hashes() != code):
                result["failure"] = {"category": "evidence_changed_during_diagnostic"}
            else:
                result.update({"status": "complete", "reused": True, "version": str(directory),
                               "publication_sha256": file_digest(directory / "publication.json")})
        else:
            directory = versions / (key + "-" + run_id)
            directory.mkdir()
            analysis_started = time.monotonic()
            # Integrity/path/identity blockers must not fall through to an older
            # report reader which assumes that paths have already been trusted.
            if index.get("status") == "unknown":
                report = {"schema": 1, "manifest_sha256": manifest_hash, "jobs": [],
                          "failure": {"category": "evidence_index_blocked"}}
            else:
                try:
                    report = formal_report(manifest, manifest_hash, bench, budget_path)
                except Exception as error:
                    report = {"schema": 1, "manifest_sha256": manifest_hash, "jobs": [],
                              "failure": safe_failure(error, report_failure_category(error))}
            result["analysis_seconds"] = time.monotonic() - analysis_started
            category = "diagnostic_consistency_failed"
            after = collect(manifest, state_directory, manifest_path, bench, budget_path, resource_paths)
            stable = (after.get("input_fingerprint") == index["input_fingerprint"]
                and manifest_path.read_bytes() == raw and implementation_hashes() == code)
            status = index.get("status") if stable else "unknown"
            if report.get("failure"):
                status = "unknown"
            if status not in {"complete", "partial", "unknown"}:
                status = "unknown"
            diagnostics = {"schema": 1, "status": status, "implementation_sha256": code,
                "timing": {"input_collection_seconds": result["input_collection_seconds"],
                    "analysis_seconds": result["analysis_seconds"],
                    "diagnostic_seconds": time.monotonic() - started},
                "findings": {"evidence_status": index.get("status"), "issues": index.get("issues", []),
                    "quality_and_stability": [{"participant": job["job"], "planned": job["planned"],
                        "completed": job["completed"], "errors": job["errors"],
                        "infrastructure_issues": job["infrastructure_issues"],
                        "aggregate": job["aggregate"]} for job in report["jobs"]]},
                "workflow_timing": result["workflow_timing"],
                "interpretation": "Existing development evidence only. Unknown historical stages and actual fees remain unknown. Diagnostics never authorize paid work."}
            if not stable:
                diagnostics["failure"] = {"category": "evidence_changed_during_diagnostic"}
            elif report.get("failure"):
                diagnostics["failure"] = report["failure"]
            write_new(directory / "evidence-index.json", safe_projection(index))
            write_new(directory / "report.json", safe_projection(report))
            write_new(directory / "diagnostics.json", safe_projection(diagnostics))
            receipt = {"schema": 1, "status": status, "input_key": key, "published_at": now(),
                "outputs": {name: file_digest(directory / name) for name in
                    ("evidence-index.json", "report.json", "diagnostics.json")}}
            write_new(directory / "publication.json", receipt)
            result.update({"status": status, "version": str(directory),
                           "publication_sha256": file_digest(directory / "publication.json")})
    except Exception as error:
        result["failure"] = safe_failure(error, "diagnostic_busy" if isinstance(error, BlockingIOError) else category)
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
        result.update({"finished_at": now(), "invocation_seconds": time.monotonic() - started})
        write_new(invocation / "receipt.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--budget", type=Path)
    parser.add_argument("--bench", type=Path, default=BENCH)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--resource", type=Path, action="append", default=[])
    parser.add_argument("--stage", default="manual")
    parser.add_argument("--run-id")
    parser.add_argument("--workflow-timing", type=Path)
    args = parser.parse_args()
    try:
        timing = json.loads(args.workflow_timing.read_text()) if args.workflow_timing else None
        value = run_campaign_diagnostics(args.manifest, args.state_dir, budget_path=args.budget,
            bench=args.bench, output_root=args.output_root, resource_paths=args.resource,
            stage=args.stage, workflow_timing=timing, run_id=args.run_id)
        print(json.dumps({key: value.get(key) for key in ("status", "version", "reused", "invocation_seconds", "failure")}))
        return 0 if value["status"] in {"complete", "partial"} else 2
    except Exception as error:
        print(json.dumps({"status": "unknown", "failure": safe_failure(error, "diagnostic_startup_failed")}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
