"""Fresh-sandbox patch replay through Harbor and the pinned official replay agent.

The repositories and verifier below are synthetic fixtures. No benchmark solution
or paid model is involved; the source run intentionally fails after making edits.
"""

import datetime
import hashlib
import json
import os
import subprocess
import sys
import tomllib
import urllib.request
import uuid
from pathlib import Path

from harbor.agents.base import BaseAgent
from scripts.agent.harbor.repository_agents import RepositoryTrial
from scripts.agent.harbor.repository_environment import RepositoryBenchmarkDocker, helper_evidence

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / ".velaros-workspace/bench"
DATASET = BENCH / "datasets/swebench-pro-v2"
TASK = "instance_patch_transport"
BASELINE = r"""
set -eu
test -e /.dockerenv
command -v git >/dev/null
command -v patch >/dev/null
cd /app
test -z "$(ls -A)"
git init -q
git config user.name Fixture
git config user.email fixture@localhost
git config commit.gpgsign false
printf 'before\n' > source.txt
printf 'remove me\n' > removed.txt
printf '\000\001before' > binary.dat
git add source.txt removed.txt binary.dat
GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git commit -qm base
printf '%s\n' "$(hostname)" "$(git rev-parse HEAD)" > /logs/agent/probe-baseline.txt
"""


class RepositoryProbeDocker(RepositoryBenchmarkDocker):
    async def start(self, force_build):
        await super().start(force_build)
        result = await self.exec(command=BASELINE, user="root", timeout_sec=180)
        if result.return_code:
            raise RuntimeError("Synthetic repository setup failed")


class MutationAgent(BaseAgent):
    @staticmethod
    def name():
        return "synthetic-repository-mutation"

    def version(self):
        return "1"

    async def setup(self, environment):
        pass

    async def run(self, instruction, environment, context):
        result = await environment.exec(command=r"""
set -eu
cd /app
printf 'committed agent change\n' > source.txt
git add source.txt
git commit -qm 'fixture agent commit'
printf '\000\377after' > binary.dat
git add binary.dat
printf 'new untracked content\n' > 'new file.txt'
rm removed.txt
printf 'outside repository\n' > /tmp/patch-probe-outside
sha256sum .git/index > /logs/agent/index-before.txt
""", timeout_sec=20)
        if result.return_code:
            raise RuntimeError("Synthetic mutation failed")
        await environment.exec(command="sleep 60", timeout_sec=90)
        raise RuntimeError("Expected the repository deadline to cancel the command")


class CaptureProbeAgent(RepositoryTrial, MutationAgent):
    _timeout_sec = 65

    async def run(self, instruction, environment, context):
        try:
            await super().run(instruction, environment, context)
        finally:
            result = await environment.exec(command="cd /app && sha256sum .git/index > /logs/agent/index-after.txt", timeout_sec=10)
            if result.return_code:
                raise RuntimeError("Cannot verify the original index after capture")


