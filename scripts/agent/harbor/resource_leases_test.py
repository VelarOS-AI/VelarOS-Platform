"""Offline resource admission, ownership and cancellation settlement tests."""
import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from resource_leases import (DispatchError, ResourceLeases, capacity_policy, guard_gateway,
    task_resources, wait_for_settlement, verify_job_containers_stopped)


def identity(name):
    return dict(campaignId="fixture", candidateId="candidate", participantId="scriptact", taskId=name,
                attemptId=name, jobId=name, phase="source")


class LeaseTests(unittest.TestCase):
    def test_cpu_memory_capacity_and_failed_settlement_are_not_reclaimed(self):
        with tempfile.TemporaryDirectory() as root:
            policy = dict(max_active_attempts=2, cpus=2, memory_mb=8192)
            pool = ResourceLeases(root, policy)
            first = pool.acquire(identity("first"), dict(cpus=1, memory_mb=4096))
            second = pool.acquire(identity("second"), dict(cpus=1, memory_mb=4096))
            with self.assertRaisesRegex(DispatchError, "capacity"):
                pool.acquire(identity("third"), dict(cpus=1, memory_mb=4096), timeout=0)
            pool.finish(first, settled=False, reason="ATTEMPT_UNSETTLED")
            with self.assertRaisesRegex(DispatchError, "already"):
                pool.acquire(identity("first"), dict(cpus=1, memory_mb=4096), timeout=0)
            with self.assertRaisesRegex(DispatchError, "another frozen"):
                ResourceLeases(root, dict(max_active_attempts=3, cpus=3, memory_mb=12288)).acquire(
                    identity("other"), dict(cpus=1, memory_mb=4096), timeout=0)
            with self.assertRaisesRegex(DispatchError, "owner"):
                pool.finish({**second, "lease_id": "wrong"}, settled=True)
            pool.finish(second, settled=True)
            third = pool.acquire(identity("third"), dict(cpus=1, memory_mb=4096), timeout=0)
            pool.finish(third, settled=True)
            state = json.loads((Path(root) / "resources.json").read_text())
            self.assertEqual(list(state["leases"]), ["first"])
            self.assertEqual(state["leases"]["first"]["status"], "blocked")

    def test_separate_processes_cannot_both_admit_one_slot(self):
        with tempfile.TemporaryDirectory() as root:
            code = '''import json, sys
from resource_leases import ResourceLeases, DispatchError
pool = ResourceLeases(sys.argv[1], dict(max_active_attempts=1, cpus=1, memory_mb=4096))
identity = dict(campaignId="c", candidateId="x", participantId="p", taskId=sys.argv[2], attemptId=sys.argv[2], jobId=sys.argv[2], phase="source")
try:
 pool.acquire(identity, dict(cpus=1,memory_mb=4096), timeout=0)
 print("admitted")
except DispatchError as e:
 print(e.code)
'''
            def run(name):
                return subprocess.check_output([sys.executable, "-c", code, root, name],
                    cwd=Path(__file__).parent, text=True).strip()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(run, ["one", "two"]))
            self.assertEqual(sorted(results), ["RESOURCE_CAPACITY_TIMEOUT", "admitted"])

    def test_gateway_unlimited_requires_explicit_authorization_and_matching_model(self):
        state = dict(attribution="signed-attempt-v1", model="fixture-model", budgetMode="unlimited",
                     limitUsd=None, committedUpperUsd=9000)
        with self.assertRaisesRegex(DispatchError, "Explicit"):
            guard_gateway(state, "fixture-model")
        self.assertIs(guard_gateway(state, "fixture-model", True), state)
        with self.assertRaisesRegex(DispatchError, "reasoning effort"):
            guard_gateway({**state, "reasoningEffort": "low"}, "fixture-model", True, "high")
        with self.assertRaisesRegex(DispatchError, "model"):
            guard_gateway(state, "another", True)
        limited = {**state, "budgetMode": "limited", "limitUsd": 9010}
        with self.assertRaisesRegex(DispatchError, "funds"):
            guard_gateway(limited, "fixture-model")

    def test_frozen_upstream_requires_matching_identity_and_valid_binding(self):
        base = "https://fixture.invalid/v1"
        upstream = {"baseURL": base, "endpointId": hashlib.sha256(base.encode()).hexdigest()}
        state = dict(attribution="signed-attempt-v1", model="fixture-model", reasoningEffort="high",
                     budgetMode="unlimited", limitUsd=None, upstream=upstream, authenticationBlocker=None)
        self.assertIs(guard_gateway(state, "fixture-model", True, "high", upstream=upstream), state)
        for changed in (None, {}, {**upstream, "baseURL": "https://another.invalid/v1"},
                        {**upstream, "endpointId": "0" * 64}):
            with self.subTest(health_upstream=changed), self.assertRaises(DispatchError) as caught:
                guard_gateway({**state, "upstream": changed}, "fixture-model", True, "high", upstream=upstream)
            self.assertEqual(caught.exception.code, "GATEWAY_PROTOCOL")
        for invalid in ({}, [], {"baseURL": base}, {**upstream, "endpointId": "wrong"},
                        {"baseURL": "https://user:secret@fixture.invalid/v1", "endpointId": "0" * 64}):
            with self.subTest(frozen_upstream=invalid), self.assertRaises(DispatchError) as caught:
                guard_gateway({**state, "upstream": invalid}, "fixture-model", True, "high", upstream=invalid)
            self.assertEqual(caught.exception.code, "GATEWAY_PROTOCOL")
        # A historical manifest makes no endpoint claim and remains compatible.
        legacy = {key: value for key, value in state.items() if key not in ("upstream", "authenticationBlocker")}
        self.assertIs(guard_gateway(legacy, "fixture-model", True, "high"), legacy)

    def test_authentication_blocker_rejects_admission_but_does_not_block_settlement(self):
        state = dict(attribution="signed-attempt-v1", model="fixture-model", reasoningEffort="high",
                     budgetMode="unlimited", limitUsd=None, activeUpstreamRequests=0,
                     scheduler={"queued": 0})
        for blocker in ({"code": "UPSTREAM_AUTHENTICATION_BLOCKED", "upstreamStatus": 401}, {}, False, "blocked"):
            blocked = {**state, "authenticationBlocker": blocker}
            with self.subTest(blocker=blocker), self.assertRaises(DispatchError) as caught:
                guard_gateway(blocked, "fixture-model", True, "high")
            self.assertEqual(caught.exception.code, "UPSTREAM_AUTHENTICATION_BLOCKED")
            self.assertIs(wait_for_settlement(lambda: blocked, timeout=0), blocked)

    def test_missing_task_limits_consume_the_pool_and_cancelled_admission_never_leases(self):
        with tempfile.TemporaryDirectory() as root:
            policy = dict(max_active_attempts=2, cpus=2, memory_mb=8192)
            (Path(root) / "task.toml").write_text('[environment]\ncpus=1\nmemory_mb=4096\n')
            self.assertEqual(task_resources(root, policy), dict(cpus=1, memory_mb=4096))
            (Path(root) / "task.toml").write_text('[environment]\n')
            self.assertEqual(task_resources(root, policy), dict(cpus=2, memory_mb=8192))
            event = threading.Event(); event.set()
            with self.assertRaises(KeyboardInterrupt):
                ResourceLeases(root, policy).acquire(identity("cancelled"), dict(cpus=1, memory_mb=4096), cancelled=event)

    def test_settlement_is_attempt_scoped_and_container_check_ignores_other_jobs(self):
        with self.assertRaisesRegex(DispatchError, "settling"):
            wait_for_settlement(lambda: {"activeUpstreamRequests": 1}, timeout=0)
        with self.assertRaisesRegex(DispatchError, "settling"):
            wait_for_settlement(lambda: {"activeUpstreamRequests": 0, "scheduler": {"queued": 1}}, timeout=0)
        with tempfile.TemporaryDirectory() as root:
            trial = Path(root) / "trial"; trial.mkdir()
            (trial / "config.json").write_text(json.dumps({"trial_name": "Our-Trial"}))
            with patch("resource_leases.subprocess.check_output", return_value="other-trial__env\n"):
                verify_job_containers_stopped(root, {})
            with patch("resource_leases.subprocess.check_output", return_value="our-trial__env\n"):
                with self.assertRaisesRegex(DispatchError, "active containers"):
                    verify_job_containers_stopped(root, {})

    def test_long_verifier_labels_match_the_installed_harbor_naming_function(self):
        python = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench/venv/bin/python"
        if not python.is_file():
            self.skipTest("The frozen Harbor virtual environment is not installed")
        name = "SharedPrefix" + "a" * 64 + "__owned"
        other = "SharedPrefix" + "a" * 64 + "__another"
        key = "verify-a-very-long-multistep-name-with-symbols_测试"
        code = '''import json, sys
from types import SimpleNamespace
from harbor.trial.trial import Trial
from harbor.environments.docker.docker import _sanitize_docker_compose_project_name
print(json.dumps([_sanitize_docker_compose_project_name(Trial._separate_verifier_session_id(
    SimpleNamespace(config=SimpleNamespace(trial_name=name)), sys.argv[3])) for name in sys.argv[1:3]]))
'''
        owned_label, other_label = json.loads(subprocess.check_output(
            [str(python), "-c", code, name, other, key], text=True))
        self.assertEqual(len(owned_label), 63)
        self.assertNotEqual(owned_label, other_label)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task, trial = root / "task", root / "job/trial"
            task.mkdir(); trial.mkdir(parents=True)
            (task / "task.toml").write_text('[[steps]]\nname=' + json.dumps(key, ensure_ascii=False) + '\n')
            config = {"trial_name": name, "task": {"path": str(task)}}
            (trial / "config.json").write_text(json.dumps(config))
            with patch("resource_leases.subprocess.check_output", return_value=owned_label + "\n"):
                with self.assertRaises(DispatchError) as caught:
                    verify_job_containers_stopped(root / "job", {})
                self.assertEqual(caught.exception.code, "ATTEMPT_CONTAINERS_ACTIVE")
            with patch("resource_leases.subprocess.check_output", return_value=other_label + "\n"):
                verify_job_containers_stopped(root / "job", {})
            (task / "task.toml").unlink()
            with patch("resource_leases.subprocess.check_output", return_value=owned_label + "\n"):
                with self.assertRaises(DispatchError) as caught:
                    verify_job_containers_stopped(root / "job", {})
                self.assertEqual(caught.exception.code, "ATTEMPT_CLEANUP_UNKNOWN")


if __name__ == "__main__":
    unittest.main()
