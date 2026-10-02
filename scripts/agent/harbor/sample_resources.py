"""Read-only contention samples with one structural resource inspect per new container."""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading

DEFAULT_CONTEXT = "colima-scriptact-bench"
STATS_TIMEOUT_SECONDS = 10
INSPECT_TIMEOUT_SECONDS = 5
SAMPLE_INTERVAL_SECONDS = 10
CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
STATS_FIELDS = (
    "BlockIO", "CPUPerc", "Container", "ID", "MemPerc", "MemUsage",
    "Name", "NetIO", "PIDs",
)
RESOURCE_FIELDS = (
    "nano_cpus", "cpu_quota", "cpu_period", "cpu_shares", "memory_bytes",
    "memory_swap_bytes", "pids_limit", "network_mode",
)
# Only these structural fields leave Docker. Full inspect includes private Env/Cmd.
INSPECT_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},'
    '"nano_cpus":{{json .HostConfig.NanoCpus}},'
    '"cpu_quota":{{json .HostConfig.CpuQuota}},'
    '"cpu_period":{{json .HostConfig.CpuPeriod}},'
    '"cpu_shares":{{json .HostConfig.CpuShares}},'
    '"memory_bytes":{{json .HostConfig.Memory}},'
    '"memory_swap_bytes":{{json .HostConfig.MemorySwap}},'
    '"pids_limit":{{json .HostConfig.PidsLimit}},'
    '"network_mode":{{json .HostConfig.NetworkMode}}}'
)


def instant():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--controller-pid", type=positive_pid, required=True)
    target = result.add_mutually_exclusive_group()
    target.add_argument("--context", help="Docker context; defaults to the dedicated ScriptAct worker")
    target.add_argument("--profile", help="Colima profile, mapped explicitly to colima-<profile>")
    return result


def positive_pid(value):
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("Controller PID must be positive")
    return parsed


def docker_context(args):
    selected = args.context or ("colima-" + args.profile if args.profile else DEFAULT_CONTEXT)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", selected):
        raise ValueError("Invalid Docker context name")
    return selected


def controller_status(pid, run=subprocess.run):
    # Process command text stays in memory; it can contain private host arguments.
    try:
        probe = run(["ps", "-p", str(pid), "-o", "stat=,command="],
                    capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        return {"state": "unknown", "reason": "controller_probe_timeout"}
    except OSError:
        return {"state": "unknown", "reason": "controller_probe_unavailable"}
    if probe.returncode not in (0, 1):
        return {"state": "unknown", "reason": "controller_probe_nonzero_exit"}
    status = probe.stdout.strip()
    if not status or status.startswith("Z") or "parallel_campaign.py" not in status:
        return {"state": "stopped"}
    return {"state": "running"}


def resource_values(info, cid):
    """Keep native zero/unlimited values; unavailable fields never become zero."""
    if not isinstance(info, dict) or info.get("id") != cid or not isinstance(info.get("name"), str):
        raise ValueError("Inspect identity mismatch")
    result = {}
    for field in RESOURCE_FIELDS:
        if field not in info:
            raise ValueError("Missing resource field")
        value = info[field]
        if field == "network_mode":
            if not isinstance(value, str):
                raise ValueError("Invalid network mode")
        elif field == "pids_limit" and value is None:
            pass  # Docker's explicit null is an unset native limit.
        else:
            minimum = -1 if field in ("cpu_quota", "memory_swap_bytes", "pids_limit") else 0
            if type(value) is not int or value < minimum:
                raise ValueError("Invalid numeric resource field")
        result[field] = value
    return result


def inspect_resources(context, stats, run=subprocess.run, clock=instant):
    cid = stats["Container"]
    result = {"started_at": clock(), "container_id": cid, "stats_name": stats.get("Name"),
              "status": "unknown", "values": None}
    try:
        probe = run(["docker", "--context", context, "inspect", "--type", "container",
                     "--format", INSPECT_FORMAT, cid], capture_output=True, text=True,
                    timeout=INSPECT_TIMEOUT_SECONDS)
        if probe.returncode:
            error = probe.stderr.lower()
            disappeared = "no such object" in error or "no such container" in error
            result.update(reason="container_disappeared" if disappeared else "inspect_nonzero_exit",
                          inspect_exit=probe.returncode)
        else:
            info = json.loads(probe.stdout)
            values = resource_values(info, cid)
            result.update(status="recorded", values=values, inspect_name=info["name"],
                          name_matches_stats=info["name"].lstrip("/") == stats.get("Name"))
    except subprocess.TimeoutExpired:
        result["reason"] = "inspect_timeout"
    except OSError:
        result["reason"] = "inspect_unavailable"
    except (ValueError, TypeError):
        result["reason"] = "invalid_inspect_fields_or_identity"
    result["finished_at"] = clock()
    return result


def collect_sample(context, seen, run=subprocess.run, clock=instant, load=os.getloadavg):
    row = {"at": clock(), "host_load_average": load(), "docker_context": context,
           "containers": [], "resource_limits": []}
    try:
        probe = run(["docker", "--context", context, "stats", "--no-stream", "--no-trunc",
                     "--format", "{{json .}}"], capture_output=True, text=True,
                    timeout=STATS_TIMEOUT_SECONDS)
        row["docker_exit"] = probe.returncode
        if probe.returncode:
            row["error"] = "docker_stats_nonzero_exit"
            return row
        for line in probe.stdout.splitlines():
            try:
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise ValueError("Invalid stats row")
                stats = {key: item[key] for key in STATS_FIELDS if key in item}
                # --no-trunc gives a full identity; short IDs cannot safely bind resources.
                cid = stats.get("Container")
                if not isinstance(cid, str) or not CONTAINER_ID.fullmatch(cid):
                    raise ValueError("Invalid stats identity")
                if any(not isinstance(value, str) for value in stats.values()):
                    raise ValueError("Invalid stats fields")
            except (ValueError, TypeError):
                row.setdefault("stats_errors", []).append({"reason": "invalid_stats_fields_or_identity"})
                continue
            row["containers"].append(stats)
            if cid not in seen:
                seen.add(cid)
                row["resource_limits"].append(inspect_resources(context, stats, run, clock))
    except subprocess.TimeoutExpired:
        row["error"] = "docker_stats_timeout"
    except OSError:
        row["error"] = "docker_stats_unavailable"
    row["finished_at"] = clock()
    return row


def main(argv=None):
    args = parser().parse_args(argv)
    context = docker_context(args)
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    seen = set()
    # Never replace a prior run's evidence; open before any process/Docker observation.
    with args.output.open("x") as output:
        while not stopping.is_set():
            controller = controller_status(args.controller_pid)
            if controller["state"] == "stopped":
                break
            if controller["state"] == "unknown":
                output.write(json.dumps({"at": instant(), "error": "controller_status_unknown",
                                         "controller_probe": controller}) + "\n")
                output.flush()
                return 2
            row = collect_sample(context, seen)
            output.write(json.dumps(row) + "\n")
            output.flush()
            stopping.wait(SAMPLE_INTERVAL_SECONDS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