def main():
    token = (BENCH / "campaign/gateway-token").read_text().strip()
    def health():
        request = urllib.request.Request("http://127.0.0.1:48761/health", headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR")}
    env.update({"DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(BENCH / "docker-config"), "PYTHONPATH": str(ROOT) + os.pathsep + str(DATASET / "v2/tooling"),
        "HARBOR_TELEMETRY": "0", "SCRIPTACT_BENCH_TOKEN_FILE": str(BENCH / "campaign/gateway-token")})
    before = health()
    if before["activeUpstreamRequests"] or subprocess.check_output(["docker", "ps", "--quiet"], env=env, text=True).strip():
        raise RuntimeError("Run repository fixtures between paid trials on the empty dedicated VM")
    revision = subprocess.check_output(["git", "-C", str(DATASET), "rev-parse", "HEAD"], text=True).strip()
    if revision != "66f92766bba642462d4bbe5479e83f91f9211862":
        raise RuntimeError("Official replay source revision changed")
    replay_source = DATASET / "v2/tooling/patch_replay.py"
    original = subprocess.check_output(["git", "-C", str(DATASET), "show", "HEAD:v2/tooling/patch_replay.py"])
    if replay_source.read_bytes() != original:
        raise RuntimeError("Official replay source was modified")
    name = "repository-probe-" + uuid.uuid4().hex[:12]
    directory = BENCH / "probes" / name
    task = directory / "tasks" / TASK
    (task / "environment").mkdir(parents=True)
    (task / "tests").mkdir()
    image = tomllib.loads((BENCH / "datasets/terminal-bench-sample/build-cython-ext/task.toml").read_text())["environment"]["docker_image"]
    image_info = json.loads(subprocess.check_output(["docker", "image", "inspect", image], env=env, text=True))[0]
    assert image_info["Architecture"] == "amd64" and image_info["Os"] == "linux"
    (task / "task.toml").write_text(f'''version = "1.0"
[metadata]
category = "fixture"
difficulty = "easy"
[agent]
timeout_sec = 120.0
network_mode = "no-network"
[verifier]
timeout_sec = 30.0
[environment]
docker_image = "{image}"
build_timeout_sec = 240.0
''')
    (task / "instruction.md").write_text("Exercise synthetic patch transport. No model is called.\n")
    binary_sha = hashlib.sha256(b"\x00\xffafter").hexdigest()
    (task / "tests/test.sh").write_text(f'''#!/bin/bash
set -eu
mkdir -p /logs/verifier
printf '0\n' > /logs/verifier/reward.txt
cd /app
test "$(cat source.txt)" = "committed agent change"
test "$(cat 'new file.txt')" = "new untracked content"
test ! -e removed.txt
test "$(sha256sum binary.dat | cut -d' ' -f1)" = "{binary_sha}"
test ! -e /tmp/patch-probe-outside
printf '1\n' > /logs/verifier/reward.txt
''')
    evidence = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "running",
        "model_calls": 0, "gateway_requests_before": before["requests"], "source_revision": revision,
        "official_replay_sha256": hashlib.sha256(original).hexdigest(), "task_image": image, "task_image_id": image_info["Id"],
        "network_helper": helper_evidence(), "cases": {}, "source_sha256": {
            path: hashlib.sha256((ROOT / "scripts/agent/harbor" / path).read_bytes()).hexdigest()
            for path in ("repository_probe.py", "repository_agents.py", "repository_environment.py")}}

    def run(label, agent, source_job=None, capture=False):
        job = name + "-" + label
        command = [str(BENCH / "venv/bin/harbor"), "run", "--path", str(task), "--job-name", job,
            "--jobs-dir", str(directory / "jobs"), "--max-retries", "0", "-n", "1", "-k", "1",
            "-e", "scripts.agent.harbor.repository_probe:RepositoryProbeDocker", "-a", agent, "-m", "fixture",
            "--allow-agent-host", "host.docker.internal"]
        if capture:
            command.append("--disable-verification")
        if source_job:
            command += ["--ak", "source_job=" + str(source_job)]
        with (directory / (label + ".log")).open("x") as log:
            completed = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=600)
        results = list((directory / "jobs" / job).glob("*/result.json"))
        if completed.returncode or len(results) != 1:
            raise RuntimeError("Fixture job did not produce exactly one trial: " + label)
        result = json.loads(results[0].read_text())
        evidence["cases"][label] = {"result": str(results[0]),
            "reward": (result.get("verifier_result") or {}).get("rewards", {}).get("reward"),
            "exception_type": (result.get("exception_info") or {}).get("exception_type")}
        return results[0].parent, result

    try:
        source_trial, source_result = run("capture", "scripts.agent.harbor.repository_probe:CaptureProbeAgent", capture=True)
        capture = json.loads((source_trial / "agent/patch-capture.json").read_text())
        evidence["capture"] = capture
        assert capture["status"] == "captured" and capture["bytes"] > 0
        exception = source_result.get("exception_info") or {}
        assert exception.get("exception_type") == "AgentTimeoutError"
        traceback = exception.get("exception_traceback", "")
        assert 'asyncio.timeout(capture["agent_budget_seconds"])' in traceback
        assert "repository_agents.py" in traceback and "asyncio.exceptions.CancelledError" in traceback
        execution = source_result["agent_execution"]
        elapsed = (datetime.datetime.fromisoformat(execution["finished_at"]) -
                   datetime.datetime.fromisoformat(execution["started_at"])).total_seconds()
        assert capture["agent_budget_seconds"] == 5 and 5 <= elapsed < 30
        evidence["capture_execution_seconds"] = elapsed
        assert source_result.get("verifier_result") is None
        assert (source_trial / "agent/index-before.txt").read_bytes() == (source_trial / "agent/index-after.txt").read_bytes()
        baselines = [(source_trial / "agent/probe-baseline.txt").read_text().splitlines()]
        for label, expected in (("valid", 1), ("empty", 0), ("malformed", 0)):
            source = source_trial.parent
            if label != "valid":
                source = directory / (label + "-source")
                trial = source / (TASK + "__fixture")
                (trial / "agent").mkdir(parents=True)
                (trial / "result.json").write_text(json.dumps({"task_name": TASK}))
                (trial / "agent/model.patch").write_text("" if label == "empty" else "not a valid patch\n")
            trial, result = run(label, "patch_replay:PatchReplayAgent", source_job=source)
            case = evidence["cases"][label]
            case["replay"] = json.loads((trial / "agent/replay.json").read_text())
            assert case["reward"] == expected and not case["exception_type"], label
            if label == "valid":
                assert case["replay"]["apply_rc"] == 0
            elif label == "malformed":
                assert case["replay"]["apply_rc"] != 0
            baselines.append((trial / "agent/probe-baseline.txt").read_text().splitlines())
        assert len({row[0] for row in baselines}) == 4, "Each phase must use a fresh container"
        assert len({row[1] for row in baselines}) == 1, "All fixture repositories must share the same clean base"
        evidence["baselines"] = baselines
        assert health()["requests"] == before["requests"], "Unexpected paid request during fixture"
        evidence["status"] = "passed"
    except BaseException as error:
        evidence.update({"status": "failed", "error_type": type(error).__name__, "error": str(error)})
        raise
    finally:
        evidence.update({"finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "gateway_requests_after": health()["requests"]})
        (directory / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps({"evidence": str(directory / "result.json"), "status": evidence["status"]}))


if __name__ == "__main__":
    main()
