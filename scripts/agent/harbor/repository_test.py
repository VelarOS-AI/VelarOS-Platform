"""Verify patch transport with real repositories, including commits and binary changes."""

import os
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from scripts.agent.harbor.repository_agents import RepositoryTrial, patch_command


class RepositoryExitTests(unittest.IsolatedAsyncioTestCase):
    async def pipeline(self, exit_code):
        with tempfile.TemporaryDirectory(prefix="harbor-exit-") as directory:
            root = Path(directory)
            # The fixture skips elapsed time, while executing the actual nested Bash
            # and tee pipeline used by the installed-agent boundary.
            (root / "timeout").write_text('#!/bin/sh\nshift 3\nexec "$@"\n')
            (root / "codex").write_text(f"#!/bin/sh\nprintf 'fixture output\\n'\nexit {exit_code}\n")
            for name in ("timeout", "codex"):
                (root / name).chmod(0o755)
            environment = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"]}
            class CommandHarness:
                async def exec_as_agent(self, environment, command, **kwargs):
                    return subprocess.run(["bash", "-c", "set -o pipefail; " + command],
                                          cwd=root, capture_output=True, text=True, timeout=5, **kwargs)
            class Agent(RepositoryTrial, CommandHarness):
                _timeout_sec = 120
            result = await Agent().exec_as_agent(None, "codex exec --json | tee captured.txt", env=environment)
            self.assertEqual((root / "captured.txt").read_text(), "fixture output\n")
            return result.returncode

    async def test_native_failure_survives_timeout_and_tee(self):
        self.assertEqual(await self.pipeline(7), 7)

    async def test_successful_pipeline_remains_successful(self):
        self.assertEqual(await self.pipeline(0), 0)


class RepositoryTests(unittest.TestCase):
    def test_capture_replays_committed_untracked_binary_and_deleted_files_without_touching_index(self):
        with tempfile.TemporaryDirectory(prefix="harbor-repository-") as directory:
            root = Path(directory)
            repo = root / "agent repo"
            repo.mkdir()
            def git(*args, cwd=repo):
                return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@localhost")
            (repo / "source.txt").write_text("before\n")
            (repo / "removed.txt").write_text("remove me\n")
            (repo / "binary.dat").write_bytes(b"\x00\x01before")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            replay = root / "fresh"
            git("clone", "-q", str(repo), str(replay))
            (repo / "source.txt").write_text("committed agent change\n")
            git("add", "source.txt")
            git("commit", "-qm", "agent commit")
            (repo / "removed.txt").unlink()
            (repo / "binary.dat").write_bytes(b"\x00\xffafter")
            (repo / "new file.txt").write_text("new untracked content\n")
            git("add", "binary.dat")
            index_before = (repo / ".git/index").read_bytes()
            patch = root / "model.patch"
            subprocess.run(["bash", "-c", patch_command(str(repo), base, str(patch))], check=True, capture_output=True)
            self.assertEqual((repo / ".git/index").read_bytes(), index_before)
            git("apply", "--check", str(patch), cwd=replay)
            git("apply", str(patch), cwd=replay)
            for name in ("source.txt", "binary.dat", "new file.txt"):
                self.assertEqual((replay / name).read_bytes(), (repo / name).read_bytes())
            self.assertFalse((replay / "removed.txt").exists())
            self.assertFalse(list((repo / ".git").glob("harbor-patch-index.*")))

    def test_invalid_base_is_rejected_before_building_a_command(self):
        with self.assertRaises(ValueError):
            patch_command("/app", "HEAD; unexpected-command", "/logs/agent/model.patch")


class RepositoryInitialStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_initial_tracked_and_untracked_state_is_preserved_and_only_agent_changes_replay(self):
        with tempfile.TemporaryDirectory(prefix="harbor-initial-state-") as directory:
            root = Path(directory)
            repo = root / "agent repo"
            repo.mkdir()
            def git(*args, cwd=repo):
                return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@localhost")
            (repo / "source.txt").write_text("committed source\n")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (repo / "source.txt").write_text("existing staged source\n")
            git("add", "source.txt")
            (repo / "source.txt").write_text("existing working source\n")
            (repo / "starter.txt").write_text("existing untracked starter\n")
            (repo / "state.bin").write_bytes(b"\x00initial binary")
            (repo / "appendonlydir").mkdir()
            (repo / "appendonlydir/data.rdb").write_bytes(b"\x00untouched image data")
            index_before = (repo / ".git/index").read_bytes()
            replay = root / "fresh"
            shutil.copytree(repo, replay)
            calls = []
            testcase = self
            class Environment:
                async def exec(self, command, **kwargs):
                    # Only the disposable-container marker is replaced in this
                    # host fixture; repository and index commands run unchanged.
                    command = command.replace("test -e /.dockerenv", ":")
                    result = subprocess.run(["bash", "-c", command], cwd=repo,
                        text=True, capture_output=True, timeout=10)
                    return SimpleNamespace(return_code=result.returncode,
                                           stdout=result.stdout, stderr=result.stderr)
            class NativeAgent:
                async def run(self, instruction, environment, context):
                    calls.append(instruction)
                    testcase.assertEqual(git("rev-parse", "HEAD"), base)
                    testcase.assertEqual((repo / ".git/index").read_bytes(), index_before)
                    testcase.assertEqual((repo / "source.txt").read_text(), "existing working source\n")
                    testcase.assertEqual((repo / "starter.txt").read_text(), "existing untracked starter\n")
                    testcase.assertEqual((repo / "state.bin").read_bytes(), b"\x00initial binary")
                    (repo / "source.txt").write_text("agent source change\n")
                    (repo / "starter.txt").unlink()
                    (repo / "state.bin").write_bytes(b"\x00agent binary change")
                    (repo / "new file.txt").write_text("agent new file\n")
            class Agent(RepositoryTrial, NativeAgent):
                _timeout_sec = 120
                logs_dir = root / "logs"
                environment_logs_dir = logs_dir
                logger = SimpleNamespace(warning=lambda *args: None)
            await Agent().run("fixture instruction", Environment(), SimpleNamespace())
            self.assertEqual(calls, ["fixture instruction"])
            self.assertEqual((repo / ".git/index").read_bytes(), index_before)
            self.assertEqual(git("rev-parse", "HEAD"), base)
            capture = json.loads((root / "logs/patch-capture.json").read_text())
            self.assertEqual(capture["base_commit"], base)
            self.assertNotEqual(capture["base_tree"], git("rev-parse", base + "^{tree}"))
            patch = root / "logs/model.patch"
            self.assertNotIn("appendonlydir", patch.read_text())
            git("apply", "--check", str(patch), cwd=replay)
            git("apply", str(patch), cwd=replay)
            for name in ("source.txt", "state.bin", "new file.txt", "appendonlydir/data.rdb"):
                self.assertEqual((replay / name).read_bytes(), (repo / name).read_bytes())
            self.assertFalse((replay / "starter.txt").exists())
            self.assertFalse(list((repo / ".git").glob("harbor-*-index.*")))


if __name__ == "__main__":
    unittest.main()
