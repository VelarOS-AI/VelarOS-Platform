"""Freeze task exposure separately from scores; validate it before dispatch and reporting."""

import argparse
import datetime
import hashlib
import json
from pathlib import Path


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Exposure timestamps must be ISO strings")
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    # Harbor's historical timestamps without offsets were written as UTC.
    return parsed.replace(tzinfo=datetime.timezone.utc) if parsed.tzinfo is None else parsed


def job_observations(jobs_root):
    """Read job metadata only; include failed, install-only and ungraded attempts conservatively."""
    observations = []
    for job in sorted(Path(jobs_root).iterdir()):
        if not job.is_dir():
            continue
        records = {name: json.loads((job / name).read_text()) for name in
                   ("lock.json", "config.json", "result.json") if (job / name).exists()}
        if not records:
            continue
        lock = records.get("lock.json", {})
        tasks = [row["task"] for row in lock.get("trials", [])]
        tasks += records.get("config.json", {}).get("tasks", [])
        dates = [value for value in (lock.get("created_at"), records.get("result.json", {}).get("started_at")) if value]
        observed_at = min(map(timestamp, dates)).isoformat() if dates else None
        names = {Path(task["path"]).name if task.get("path") else task.get("name") for task in tasks}
        if not names or None in names:
            raise ValueError("Cannot determine exposure task identity for job: " + job.name)
        for task in sorted(names):
            observations.append({"task": task, "source": "job:" + job.name, "observed_at": observed_at})
    return observations


def observation_key(row):
    if not isinstance(row, dict) or not isinstance(row.get("task"), str) or not row["task"]:
        raise ValueError("Invalid exposure task")
    if not isinstance(row.get("source"), str) or not row["source"]:
        raise ValueError("Invalid exposure source")
    observed = row.get("observed_at")
    return row["task"], row["source"], timestamp(observed) if observed is not None else None


def task_exposure(manifest, jobs_root, *, require_definition=False):
    """A frozen candidate can count only tasks unobserved before its frozen schedule."""
    tasks = sorted({row["task"] for row in manifest["attempts"]})
    definition = manifest.get("evaluation")
    if definition is None:
        if require_definition:
            raise ValueError("Freeze structured evaluation roles and task exposure before dispatch")
        return {"status": "unverified", "independent_held_out_tasks": [],
                "development_tasks": [], "unknown_tasks": tasks}
    if definition.get("schema") != 1:
        raise ValueError("Unsupported evaluation schema")
    roles = definition.get("roles", {})
    if set(roles) != set(tasks) or any(role not in ("held_out", "development") for role in roles.values()):
        raise ValueError("Evaluation roles must cover exactly the scheduled tasks")
    frozen_at = timestamp(manifest.get("frozen_at"))
    if frozen_at > datetime.datetime.now(datetime.timezone.utc):
        raise ValueError("Candidate freeze time is in the future")
    identity = definition["exposure_snapshot"]
    raw = Path(identity["file"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != identity["sha256"]:
        raise ValueError("Task exposure snapshot changed")
    snapshot = json.loads(raw)
    if snapshot.get("schema") != 1 or timestamp(snapshot.get("created_at")) > frozen_at:
        raise ValueError("Exposure snapshot must precede the candidate freeze")
    observations = snapshot.get("observations")
    if not isinstance(observations, list):
        raise ValueError("Exposure observations must be a list")
    saved = [observation_key(row) for row in observations]
    if len(set((task, source) for task, source, _ in saved)) != len(saved):
        raise ValueError("Duplicate exposure observation")
    if any(date is not None and date > timestamp(snapshot["created_at"]) for _, _, date in saved):
        raise ValueError("Exposure observation is later than its snapshot")
    current = [observation_key(row) for row in job_observations(jobs_root)]
    # An incomplete timestamp is unknown, so it can never establish an unseen task.
    relevant = [row for row in current if row[2] is None or row[2] <= frozen_at]
    if not set(relevant).issubset(set(saved)):
        raise ValueError("Exposure snapshot omits or changes prior job observations")
    exposed = {task for task, _, _ in saved}
    held_out = [task for task in tasks if roles[task] == "held_out"]
    if exposed.intersection(held_out):
        raise ValueError("Observed tasks must be development evidence: " + ", ".join(sorted(exposed.intersection(held_out))))
    return {"status": "verified", "frozen_at": manifest["frozen_at"],
            "exposure_sha256": identity["sha256"], "roles": roles,
            "independent_held_out_tasks": held_out,
            "development_tasks": [task for task in tasks if roles[task] == "development"],
            "unknown_tasks": []}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--observed-task", action="append", default=[], help="Also record a task examined manually or used to guide a fix")
    parser.add_argument("--previous", type=Path, help="Carry forward all previously recorded observations, including archived jobs")
    args = parser.parse_args()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    rows = job_observations(args.jobs_root)
    if args.previous:
        prior = json.loads(args.previous.read_text())
        if prior.get("schema") != 1:
            raise ValueError("Unsupported prior exposure schema")
        current = {(row["task"], row["source"]): observation_key(row) for row in rows}
        for row in prior["observations"]:
            key = observation_key(row)
            if key[:2] in current:
                if current[key[:2]] != key:
                    raise ValueError("Prior exposure observation changed")
            else:
                rows.append(row)
    known = {(row["task"], row["source"]) for row in rows}
    for task in args.observed_task:
        if (task, "manual-review") not in known:
            rows.append({"task": task, "source": "manual-review", "observed_at": now})
            known.add((task, "manual-review"))
    for row in rows:
        observation_key(row)
    snapshot = {"schema": 1, "created_at": now, "observations": rows}
    raw = (json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n").encode()
    # Preserve every previous frozen snapshot.
    with args.output.open("xb") as stream:
        stream.write(raw)
    print(json.dumps({"file": str(args.output.resolve()), "sha256": hashlib.sha256(raw).hexdigest(),
                      "observations": len(rows), "tasks": len({row["task"] for row in rows})}))


if __name__ == "__main__":
    main()
