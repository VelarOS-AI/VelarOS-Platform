"""A task must be fully materialized and frozen before starting any agent."""

import contextlib
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from repository_launch import command_for, digest, guard_idle, main, validate_task_files
from resource_leases import DispatchError, ResourceLeases
from worker_admission import admission_session, scope_for, member_identity
from worker_admission_test import passed_probe


class RepositoryLaunchTests(unittest.TestCase):
    @contextlib.contextmanager
    def gateway_fixture(self, *, health_states, frozen_upstream=True):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            bench = Path(directory)
            task = bench / "task"
            task.mkdir()
            (task / "task.toml").write_text('[environment]\ncpus=1\nmemory_mb=4096\n')
            base = "https://fixture.invalid/v1"
            upstream = {"baseURL": base, "endpointId": hashlib.sha256(base.encode()).hexdigest()}
            gateway = {"url": "http://127.0.0.1:48763", "budget_mode": "unlimited"}
            if frozen_upstream:
                gateway["upstream"] = upstream
            participant = {"agent": "fixture", "model": "openai/fixture-model", "kwargs": {"reasoning_effort": "high"}}
            manifest = {"model": "fixture-model", "reasoning_effort": "high", "gateway": gateway,
                "participants": {"fixture": participant}, "vm": {"profile": "scriptact-bench", "cpus": 2, "memory_bytes": 8192 * 1024 ** 2},
                "resource_pool": {"max_active_attempts": 2, "cpus": 2, "memory_mb": 8192},
                "attempts": [{"task": "task", "participant": "fixture", "source_job": "source", "replay_job": "replay"}]}
            path = bench / "manifest.json"
            path.write_text(json.dumps(manifest))
            ready = {"attribution": "signed-attempt-v1", "model": "fixture-model", "reasoningEffort": "high",
                "budgetMode": "unlimited", "limitUsd": None, "upstream": upstream, "authenticationBlocker": None,
                "activeUpstreamRequests": 0, "scheduler": {"queued": 0}, "requests": 0}
            states = iter(health_states)
            def health(env):
                # Cleanup sees the blocker too, and must still settle and release.
                if env.get("attempt"):
                    return {**ready, "authenticationBlocker": {"code": "UPSTREAM_AUTHENTICATION_BLOCKED"}}
                change = next(states)
                if isinstance(change, BaseException):
                    raise change
                return {**ready, **change}
            def run(command, **_kwargs):
                job = command[command.index("--job-name") + 1]
                job_dir = bench / "jobs" / job
                trial = job_dir / "trial"
                trial.mkdir(parents=True)
                (job_dir / "result.json").write_text('{}')
                (trial / "result.json").write_text(json.dumps({"agent_setup": {"finished_at": "synthetic"}, "exception_info": None}))
                return 0
            stack.enter_context(patch("sys.argv", ["repository_launch.py", "--manifest", str(path), "--attempt", "1"]))
            stack.enter_context(patch("repository_launch.BENCH", bench))
            stack.enter_context(patch("repository_launch.environment", return_value={"DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock")}))
            probe = stack.enter_context(patch("worker_admission.disk_admission.probe", side_effect=passed_probe))
            stack.enter_context(patch("repository_launch.validate", return_value=(task, participant)))
            stack.enter_context(patch("repository_launch.signal.signal"))
            stack.enter_context(patch("repository_launch.health", side_effect=health))
            credentials = stack.enter_context(patch("repository_launch.prepare_attempt_environment", return_value={"attempt": True}))
            launched = stack.enter_context(patch("repository_launch.run_attempt_process", side_effect=run))
            cleaned = stack.enter_context(patch("repository_launch.verify_job_containers_stopped"))
            yield {"bench": bench, "launched": launched, "credentials": credentials, "cleaned": cleaned,
                "manifest": path, "upstream": upstream, "probe": probe}

    def test_standalone_disk_rejection_leaves_no_permanent_dispatch(self):
        with self.gateway_fixture(health_states=[{}]) as fixture:
            fixture["probe"].side_effect = lambda *_a, **_k: {"status": "blocked"}
            with self.assertRaises(DispatchError):
                main()
            fixture["launched"].assert_not_called()
            fixture["credentials"].assert_not_called()
            self.assertFalse((fixture["bench"] / "campaign/source-dispatch.json").exists())
            state = json.loads((fixture["bench"] / "campaign/resource-leases/resources.json").read_text())
            self.assertIsNone(state["admission"])

    def test_parent_join_does_not_probe_twice_or_retire_parent_between_phases(self):
        with self.gateway_fixture(health_states=[{}, {}, {}, {}]) as fixture:
            manifest = json.loads(fixture["manifest"].read_text())
            pool = ResourceLeases(fixture["bench"] / "campaign/resource-leases", manifest["resource_pool"])
            scope = scope_for(manifest, digest(fixture["manifest"]), {1: ["source", "replay"]}, owner="parent", batch_id="pair")
            with admission_session(pool, scope, manifest_path=fixture["manifest"], bench=fixture["bench"], tasks_root=fixture["bench"], probe_fn=passed_probe) as handle:
                with patch("sys.argv", ["repository_launch.py", "--manifest", str(fixture["manifest"]), "--attempt", "1", "--admission-id", handle.admission_id]):
                    main()
                state = json.loads(pool.path.read_text())
                self.assertEqual(state["admission"]["status"], "admitted")
                self.assertEqual(len(state["history"]), 2)
                self.assertEqual(len(state["admission"]["members_started"]), 2)
            fixture["probe"].assert_not_called()
            self.assertEqual(fixture["launched"].call_count, 2)

    def test_unknown_source_cannot_be_replayed_from_result_file_alone(self):
        with self.gateway_fixture(health_states=[]) as fixture:
            job = fixture["bench"] / "jobs/source"
            job.mkdir(parents=True)
            (job / "result.json").write_text('{}')
            with patch("sys.argv", ["repository_launch.py", "--manifest", str(fixture["manifest"]), "--attempt", "1", "--replay-only"]):
                with self.assertRaises(DispatchError):
                    main()
            fixture["launched"].assert_not_called()
            fixture["probe"].assert_not_called()

    def test_declared_upstream_and_authentication_blockers_prevent_any_launch(self):
        cases = [{"upstream": None}, {"upstream": {"baseURL": "https://another.invalid/v1", "endpointId": "0" * 64}},
            {"authenticationBlocker": {"code": "UPSTREAM_AUTHENTICATION_BLOCKED", "upstreamStatus": 401}}]
        for change in cases:
            with self.subTest(change=change), self.gateway_fixture(health_states=[change]) as fixture:
                with self.assertRaises(DispatchError):
                    main()
                fixture["launched"].assert_not_called()
                fixture["credentials"].assert_not_called()
                self.assertFalse((fixture["bench"] / "campaign/source-dispatch.json").exists())

    def test_gateway_is_rechecked_after_acquiring_capacity_and_released_on_failure(self):
        blocked = {"authenticationBlocker": {"code": "UPSTREAM_AUTHENTICATION_BLOCKED", "upstreamStatus": 401}}
        for changed in (blocked, {"upstream": None}):
            with self.subTest(changed=changed), self.gateway_fixture(health_states=[{}, changed]) as fixture:
                with self.assertRaises(DispatchError):
                    main()
                fixture["launched"].assert_not_called()
                fixture["credentials"].assert_not_called()
                receipt = json.loads((fixture["bench"] / "campaign/source-dispatch.json").read_text())
                self.assertEqual(receipt["status"], "failed")
                self.assertEqual(receipt["lease"]["identity"]["jobId"], "source")
                self.assertIn(receipt["error_code"], ("GATEWAY_PROTOCOL", "UPSTREAM_AUTHENTICATION_BLOCKED"))
                leases = json.loads((fixture["bench"] / "campaign/resource-leases/resources.json").read_text())
                self.assertEqual(leases["leases"], {})
                self.assertEqual([row["status"] for row in leases["history"]], ["released"])

    def test_cancellation_during_post_lease_health_check_releases_without_dispatch(self):
        with self.gateway_fixture(health_states=[{}, KeyboardInterrupt()]) as fixture:
            with self.assertRaises(KeyboardInterrupt):
                main()
            fixture["launched"].assert_not_called()
            fixture["credentials"].assert_not_called()
            receipt = json.loads((fixture["bench"] / "campaign/source-dispatch.json").read_text())
            self.assertEqual(receipt["status"], "failed")
            self.assertEqual(receipt["error_type"], "KeyboardInterrupt")
            leases = json.loads((fixture["bench"] / "campaign/resource-leases/resources.json").read_text())
            self.assertEqual(leases["leases"], {})
            self.assertEqual([row["status"] for row in leases["history"]], ["released"])

    def test_auth_failure_after_source_stops_replay_without_disrupting_cleanup(self):
        blocked = {"authenticationBlocker": {"code": "UPSTREAM_AUTHENTICATION_BLOCKED", "upstreamStatus": 401}}
        with self.gateway_fixture(health_states=[{}, {}, blocked]) as fixture:
            with self.assertRaises(DispatchError) as caught:
                main()
            self.assertEqual(caught.exception.code, "UPSTREAM_AUTHENTICATION_BLOCKED")
            fixture["launched"].assert_called_once()
            fixture["cleaned"].assert_called_once()
            self.assertFalse((fixture["bench"] / "campaign/replay-dispatch.json").exists())
            leases = json.loads((fixture["bench"] / "campaign/resource-leases/resources.json").read_text())
            self.assertEqual(leases["leases"], {})
            self.assertEqual([row["status"] for row in leases["history"]], ["released"])

    def test_legacy_manifest_and_matching_upstream_both_keep_normal_phase_dispatch(self):
        for frozen_upstream in (False, True):
            with self.subTest(frozen_upstream=frozen_upstream), self.gateway_fixture(
                    health_states=[{}, {}, {}, {}], frozen_upstream=frozen_upstream) as fixture:
                main()
                self.assertEqual(fixture["launched"].call_count, 2)
                self.assertEqual(fixture["cleaned"].call_count, 2)

    def test_explicit_null_upstream_is_not_a_legacy_manifest(self):
        with self.gateway_fixture(health_states=[{}]) as fixture:
            manifest = json.loads(fixture["manifest"].read_text())
            manifest["gateway"]["upstream"] = None
            fixture["manifest"].write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                main()
            fixture["launched"].assert_not_called()

    def test_shared_image_preparation_keeps_its_idle_guard_without_model_budget_hardcoding(self):
        state = {"model": "fixture-model", "limitUsd": None, "budgetMode": "unlimited", "activeUpstreamRequests": 0}
        with patch("repository_launch.health", return_value=state), patch("repository_launch.subprocess.check_output", return_value=""):
            self.assertIs(guard_idle({}), state)
        with patch("repository_launch.health", return_value=state), patch("repository_launch.subprocess.check_output", return_value="other-container"):
            with self.assertRaisesRegex(RuntimeError, "idle"):
                guard_idle({})

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
