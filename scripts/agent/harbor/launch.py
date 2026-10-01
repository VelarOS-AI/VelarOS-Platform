"""Run public Harbor tasks with a shared, bounded GPT-6 Sol campaign gateway."""

import argparse
import datetime
import hashlib
import itertools
import re
import json
import os
import subprocess
import sys
import urllib.request
import concurrent.futures
import signal
import threading
from pathlib import Path

from request_identity import prepare_attempt_environment
from repository_launch import environment as gateway_environment, health
from resource_leases import (DispatchError, ResourceLeases, capacity_policy, guard_gateway, task_resources,
    wait_for_settlement, verify_job_containers_stopped, run_attempt_process)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="terminal-bench-sample@2.0")
    parser.add_argument("--agent", choices=["scriptact", "terminus-2", "codex", "pair", "all"], default="scriptact")
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument("--attempts", type=int, default=1)
    naming = parser.add_mutually_exclusive_group()
    naming.add_argument("--name", help="Job prefix; the agent name is appended")
    naming.add_argument("--job-name", help="Exact frozen job name for a single agent")
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--codex-version", default="0.158.0")
    parser.add_argument("--codex-bundle", type=Path)
    parser.add_argument("--python-index", default="https://mirrors.aliyun.com/pypi/simple")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--install-only", action="store_true")
    parser.add_argument("--cancellable-exec", action="store_true", help="Use the versioned container cancellation adapter")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--capacity", type=Path)
    parser.add_argument("--gateway-directory", type=Path)
    parser.add_argument("--gateway-url", default="http://127.0.0.1:48761")
    parser.add_argument("--model", required=True)
    parser.add_argument("--reasoning-effort", default="high")
    parser.add_argument("--allow-unlimited", action="store_true")
    parser.add_argument("--lease-timeout", type=float, default=300)
    parser.add_argument("--settle-timeout", type=float, default=900)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 64 or min(args.lease_timeout, args.settle_timeout) < 0:
        parser.error("Concurrency must be 1..64 and timeouts nonnegative")
    if args.concurrency > 1 and not args.capacity:
        parser.error("Parallel dispatch requires an explicit --capacity file")
    if not 1 <= args.attempts <= 5:
        parser.error("--attempts must be between 1 and 5")
    if args.job_name and args.agent in ("pair", "all"):
        parser.error("--job-name requires a single agent")
    root = Path(__file__).resolve().parents[3]
    work = root / ".velaros-workspace/bench"
    endpoint = args.gateway_url.rstrip("/")
    environment = gateway_environment(args.gateway_directory, endpoint)
    budget = guard_gateway(health(environment), args.model, args.allow_unlimited, args.reasoning_effort)
    print("Campaign budget:", json.dumps(budget), flush=True)
    capacity = capacity_policy(json.loads(args.capacity.read_text()) if args.capacity else {
        "max_active_attempts": 1, "cpus": 1, "memory_mb": 4096})
    if args.concurrency > capacity["max_active_attempts"]:
        parser.error("Concurrency exceeds the explicit resource capacity")
    leases = ResourceLeases(work / "campaign/resource-leases", capacity)
    cancelled = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: cancelled.set())
    signal.signal(signal.SIGINT, lambda *_: cancelled.set())
    agents = {"pair": ["scriptact", "terminus-2"], "all": ["scriptact", "terminus-2", "codex"]}.get(args.agent, [args.agent])
    prefix = args.name or args.job_name or datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    if not args.dry_run and args.dataset == "terminal-bench-sample@2.0":
        preparation = [sys.executable, str(root / "scripts/agent/harbor/prepare-images.py"),
                       "--tasks-root", str(work / "datasets/terminal-bench-sample"),
                       "--output", str(work / "campaign" / f"image-preflight-{prefix}.json")]
        if args.task:
            for task in args.task:
                preparation += ["--task", task]
        else:
            preparation.append("--all")
        subprocess.run(preparation, cwd=root, env=environment, check=True)
    tasks = sorted(set(args.task))
    if not tasks:
        task_root = work / "datasets" / args.dataset.split("@", 1)[0]
        tasks = sorted(path.parent.name for path in task_root.glob("*/task.toml"))
    if not tasks or any(not re.fullmatch(r"[A-Za-z0-9_.-]+", task) or task in (".", "..") for task in tasks):
        parser.error("Provide exact --task IDs or an installed dataset with task.toml files; glob selectors cannot share one credential")
    if args.job_name and (len(tasks) != 1 or args.attempts != 1):
        parser.error("--job-name requires exactly one task and one attempt")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", prefix) or prefix in (".", ".."):
        parser.error("Job prefix must be a single safe path component")
    def run_one(item):
        agent, task, attempt = item
        job_name = args.job_name or f"{prefix}-{agent}-{task}-{attempt + 1}"
        command = [str(work / "venv/bin/harbor"), "run", "-d", args.dataset,
                   "-m", "openai/" + args.model, "-n", "1", "-k", "1",
                   "-e", "scripts.agent.harbor.cancellable_environment:CancellableBenchmarkDocker" if args.cancellable_exec else "scripts.agent.harbor.environment:BenchmarkDocker",
                   "--max-retries", "0", "-o", str(work / "jobs"), "--job-name", job_name]
        if args.install_only:
            command.append("--install-only")
        if agent == "scriptact":
            command += ["-a", "scripts.agent.harbor.agent:ScriptActAgent", "--ak", "bundle=" + str((args.bundle or work / "bundle").resolve()), "--ak", "reasoning_effort=" + args.reasoning_effort]
        elif agent == "terminus-2":
            command += ["-a", "terminus-2", "--ak", "api_base=" + endpoint + "/v1", "--ak", "reasoning_effort=" + args.reasoning_effort, "--ak", "use_responses_api=false", "--ak", "model_info=" + json.dumps({"max_input_tokens":922000,"max_output_tokens":32768,"max_tokens":1050000,
                "input_cost_per_token":budget["pricing"]["input"] / 1000000,
                "output_cost_per_token":budget["pricing"]["output"] / 1000000,
                "cache_read_input_token_cost":budget["pricing"]["cached"] / 1000000,
                "cache_creation_input_token_cost":budget["pricing"]["write"] / 1000000,"supports_reasoning":True}, separators=(",", ":"))]
        else:
            codex_bundle = (args.codex_bundle or work / "comparison" / f"codex-{args.codex_version}-linux-x64.tar.gz").resolve()
            if codex_bundle.exists():
                command += ["-a", "scripts.agent.harbor.portable_codex:PortableCodex", "--ak", "bundle=" + str(codex_bundle)]
            else:
                command += ["-a", "codex"]
            command += ["--ak", "version=" + args.codex_version,
                        "--ak", "reasoning_effort=" + args.reasoning_effort, "--ak", "web_search=disabled",
                        "--ak", 'config={"model_context_window":1050000,"model_auto_compact_token_limit":900000}']
        for flag in ("--ae", "--ve"):
            for key in ("UV_INDEX_URL", "PIP_INDEX_URL"):
                command += [flag, key + "=" + args.python_index]
            command += [flag, "UV_NATIVE_TLS=true", flag, "UV_HTTP_TIMEOUT=30", flag, "UV_HTTP_RETRIES=5"]
        command += ["--include-task-name", task]
        print("Running:", " ".join(command), flush=True)
        if not args.dry_run:
            phase = "install" if args.install_only else "source"
            # Separate OS processes keep native Codex and adapter environment credentials isolated.
            candidate = {"agent": agent, "dataset": args.dataset, "model": budget["model"],
                "codex_version": args.codex_version, "cancellable_exec": args.cancellable_exec,
                "reasoning_effort": args.reasoning_effort, "resource_pool": capacity, "pricing_ref": budget.get("pricingRef")}
            bundle_identity = (args.bundle or work / "bundle") / "identity.json"
            if agent == "scriptact" and bundle_identity.exists():
                candidate["bundle_identity"] = json.loads(bundle_identity.read_text())
            candidate_id = hashlib.sha256(json.dumps(candidate, sort_keys=True).encode()).hexdigest()
            identity = {"campaignId": prefix, "candidateId": candidate_id, "participantId": agent,
                "taskId": task, "attemptId": hashlib.sha256((prefix + ":" + job_name + ":" + phase).encode()).hexdigest(),
                "jobId": job_name, "phase": phase}
            public_record = work / "campaign/attempts" / (identity["attemptId"] + ".json")
            public_record.parent.mkdir(parents=True, exist_ok=True)
            with public_record.open("x") as stream:
                json.dump({"identity": identity, "candidate": candidate, "command": command, "status": "waiting"}, stream, indent=2)
            if (work / "jobs" / job_name).exists():
                raise FileExistsError("Keep original job evidence: " + job_name)
            demand = task_resources(work / "datasets" / args.dataset.split("@", 1)[0] / task, capacity)
            lease = None
            started = False
            run_environment = None
            receipt = {"identity": identity, "candidate": candidate, "command": command, "status": "waiting"}
            failed = None
            try:
                lease = leases.acquire(identity, demand, args.lease_timeout, cancelled=cancelled)
                receipt.update({"status": "running", "lease": lease})
                public_record.write_text(json.dumps(receipt, indent=2) + "\n")
                run_environment = prepare_attempt_environment(environment, identity, work / "campaign/private-attempts")
                if agent == "codex":
                    run_environment["OPENAI_API_BASE"] = environment["SCRIPTACT_BENCH_BASE_URL"]
                with (work / (job_name + ".log")).open("x") as log:
                    started = True
                    code = run_attempt_process(command, cwd=root, environment=run_environment, log=log, cancelled=cancelled)
                receipt.update({"status": "finished", "exit_code": code})
                if code:
                    raise DispatchError("HARBOR_PROCESS_FAILED", "Harbor returned a nonzero exit code")
                if args.install_only:
                    own = health(run_environment)
                    if own["requests"] or own.get("rejectedRequests", 0):
                        raise DispatchError("INSTALL_MODEL_REQUEST", "Install-only attempted a model request")
            except BaseException as error:
                failed = error
                receipt.update({"status": "failed", "error_code": getattr(error, "code", "DISPATCH_FAILED"), "error": str(error)})
                raise
            finally:
                cleanup_error = None
                try:
                    job = work / "jobs" / job_name
                    if job.is_dir():
                        with (job / "request-identity.json").open("x") as stream:
                            json.dump(identity, stream, indent=2)
                    if started:
                        receipt["attempt_budget_after"] = wait_for_settlement(lambda: health(run_environment), args.settle_timeout)
                        verify_job_containers_stopped(job, environment)
                    if lease:
                        leases.finish(lease, settled=True)
                except BaseException as error:
                    cleanup_error = error
                    receipt.update({"status": "blocked", "cleanup_error_code": getattr(error, "code", "SETTLEMENT_UNKNOWN")})
                    if lease:
                        leases.finish(lease, settled=False, reason=receipt["cleanup_error_code"])
                public_record.write_text(json.dumps(receipt, indent=2) + "\n")
                if cleanup_error and not failed:
                    raise cleanup_error
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(run_one, item) for item in itertools.product(agents, tasks, range(args.attempts))]
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except BaseException as error:
                errors.append(error)
    if errors:
        raise DispatchError("CAMPAIGN_ATTEMPT_FAILED", f"{len(errors)} attempts failed; inspect their retained receipts")


if __name__ == "__main__":
    main()
