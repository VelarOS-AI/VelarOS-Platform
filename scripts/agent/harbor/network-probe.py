"""Exercise Harbor's actual phase policies without model calls or task solutions."""

import asyncio
import argparse
import datetime
import hashlib
import http.server
import json
import logging
import os
import shlex
import subprocess
import sys
import threading
import tomllib
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
from harbor.models.trial.paths import TrialPaths
from scripts.agent.harbor.repository_environment import HELPER, RepositoryBenchmarkDocker, helper_evidence


class MarkerServer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"scriptact-network-probe\n"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


async def probe(helper_directory=HELPER):
    bench = ROOT / ".velaros-workspace/bench"
    os.environ["DOCKER_HOST"] = "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock")
    os.environ["DOCKER_CONFIG"] = str(bench / "docker-config")
    os.environ["SCRIPTACT_BENCH_TOKEN_FILE"] = str(bench / "campaign/gateway-token")
    if subprocess.check_output(["docker", "ps", "--quiet"], text=True).strip():
        raise RuntimeError("Run this resource probe between paid trials")
    helper_directory = helper_directory.resolve()
    helper = helper_evidence(helper_directory)
    environment_type = type("NetworkProbeDocker", (RepositoryBenchmarkDocker,), {
        "_EGRESS_CONTROL_SIDECAR_CONTEXT_PATH": helper_directory / "context",
        "_EGRESS_CONTROL_SIDECAR_DOCKER_NAME": helper["image_name"].split("--")[0],
        "_EGRESS_CONTROL_KERNEL_PROBE_IMAGE": helper["image_name"],
    })
    name = "scriptact-network-probe-" + uuid.uuid4().hex[:12]
    directory = bench / "probes" / name
    paths = TrialPaths(directory)
    paths.mkdir()
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    handler = logging.FileHandler(directory / "probe.log")
    logger.addHandler(handler)
    task = bench / "datasets/terminal-bench-sample/configure-git-webserver"
    config = EnvironmentConfig.model_validate(tomllib.loads((task / "task.toml").read_text())["environment"])
    public = NetworkPolicy(network_mode=NetworkMode.PUBLIC)
    deny = NetworkPolicy(network_mode=NetworkMode.NO_NETWORK)
    agent = NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=["host.docker.internal"])
    environment = environment_type(environment_dir=task / "environment", environment_name=name,
        session_id=name, trial_paths=paths, task_env_config=config, logger=logger,
        network_policy=public, phase_network_policies=[agent, deny])
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), MarkerServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_port
    result = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "helper_image": helper["image_id"],
        "helper_preparation_sha256": helper["preparation_sha256"], "helper_directory": str(helper_directory),
        "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "environment_source_sha256": hashlib.sha256((ROOT / "scripts/agent/harbor/repository_environment.py").read_bytes()).hexdigest(),
        "task_image": config.docker_image, "model_calls": 0, "phases": {}, "unexpected_phases": [], "status": "running"}
    async def fetch(target, extra=""):
        command = "curl --noproxy '*' --silent --show-error --connect-timeout 2 --max-time 4 -w '\\nHTTP=%{http_code}\\n' " + extra + " " + shlex.quote(target)
        response = await environment.exec(command=command, timeout_sec=8)
        return {"return_code": response.return_code, "stdout": response.stdout, "stderr": response.stderr}
    try:
        await environment.start(force_build=False)
        resolution = await environment.exec(command="getent ahostsv4 host.docker.internal", timeout_sec=10)
        if resolution.return_code or not resolution.stdout:
            raise RuntimeError("Host gateway is not resolvable from the actual Harbor task container")
        address = resolution.stdout.split()[0]
        marker = f"http://host.docker.internal:{port}/"
        blocked = f"http://blocked.scriptact.test:{port}/"
        blocked_args = "--resolve " + shlex.quote(f"blocked.scriptact.test:{port}:{address}")
        for label, policy in (("setup_public", public), ("agent_allowlist", agent), ("deny_all", deny), ("verifier_public", public)):
            await environment.set_network_policy(policy)
            phase = {"policy": policy.model_dump(mode="json"), "gateway": await fetch("http://host.docker.internal:48761/health"),
                "allowed_marker": await fetch(marker), "blocked_marker": await fetch(blocked, blocked_args)}
            result["phases"][label] = phase
            allowed = "scriptact-network-probe" in (phase["allowed_marker"]["stdout"] or "")
            denied_target_reachable = "scriptact-network-probe" in (phase["blocked_marker"]["stdout"] or "")
            gateway = "HTTP=401" in (phase["gateway"]["stdout"] or "")
            if (allowed, denied_target_reachable, gateway) != {
                    "setup_public": (True, True, True), "agent_allowlist": (True, False, True),
                    "deny_all": (False, False, False), "verifier_public": (True, True, True)}[label]:
                result["unexpected_phases"].append(label)
                diagnostics = {}
                for command, arguments in (("policy", ["exec", "--no-TTY", environment._EGRESS_CONTROL_SERVICE_NAME, "network-policy", "show"]),
                        ("rules", ["exec", "--no-TTY", environment._EGRESS_CONTROL_SERVICE_NAME, "network-policy", "rules"]),
                        ("proxy_logs", ["logs", "--no-color", "--tail", "100", environment._EGRESS_CONTROL_SERVICE_NAME])):
                    response = await environment._run_docker_compose_command(arguments, check=False, timeout_sec=10)
                    diagnostics[command] = {"return_code": response.return_code, "stdout": response.stdout, "stderr": response.stderr}
                phase["diagnostics"] = diagnostics
        if result["unexpected_phases"]:
            raise AssertionError("Unexpected network behavior during " + ", ".join(result["unexpected_phases"]))
        result["status"] = "passed"
    except BaseException as error:
        result.update({"status": "failed", "error_type": type(error).__name__, "error": str(error)})
        raise
    finally:
        try:
            await environment.stop(delete=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            result["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            (directory / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            handler.close()
            logger.removeHandler(handler)
            print(json.dumps({"result": str(directory / "result.json"), "status": result["status"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper-directory", type=Path, default=HELPER)
    asyncio.run(probe(parser.parse_args().helper_directory))
