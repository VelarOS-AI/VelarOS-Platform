"""A task must be fully materialized and frozen before starting any agent."""

import subprocess
import tempfile
import unittest
from pathlib import Path

from repository_launch import command_for, digest, validate_task_files


class RepositoryLaunchTests(unittest.TestCase):
    def test_shared_compatibility_environment_reaches_source_and_fresh_verifier(self):
        row = {"source_job": "source", "replay_job": "replay"}
        participant = {"agent": "fixture", "kwargs": {}}
        for replay, install_only in [(False, False), (True, False), (False, True)]:
            _, command = command_for(row, participant, Path("fixture"), replay=replay,
                install_only=install_only, execution_env={"GODEBUG": "cpu.avx2=off"})
            for flag in ["--ae", "--ve"]:
                self.assertIn((flag, "GODEBUG=cpu.avx2=off"), list(zip(command, command[1:])))

    def test_shared_environment_cannot_silently_differ_by_participant(self):
        row = {"source_job": "source", "replay_job": "replay"}
        participant = {"agent": "fixture", "kwargs": {}, "environment": {"GODEBUG": "cpu.avx2=on"}}
        with self.assertRaisesRegex(ValueError, "conflicts"):
            command_for(row, participant, Path("fixture"), execution_env={"GODEBUG": "cpu.avx2=off"})
        for values in [[], False, {"GODEBUG": False}, {"bad=key": "value"}, {"GODEBUG": "value\0"}]:
            with self.assertRaisesRegex(ValueError, "valid string entries"):
                command_for(row, {"agent": "fixture", "kwargs": {}}, Path("fixture"), execution_env=values)

    def fixture(self, root):
        task = root / "v2/tasks/example"
        names = ["instruction.md", "task.toml", "environment/Dockerfile", "tests/test.sh", "tests/parser.py"]
        for name in names:
            path = task / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic fixture: " + name + "\n")
        for args in (("init", "-q"), ("add", "."),
                     ("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "fixture")):
            subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
        return task, {name: digest(task / name) for name in names}

    def test_metadata_only_manifest_and_unfrozen_official_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task, expected = self.fixture(root)
            with self.assertRaisesRegex(ValueError, "manifest is incomplete"):
                validate_task_files(task, {name: expected[name] for name in ("task.toml", "environment/Dockerfile")}, root)
            with self.assertRaisesRegex(ValueError, "file set differs"):
                validate_task_files(task, {k: v for k, v in expected.items() if k != "tests/parser.py"}, root)

    def test_missing_sparse_checkout_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task, expected = self.fixture(root)
            (task / "instruction.md").unlink()
            with self.assertRaisesRegex(ValueError, "checkout is incomplete: instruction.md"):
                validate_task_files(task, expected, root)

    def test_complete_identity_passes_and_modified_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task, expected = self.fixture(root)
            validate_task_files(task, expected, root)
            (task / "tests/parser.py").write_text("changed")
            with self.assertRaisesRegex(ValueError, "Official task file changed: tests/parser.py"):
                validate_task_files(task, expected, root)


if __name__ == "__main__":
    unittest.main()
