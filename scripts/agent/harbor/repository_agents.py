"""Capture repository trials for authoritative verification in a fresh sandbox."""

import asyncio
import hashlib
import json
import re
import shlex
from pathlib import Path

from .agent import ScriptActAgent
from .portable_codex import PortableCodex
from .portable_claude_code import PortableClaudeCode
from harbor.agents.terminus_2.terminus_2 import Terminus2


def baseline_command(repo, base):
    """Snapshot the actual initial files, preserving HEAD, index and working tree."""
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", base):
        raise ValueError("Invalid repository base commit")
    return f"""
set -eu
cd {shlex.quote(repo)}
baseline_index=$(mktemp "$(git rev-parse --absolute-git-dir)/harbor-baseline-index.XXXXXX")
trap 'rm -f "$baseline_index" "$baseline_index.lock"' EXIT
rm "$baseline_index"
export GIT_INDEX_FILE="$baseline_index"
git read-tree {base}
git -c core.hooksPath=/dev/null add -A
git write-tree
"""


def patch_command(repo, base, destination):
    """Capture changes from a base tree or commit without changing the working index."""
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", base):
        raise ValueError("Invalid repository base commit")
    return f"""
set -eu
cd {shlex.quote(repo)}
patch_index=$(mktemp "$(git rev-parse --absolute-git-dir)/harbor-patch-index.XXXXXX")
trap 'rm -f "$patch_index" "$patch_index.lock"' EXIT
rm "$patch_index"
export GIT_INDEX_FILE="$patch_index"
git read-tree {base}
git -c core.hooksPath=/dev/null add -A
git -c core.hooksPath=/dev/null diff --cached --binary {base} -- > {shlex.quote(destination)}
wc -c < {shlex.quote(destination)}
"""


class RepositoryTrial:
    """Reserve the final minute for patch capture while retaining each agent's native loop."""

    async def exec_as_agent(self, environment, command, **kwargs):
        if "codex exec" in command or "/opt/velaros-scriptact/run.mjs" in command or "claude " in command:
            budget = int(getattr(self, "_timeout_sec", None) or 3000)
            if budget <= 60:
                raise ValueError("Repository trials require more than 60 seconds")
            command = f"timeout -k 15 {budget - 60} bash -o pipefail -c {shlex.quote(command)}"
        return await super().exec_as_agent(environment, command=command, **kwargs)

    async def run(self, instruction, environment, context):
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        inspection = await environment.exec(command=r"""
set -eu
test -e /.dockerenv
for candidate in "$PWD" /app /testbed; do
  if repo=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null); then break; fi
done
test -n "$repo"
cd "$repo"
printf '%s\n' "$repo" "$(git rev-parse HEAD)"
""", user="root", timeout_sec=30)
        if inspection.return_code:
            raise RuntimeError("Repository trial requires a Git checkout inside its Docker sandbox")
        lines = (inspection.stdout or "").strip().splitlines()
        if len(lines) != 2:
            raise RuntimeError("Cannot identify the repository base for patch replay")
        repo, base = lines
        snapshot = await environment.exec(command=baseline_command(repo, base),
                                          user="root", timeout_sec=30)
        base_tree = (snapshot.stdout or "").strip()
        if snapshot.return_code or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", base_tree):
            raise RuntimeError("Repository initial-state snapshot failed before agent execution")
        remote_patch = str(self.environment_logs_dir / "model.patch")
        capture = {"repository": repo, "base_commit": base, "base_tree": base_tree,
                   "baseline": "initial working tree captured with a temporary Git index",
                   "patch": remote_patch,
                   "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   "agent_budget_seconds": int(getattr(self, "_timeout_sec", None) or 3000) - 60,
                   "status": "pending"}
        evidence = self.logs_dir / "patch-capture.json"
        evidence.write_text(json.dumps(capture, indent=2) + "\n")
        try:
            # Also bound host-driven agents such as Terminus; cancellation reaches
            # container commands through the shared CancellableBenchmarkDocker.
            if capture["agent_budget_seconds"] <= 0:
                raise ValueError("Repository trials require more than 60 seconds")
            async with asyncio.timeout(capture["agent_budget_seconds"]):
                await super().run(instruction, environment, context)
        finally:
            try:
                result = await environment.exec(command=patch_command(repo, base_tree, remote_patch),
                                                user="root", timeout_sec=40)
                if result.return_code:
                    raise RuntimeError("Git patch capture failed with exit code " + str(result.return_code))
                capture.update({"status": "captured", "bytes": int((result.stdout or "").strip())})
            except Exception as error:
                capture.update({"status": "failed", "error_type": type(error).__name__, "error": str(error)})
                self.logger.warning("Repository patch capture failed: %s", error)
            finally:
                evidence.write_text(json.dumps(capture, indent=2) + "\n")

    def populate_context_post_run(self, context):
        super().populate_context_post_run(context)
        evidence = self.logs_dir / "patch-capture.json"
        if evidence.exists():
            context.metadata = {**(context.metadata or {}), "repository_patch": json.loads(evidence.read_text())}


class RepositoryScriptAct(RepositoryTrial, ScriptActAgent):
    @staticmethod
    def name():
        return "scriptact-repository"


class RepositoryCodex(RepositoryTrial, PortableCodex):
    @staticmethod
    def name():
        return "codex-repository"


class RepositoryClaudeCode(RepositoryTrial, PortableClaudeCode):
    @staticmethod
    def name():
        return "claude-code-bridge-repository"


class RepositoryTerminus(RepositoryTrial, Terminus2):
    @staticmethod
    def name():
        return "terminus-2-repository"
