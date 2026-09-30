"""Run public Harbor tasks with a shared, bounded GPT-6 Sol campaign gateway."""

import argparse
import datetime
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path


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
    args = parser.parse_args()
    if not 1 <= args.attempts <= 5:
        parser.error("--attempts must be between 1 and 5")
    if args.job_name and args.agent in ("pair", "all"):
        parser.error("--job-name requires a single agent")
    root = Path(__file__).resolve().parents[3]
    work = root / ".velaros-workspace/bench"
    token_path = work / "campaign/gateway-token"
    token = token_path.read_text().strip()
    endpoint = "http://127.0.0.1:48761"
    request = urllib.request.Request(endpoint + "/health", headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(request, timeout=5) as response:
        budget = json.load(response)
    if budget.get("model") != "gpt-6-sol" or budget["limitUsd"] > 1000 or budget["committedUpperUsd"] + 20 > budget["limitUsd"]:
        raise RuntimeError("Campaign budget is unavailable or exhausted")
    print("Campaign budget:", json.dumps(budget), flush=True)
    environment = dict(os.environ)
    environment.update({
        "HARBOR_TELEMETRY": "0",
        "DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(work / "docker-config"),
        "PYTHONPATH": str(root),
        "SCRIPTACT_BENCH_BASE_URL": "http://host.docker.internal:48761/v1",
        "SCRIPTACT_BENCH_TOKEN_FILE": str(token_path),
        "OPENAI_API_KEY": token,
        "OPENAI_API_BASE": endpoint + "/v1",
        "OPENAI_BASE_URL": endpoint + "/v1",
    })
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
    for agent in agents:
        command = [str(work / "venv/bin/harbor"), "run", "-d", args.dataset,
                   "-m", "openai/gpt-6-sol", "-n", "1", "-k", str(args.attempts),
                   "-e", "scripts.agent.harbor.cancellable_environment:CancellableBenchmarkDocker" if args.cancellable_exec else "scripts.agent.harbor.environment:BenchmarkDocker",
                   "--max-retries", "0", "-o", str(work / "jobs"), "--job-name", args.job_name or prefix + "-" + agent]
        if args.install_only:
            command.append("--install-only")
        if agent == "scriptact":
            command += ["-a", "scripts.agent.harbor.agent:ScriptActAgent", "--ak", "bundle=" + str((args.bundle or work / "bundle").resolve())]
        elif agent == "terminus-2":
            command += ["-a", "terminus-2", "--ak", "api_base=" + endpoint + "/v1", "--ak", "reasoning_effort=high", "--ak", "use_responses_api=false", "--ak", 'model_info={"max_input_tokens":922000,"max_output_tokens":32768,"max_tokens":1050000,"input_cost_per_token":0.000002,"output_cost_per_token":0.00001,"cache_read_input_token_cost":0.0000002,"cache_creation_input_token_cost":0.0000025,"supports_reasoning":true}']
        else:
            codex_bundle = (args.codex_bundle or work / "comparison" / f"codex-{args.codex_version}-linux-x64.tar.gz").resolve()
            if codex_bundle.exists():
                command += ["-a", "scripts.agent.harbor.portable_codex:PortableCodex", "--ak", "bundle=" + str(codex_bundle)]
            else:
                command += ["-a", "codex"]
            command += ["--ak", "version=" + args.codex_version,
                        "--ak", "reasoning_effort=high", "--ak", "web_search=disabled",
                        "--ak", 'config={"model_context_window":1050000,"model_auto_compact_token_limit":900000}']
        for flag in ("--ae", "--ve"):
            for key in ("UV_INDEX_URL", "PIP_INDEX_URL"):
                command += [flag, key + "=" + args.python_index]
            command += [flag, "UV_NATIVE_TLS=true", flag, "UV_HTTP_TIMEOUT=30", flag, "UV_HTTP_RETRIES=5"]
        for task in args.task:
            command += ["--include-task-name", task]
        print("Running:", " ".join(command), flush=True)
        if not args.dry_run:
            run_environment = dict(environment)
            if agent == "codex":
                run_environment.pop("CODEX_AUTH_JSON_PATH", None)
                run_environment.pop("CODEX_FORCE_AUTH_JSON", None)
                run_environment.update({"OPENAI_BASE_URL": "http://host.docker.internal:48761/v1", "OPENAI_API_BASE": "http://host.docker.internal:48761/v1"})
            result = subprocess.run(command, cwd=root, env=run_environment, check=False)
            if result.returncode:
                raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
