"""Offline campaign failure/restart contracts. All tasks/results are synthetic."""

import copy
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from pathlib import Path

from parallel_campaign import (Campaign, atomic_json, controller_lock, load_plan,
                               observe_attempt, phase_identity, scoped_requests, sha256)
from request_identity import attempt_credential, authenticate_attempt
from worker_admission_test import passed_probe
from resource_leases import DispatchError


class ParallelCampaignTests(unittest.TestCase):
    def wait_for(self, predicate, seconds=5):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if predicate():
                return
            time.sleep(.01)
        self.fail("Synthetic subprocess did not reach the expected state")

    def fixture(self, root, tasks=("fixture-a", "fixture-b"), workers=2):
        bench = root / "bench"
        for path in (bench / "jobs", bench / "campaign/attempt-credentials", root / "gateway", root / "state"):
            path.mkdir(parents=True)
        snapshot = root / "exposure.json"
        atomic_json(snapshot, {"schema": 1, "created_at": "2026-01-01T00:00:00Z", "observations": [
            {"task": task, "source": "manual-review", "observed_at": "2025-12-01T00:00:00Z"} for task in tasks]})
        manifest = {"model": "gpt-5.6-sol", "reasoning_effort": "high", "trial_concurrency": 1,
            "vm": {"profile": "fixture-worker"}, "frozen_at": "2026-01-02T00:00:00Z", "resource_pool": {"max_active_attempts": 2, "cpus": 4, "memory_mb": 8192},
            "gateway": {"budget_mode": "unlimited", "url": "http://127.0.0.1:48762"},
            "participants": {name: {"model": "openai/gpt-5.6-sol", "kwargs": {"reasoning_effort": "high"},
                                    "files_sha256": {"fixture": "a" * 64}} for name in ("codex", "scriptact")},
            "evaluation": {"schema": 1, "roles": {task: "development" for task in tasks},
                "exposure_snapshot": {"file": str(snapshot), "sha256": sha256(snapshot.read_bytes())}},
            "attempts": [{"task": task, "participant": name, "source_job": f"{task}-{name}-source",
                          "replay_job": f"{task}-{name}-replay"} for task in tasks for name in ("codex", "scriptact")]}
        manifest_path = root / "manifest.json"
        atomic_json(manifest_path, manifest)
        plan = {"schema": 1, "manifest": str(manifest_path), "manifest_sha256": sha256(manifest_path.read_bytes()),
                "gateway_directory": str(root / "gateway"), "participants": {"codex": "codex", "scriptact": "scriptact"},
                "workers": workers, "batches": [{"id": "integration", "role": "development",
                "attempts": list(range(1, len(manifest["attempts"]) + 1))}]}
        plan_path = root / "plan.json"
        atomic_json(plan_path, plan)
        atomic_json(root / "gateway/budget.json", {"requests": []})
        return bench, manifest, manifest_path, plan, plan_path

    def campaign(self, root, fixture, launcher=None):
        bench, manifest, manifest_path, plan, plan_path = fixture
        return Campaign(plan, manifest, manifest_path, sha256(plan_path.read_bytes()), root / "state", bench, launcher,
                        admission_probe=passed_probe, diagnostics_enabled=False)

    def phase(self, campaign, index, phase, reward=1, exception=None, wrong_identity=False):
        manifest = campaign.manifest
        row = manifest["attempts"][index - 1]
        identity = phase_identity(manifest, campaign.manifest_hash, index, phase)
        job = campaign.bench / "jobs" / identity["jobId"]
        trial = job / (row["task"] + "__fixture")
        trial.mkdir(parents=True)
        atomic_json(job / "config.json", {"n_concurrent_trials": 1, "agents": [
            {"name": row["participant"], "model_name": "openai/gpt-5.6-sol"}]})
        atomic_json(job / "lock.json", {"created_at": "2026-09-01T00:00:00Z", "trials": [{"task": {"path": row["task"]}}]})
        atomic_json(job / "result.json", {"started_at": "2026-09-01T00:00:00Z"})
        atomic_json(trial / "config.json", {"task": {"path": row["task"]}})
        result = {"task_name": row["task"], "trial_name": trial.name,
            "started_at": "2026-09-01T00:00:00Z", "finished_at": "2026-09-01T00:00:15Z",
            "agent_execution": {"started_at": "2026-09-01T00:00:05Z", "finished_at": "2026-09-01T00:00:10Z"},
            "exception_info": {"exception_type": exception} if exception else None,
            "verifier_result": {"rewards": {"reward": reward}} if phase == "replay" else None}
        atomic_json(trial / "result.json", result)
        saved = {**identity, "candidateId": "wrong"} if wrong_identity else identity
        atomic_json(job / "request-identity.json", saved)
        atomic_json(campaign.bench / "campaign" / (job.name + "-dispatch.json"),
                    {"request_identity": saved, "status": "finished"})

    def request(self, campaign, index=1, **values):
        return {"id": "call-1", "identity": phase_identity(campaign.manifest, campaign.manifest_hash, index, "source"),
                "model": "gpt-5.6-sol", "metadata": {"reasoningEffort": "high"},
                "startedAt": "2026-09-01T00:00:06Z", "finishedAt": "2026-09-01T00:00:09Z",
                "estimatedUsd": .12, "budgetUsd": .12, "status": "http-200",
                "usage": {"input_tokens": 100, "output_tokens": 10,
                          "input_tokens_details": {"cached_tokens": 50, "cache_write_tokens": 0}}, **values}

    def test_plan_freezes_paired_exposed_tasks_model_reasoning_and_capacity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bench, manifest, manifest_path, plan, path = self.fixture(root)
            self.assertEqual(load_plan(path, bench / "jobs")[0], plan)
            for change, message in [({"workers": 3}, "resource pool"),
                                    ({"participants": {"codex": "codex"}}, "exactly Codex"),
                                    ({"manifest_sha256": "0" * 64}, "identity differs"),
                                    ({"batches": [{"id": "a", "role": "development", "attempts": [1, 3]}]}, "pair the same")]:
                atomic_json(path, {**plan, **change})
                with self.assertRaisesRegex(ValueError, message):
                    load_plan(path, bench / "jobs")
            manifest["participants"]["scriptact"]["kwargs"]["reasoning_effort"] = "low"
            atomic_json(manifest_path, manifest)
            atomic_json(path, {**plan, "manifest_sha256": sha256(manifest_path.read_bytes())})
            with self.assertRaisesRegex(ValueError, "reasoning effort"):
                load_plan(path, bench / "jobs")

    def test_diagnostic_launch_failure_never_changes_dispatch_or_accounting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            campaign = self.campaign(root, self.fixture(root, tasks=("fixture-a",)))
            campaign.diagnostics_enabled = True
            campaign.diagnostics_launcher = Mock(side_effect=RuntimeError("PRIVATE_DIAGNOSTIC_SECRET"))
            launches = []
            def launch(index, replay_only):
                launches.append((index, replay_only))
                self.phase(campaign, index, "source")
                self.phase(campaign, index, "replay")
                return 0
            campaign.launcher = launch
            ledger_before = (root / "gateway/budget.json").read_bytes()
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "completed")
            self.assertEqual(sorted(launches), [(1, False), (2, False)])
            self.assertEqual(campaign.blocked_queues(), {})
            self.assertEqual((root / "gateway/budget.json").read_bytes(), ledger_before)
            logs = (root / "state/diagnostics/controller-events.jsonl").read_text()
            self.assertIn("diagnostic_launch_failed", logs)
            self.assertNotIn("PRIVATE_DIAGNOSTIC_SECRET", logs)
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "completed")
            self.assertEqual(len(launches), 2)

    def test_source_terminal_diagnostic_starts_before_replay_and_cancel_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            campaign = self.campaign(root, self.fixture(root, tasks=("fixture-a",)))
            campaign.diagnostics_enabled = True
            campaign.diagnostic_active = True
            campaign.observation_started = time.monotonic()
            process = Mock()
            process.poll.side_effect = lambda: -9 if process.kill.called else None
            process.wait.side_effect = lambda **kwargs: -9 if process.kill.called else (_ for _ in ()).throw(subprocess.TimeoutExpired("fixture", kwargs.get("timeout")))
            campaign.diagnostics_launcher = Mock(return_value=process)
            self.phase(campaign, 1, "source")
            campaign.refresh_report(root / "gateway/budget.json")
            args = campaign.diagnostics_launcher.call_args.args[0]
            self.assertEqual(args[args.index("--stage") + 1], "source-terminal")
            self.assertFalse((campaign.bench / "jobs/fixture-a-codex-replay").exists())
            before = campaign.path.read_bytes()
            campaign.request_stop(signal.SIGTERM)
            campaign.finish_diagnostics(root / "gateway/budget.json", cancelled=True)
            self.assertEqual(campaign.path.read_bytes(), before)
            process.terminate.assert_called_once()
            process.kill.assert_called_once()
            self.assertIsNone(campaign.diagnostic_process)
            self.assertIn('"status": "unknown"', (root / "state/diagnostics/controller-events.jsonl").read_text())

    def test_missing_diagnostic_receipt_cannot_be_reported_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            campaign = self.campaign(root, self.fixture(root))
            campaign.diagnostics_enabled = True
            campaign.diagnostics_launcher = Mock(return_value=Mock(poll=Mock(return_value=0)))
            campaign.queue_diagnostic("controller-terminal", root / "gateway/budget.json")
            campaign.poll_diagnostic()
            events = [json.loads(line) for line in (root / "state/diagnostics/controller-events.jsonl").read_text().splitlines()]
            self.assertEqual(events[-1]["status"], "unknown")
            self.assertIsNone(events[-1]["receipt_sha256"])

    def test_development_label_does_not_authorize_unexposed_tasks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bench, manifest, manifest_path, plan, path = self.fixture(root)
            snapshot_path = Path(manifest["evaluation"]["exposure_snapshot"]["file"])
            snapshot = json.loads(snapshot_path.read_text())
            snapshot["observations"].pop()
            atomic_json(snapshot_path, snapshot)
            manifest["evaluation"]["exposure_snapshot"]["sha256"] = sha256(snapshot_path.read_bytes())
            atomic_json(manifest_path, manifest)
            atomic_json(path, {**plan, "manifest_sha256": sha256(manifest_path.read_bytes())})
            with self.assertRaisesRegex(ValueError, "already exposed"):
                load_plan(path, bench / "jobs")

    def test_bounded_parallel_run_keeps_solve_failures_and_resumes_without_new_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = self.fixture(root)
            campaign = self.campaign(root, fixture)
            active, peak, calls = 0, 0, []
            lock = threading.Lock()
            def launch(index, replay_only):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    calls.append((index, replay_only))
                time.sleep(.03)
                self.phase(campaign, index, "source", exception="AgentTimeoutError" if index == 1 else None)
                self.phase(campaign, index, "replay", reward=0 if index == 1 else 1)
                with lock:
                    active -= 1
                return 0
            campaign.launcher = launch
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "completed")
            self.assertEqual(peak, 2)
            self.assertEqual(len(calls), 4)
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "solve_failed")
            reopened = self.campaign(root, fixture, launch)
            self.assertEqual(reopened.run_batch("integration", root / "gateway/budget.json"), "completed")
            self.assertEqual(len(calls), 4)
            report = json.loads((root / "state/report.json").read_text())
            self.assertEqual(report["jobs"][0]["trials"][0]["reward"], 0)
            self.assertFalse(report["supports_general_superiority"])

    def test_grading_failure_stops_only_affected_queue(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = self.fixture(root, workers=1)
            campaign = self.campaign(root, fixture)
            calls = []
            def launch(index, replay_only):
                calls.append(index)
                self.phase(campaign, index, "source")
                self.phase(campaign, index, "replay", exception="VerifierError" if index == 1 else None)
                return 0
            campaign.launcher = launch
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "blocked")
            self.assertEqual(calls, [1, 2, 4])
            self.assertEqual(campaign.blocked_queues(), {"codex": [1]})
            self.assertEqual(campaign.state["attempts"]["3"]["status"], "pending")

    def test_authenticated_http_failure_blocks_queue_and_survives_reconciliation(self):
        for status in ("http-401", "http-403-interrupted"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                fixture = self.fixture(root, workers=1)
                campaign = self.campaign(root, fixture)
                request = self.request(campaign, status=status, estimatedUsd=None, usage=None)
                credential = attempt_credential(request["identity"], "synthetic-secret")
                request["identity"] = authenticate_attempt(credential, "synthetic-secret")
                budget = root / "gateway/budget.json"
                calls = []
                def launch(index, replay_only):
                    calls.append(index)
                    self.phase(campaign, index, "source")
                    self.phase(campaign, index, "replay", reward=0 if index == 1 else 1)
                    if index == 1:
                        atomic_json(budget, {"requests": [request]})
                    return 0
                campaign.launcher = launch
                self.assertEqual(campaign.run_batch("integration", budget), "blocked")
                self.assertEqual(calls, [1, 2, 4])
                self.assertEqual(campaign.state["attempts"]["1"]["status"], "infrastructure_failed")
                self.assertEqual(campaign.state["attempts"]["1"]["issue"], "model_authentication_failed")
                reopened = self.campaign(root, fixture, launch)
                self.assertEqual(reopened.run_batch("integration", budget), "blocked")
                self.assertEqual(calls, [1, 2, 4], "a failed source must never be retried")
                report = json.loads((root / "state/report.json").read_text())
                issues = json.loads((root / "state/issues.json").read_text())
                checkpoint = json.loads((root / "state/checkpoint.json").read_text())
                self.assertEqual(report["blocked_queues"], {"codex": [1]})
                self.assertEqual(report["all_attempt_requests"]["unknown_cost_requests"], 1)
                self.assertEqual(issues[0]["kind"], "model_authentication_failed")
                self.assertEqual(issues[0]["severity"], "queue_blocker")
                self.assertEqual(issues[0]["request_evidence"][0]["id"], request["id"])
                self.assertEqual(issues[0]["request_evidence"][0]["status"], status)
                self.assertEqual(checkpoint["batches"]["integration"]["status"], "blocked")
                self.assertEqual(report["jobs"][0]["infrastructure_issues"], 1)
                self.assertEqual(report["jobs"][0]["trials"][0]["reward"], 0)

    def test_live_auth_blocks_but_service_retries_remain_provisional(self):
        for statuses, expected in ((["reserved"], None), (["http-400"], None),
                                   (["http-503"], None), (["http-503", "http-200"], None),
                                   (["http-401"], "model_authentication_failed"),
                                   (["http-503", "http-503"], None),
                                   (["http-429", "http-429"], None)):
            with self.subTest(statuses=statuses), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                campaign = self.campaign(root, self.fixture(root))
                campaign.state["attempts"]["1"]["status"] = "dispatching"
                rows = [self.request(campaign, id=f"call-{index}", status=status,
                                    startedAt=f"2026-09-01T00:00:0{index}Z",
                                    finishedAt=None if status == "reserved" else f"2026-09-01T00:00:1{index}Z")
                        for index, status in enumerate(statuses)]
                atomic_json(root / "gateway/budget.json", {"requests": rows})
                campaign.refresh_report(root / "gateway/budget.json")
                self.assertEqual(campaign.blocked_queues(), {"codex": [1]} if expected else {})
                if expected:
                    self.assertEqual(campaign.state["attempts"]["1"]["issue"], expected)

    def test_terminal_service_failure_is_infrastructure_and_preserves_official_reward(self):
        for status in ("http-429", "http-503"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                campaign = self.campaign(root, self.fixture(root))
                self.phase(campaign, 1, "source", exception="AgentProviderError")
                self.phase(campaign, 1, "replay", reward=1)
                campaign.reconcile([1])
                atomic_json(root / "gateway/budget.json", {"requests": [self.request(campaign, status=status)]})
                campaign.refresh_report(root / "gateway/budget.json")
                report = json.loads((root / "state/report.json").read_text())
                self.assertEqual(report["jobs"][0]["trials"][0]["reward"], 1)
                self.assertEqual(report["jobs"][0]["aggregate"]["clean_successes"], 0)
                self.assertEqual(report["jobs"][0]["infrastructure_issues"], 1)
                self.assertEqual(campaign.blocked_queues(), {"codex": [1]})

    def test_terminal_unrecovered_stream_failure_blocks_only_its_queue_without_raw_error(self):
        for status in ("http-200-interrupted", "unknown"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                campaign = self.campaign(root, self.fixture(root, workers=1))
                budget = root / "gateway/budget.json"
                request = self.request(campaign, status=status, estimatedUsd=None, usage=None,
                    failure={"name": "TypeError", "causeCode": "ECONNRESET", "upstreamStatus": 200,
                             "message": "RAW_PROVIDER_BODY_MUST_NOT_APPEAR"})
                calls = []
                def launch(index, replay_only):
                    calls.append(index)
                    self.phase(campaign, index, "source", exception="NonZeroAgentExitCodeError" if index == 1 else None)
                    self.phase(campaign, index, "replay", reward=0 if index == 1 else 1)
                    if index == 1:
                        atomic_json(budget, {"requests": [request]})
                    return 0
                campaign.launcher = launch
                self.assertEqual(campaign.run_batch("integration", budget), "blocked")
                self.assertEqual(calls, [1, 2, 4])
                self.assertEqual(campaign.state["attempts"]["1"]["issue"], "model_transport_failed")
                report = json.loads((root / "state/report.json").read_text())
                self.assertEqual(report["jobs"][0]["trials"][0]["reward"], 0)
                self.assertEqual(report["all_attempt_requests"]["unknown_cost_requests"], 1)
                evidence = report["issues"][0]["request_evidence"][0]
                self.assertEqual(evidence["failure_kind"], "model_transport_failed")
                self.assertEqual(evidence["transport_code"], "ECONNRESET")
                for name in ("checkpoint.json", "report.json", "issues.json"):
                    self.assertNotIn("RAW_PROVIDER_BODY_MUST_NOT_APPEAR", (root / "state" / name).read_text())

    def test_stream_failure_is_provisional_and_a_later_success_clears_its_effect(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            campaign.state["attempts"]["1"]["status"] = "dispatching"
            budget = root / "gateway/budget.json"
            interrupted = self.request(campaign, status="http-200-interrupted", usage=None, estimatedUsd=None,
                                       failure={"causeCode": "ECONNRESET"})
            atomic_json(budget, {"requests": [interrupted]})
            campaign.refresh_report(budget)
            self.assertEqual(campaign.blocked_queues(), {})
            self.assertNotIn("request_failure", campaign.state["attempts"]["1"])
            recovered = self.request(campaign, id="recovered", startedAt="2026-09-01T00:00:10Z",
                                     finishedAt="2026-09-01T00:00:11Z")
            atomic_json(budget, {"requests": [interrupted, recovered]})
            self.phase(campaign, 1, "source")
            self.phase(campaign, 1, "replay", reward=1)
            campaign.reconcile([1])
            campaign.refresh_report(budget)
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "completed")
            self.assertEqual(campaign.blocked_queues(), {})
            report = json.loads((root / "state/report.json").read_text())
            self.assertEqual(report["all_attempt_requests"]["request_failure_counts"], {"model_transport_failed": 1})
            self.assertEqual(report["all_attempt_requests"]["unknown_cost_requests"], 1)

    def test_unsettled_opaque_or_cancelled_failure_is_not_assumed_to_be_provider_transport(self):
        cases = [("unknown", None), ("unknown", {"message": "ECONNRESET in untrusted prose"}),
                 ("http-200-interrupted", {"name": "AbortError", "code": "ABORT_ERR"})]
        for status, failure in cases:
            with self.subTest(status=status, failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                campaign = self.campaign(root, self.fixture(root))
                self.phase(campaign, 1, "source", exception="NonZeroAgentExitCodeError")
                self.phase(campaign, 1, "replay", reward=0)
                campaign.reconcile([1])
                budget = root / "gateway/budget.json"
                atomic_json(budget, {"requests": [self.request(campaign, status=status, failure=failure)]})
                campaign.refresh_report(budget)
                self.assertEqual(campaign.blocked_queues(), {})
                self.assertEqual(campaign.state["attempts"]["1"]["status"], "solve_failed")

    def test_pending_retry_does_not_confirm_an_unrecovered_terminal_transport_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            self.phase(campaign, 1, "source", exception="NonZeroAgentExitCodeError")
            self.phase(campaign, 1, "replay", reward=0)
            campaign.reconcile([1])
            budget = root / "gateway/budget.json"
            atomic_json(budget, {"requests": [self.request(campaign, status="http-200-interrupted",
                failure={"causeCode": "ECONNRESET"}), self.request(campaign, id="pending-retry",
                status="reserved", finishedAt=None, usage=None, estimatedUsd=None)]})
            campaign.refresh_report(budget)
            self.assertNotIn("request_failure", campaign.state["attempts"]["1"])

    def test_two_live_service_errors_can_recover_without_creating_a_sticky_blocker(self):
        for status in ("http-429", "http-503"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                campaign = self.campaign(root, self.fixture(root))
                campaign.state["attempts"]["1"]["status"] = "dispatching"
                budget = root / "gateway/budget.json"
                rows = [self.request(campaign, id=f"call-{index}", status=status,
                                    startedAt=f"2026-09-01T00:00:0{index}Z") for index in range(2)]
                atomic_json(budget, {"requests": rows})
                campaign.refresh_report(budget)
                self.assertEqual(campaign.blocked_queues(), {})
                self.assertNotIn("request_failure", campaign.state["attempts"]["1"])
                rows.append(self.request(campaign, id="recovered", status="http-200",
                                         startedAt="2026-09-01T00:00:08Z"))
                atomic_json(budget, {"requests": rows})
                campaign.refresh_report(budget)
                self.assertEqual(campaign.blocked_queues(), {})
                self.phase(campaign, 1, "source", exception="AgentTimeoutError")
                self.phase(campaign, 1, "replay", reward=0)
                campaign.reconcile([1])
                campaign.refresh_report(budget)
                self.assertEqual(campaign.blocked_queues(), {})
                self.assertEqual(campaign.state["attempts"]["1"]["status"], "solve_failed")

    def test_completed_source_is_not_a_system_failure_based_on_reward_or_old_http_errors(self):
        for reward in (0, 1):
            with self.subTest(reward=reward), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                campaign = self.campaign(root, self.fixture(root))
                self.phase(campaign, 1, "source")
                self.phase(campaign, 1, "replay", reward=reward)
                campaign.reconcile([1])
                budget = root / "gateway/budget.json"
                atomic_json(budget, {"requests": [self.request(campaign, status="http-503")]})
                campaign.refresh_report(budget)
                self.assertEqual(campaign.blocked_queues(), {})
                self.assertEqual(campaign.state["attempts"]["1"]["status"], "completed" if reward else "solve_failed")

    def test_native_authentication_exception_blocks_even_without_a_gateway_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            self.phase(campaign, 1, "source", exception="AgentAuthenticationError")
            campaign.reconcile([1])
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "infrastructure_failed")
            self.assertEqual(campaign.state["attempts"]["1"]["issue"], "model_authentication_failed")
            campaign.refresh_report(root / "gateway/budget.json")
            report = json.loads((root / "state/report.json").read_text())
            self.assertEqual(report["jobs"][0]["ungraded_sources"][0]["source"]["infrastructure_issue"],
                             "model_authentication_failed")

    def test_live_ledger_block_stops_next_attempt_while_affected_launcher_drains(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            budget = root / "gateway/budget.json"
            failed, drained = threading.Event(), threading.Event()
            calls = []
            def launch(index, replay_only):
                calls.append(index)
                if index == 1:
                    atomic_json(budget, {"requests": [self.request(campaign, status="http-401")]})
                    failed.set()
                    self.assertTrue(drained.wait(3), "the healthy queue must continue during cleanup")
                elif index == 2:
                    self.assertTrue(failed.wait(3))
                elif index == 4:
                    self.assertEqual(campaign.blocked_queues(), {"codex": [1]})
                    drained.set()
                self.phase(campaign, index, "source")
                self.phase(campaign, index, "replay", reward=0 if index == 1 else 1)
                return 0
            campaign.launcher = launch
            self.assertEqual(campaign.run_batch("integration", budget), "blocked")
            self.assertEqual(calls, [1, 2, 4])
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "infrastructure_failed")

    def test_queue_release_covers_only_observed_request_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            self.phase(campaign, 1, "source")
            self.phase(campaign, 1, "replay", reward=0)
            campaign.reconcile([1])
            budget = root / "gateway/budget.json"
            first = self.request(campaign, status="http-401")
            atomic_json(budget, {"requests": [first]})
            campaign.refresh_report(budget)
            state = campaign.state["attempts"]["1"]
            campaign.state["queue_releases"].append({"attempt": 1, "issue": state["issue"],
                "request_ids": list(state["request_failure"]["request_ids"]), "reason": "offline repair evidence"})
            self.assertEqual(campaign.blocked_queues(), {})
            # Late settlement from this immutable attempt is new blocker evidence,
            # not permission to charge for a repeated source run.
            second = self.request(campaign, id="late-401", status="http-401",
                                  startedAt="2026-09-01T00:00:10Z", finishedAt="2026-09-01T00:00:11Z")
            atomic_json(budget, {"requests": [first, second]})
            campaign.refresh_report(budget)
            self.assertEqual(campaign.blocked_queues(), {"codex": [1]})
            self.assertEqual(state["request_failure"]["request_ids"], ["call-1", "late-401"])

    def test_identity_conflict_stops_all_future_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = self.fixture(root, workers=1)
            campaign = self.campaign(root, fixture)
            calls = []
            def launch(index, replay_only):
                calls.append(index)
                self.phase(campaign, index, "source", wrong_identity=True)
                return 1
            campaign.launcher = launch
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "blocked")
            self.assertEqual(calls, [1])
            self.assertIn("*", campaign.blocked_queues())

    def test_completed_source_resumes_only_never_dispatched_replay(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = self.fixture(root, tasks=("fixture-a",))
            campaign = self.campaign(root, fixture)
            self.phase(campaign, 1, "source")
            campaign.state["attempts"]["1"] = {"status": "dispatching", "dispatch_started_at": "before-crash"}
            campaign.save()
            calls = []
            def launch(index, replay_only):
                calls.append((index, replay_only))
                if not replay_only:
                    self.phase(campaign, index, "source")
                self.phase(campaign, index, "replay")
                return 0
            reopened = self.campaign(root, fixture, launch)
            self.assertEqual(reopened.run_batch("integration", root / "gateway/budget.json"), "completed")
            self.assertEqual(sorted(calls), [(1, True), (2, False)])

    def test_crash_before_exec_and_lost_replay_launch_never_loop_or_repeat(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = self.fixture(root, tasks=("fixture-a",))
            campaign = self.campaign(root, fixture)
            campaign.state["attempts"]["1"] = {"status": "dispatching", "dispatch_started_at": "before-crash"}
            campaign.reconcile([1])
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "uncertain")
            self.phase(campaign, 2, "source")
            calls = []
            campaign.launcher = lambda index, replay_only: calls.append((index, replay_only)) or 1
            campaign.run_batch("integration", root / "gateway/budget.json")
            self.assertEqual(calls, [(2, True)])
            self.assertEqual(campaign.state["attempts"]["2"]["status"], "uncertain")
            campaign.run_batch("integration", root / "gateway/budget.json")
            self.assertEqual(calls, [(2, True)])

    def test_orphan_credentials_prevent_accidental_new_paid_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            identity = phase_identity(campaign.manifest, campaign.manifest_hash, 1, "source")
            marker = campaign.bench / "campaign/attempt-credentials" / (sha256(identity["attemptId"].encode()) + ".token")
            marker.write_text("synthetic-scoped-credential")
            state = observe_attempt(campaign.manifest, campaign.manifest_hash, 1, campaign.bench, {"status": "pending"})
            self.assertEqual(state["status"], "uncertain")

    def test_live_unknown_and_late_requests_remain_attributed_without_relaunch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            request = self.request(campaign, estimatedUsd=None, finishedAt=None, usage=None, status="reserved")
            budget = root / "gateway/budget.json"
            atomic_json(budget, {"requests": [request]})
            campaign.refresh_report(budget)
            report = json.loads((root / "state/report.json").read_text())
            self.assertEqual(report["all_attempt_requests"]["requests"], 1)
            self.assertEqual(report["all_attempt_requests"]["unknown_cost_requests"], 1)
            self.assertEqual(report["unsettled_requests"], 1)
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "uncertain")
            self.assertEqual(campaign.state["attempts"]["1"]["issue"], "existing_request_without_dispatch_evidence")
            late = self.request(campaign, finishedAt="2026-10-01T00:00:09Z")
            atomic_json(budget, {"requests": [late]})
            campaign.refresh_report(budget)
            report = json.loads((root / "state/report.json").read_text())
            self.assertEqual(report["attempts"][0]["metrics"]["known_cost_usd"], .12)
            self.assertEqual(report["unsettled_requests"], 0)
            self.assertEqual(report["attempts"][0]["request_ids"], ["call-1"])

    def test_ledger_conflicts_or_wrong_model_reasoning_block_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            valid = self.request(campaign)
            wrong_owner = copy.deepcopy(valid)
            wrong_owner["identity"]["candidateId"] = "changed"
            for calls in ([valid, valid], [wrong_owner], [self.request(campaign, model="other")],
                          [self.request(campaign, metadata={"reasoningEffort": "low"})]):
                with self.assertRaises(ValueError):
                    scoped_requests(campaign.manifest, campaign.manifest_hash, calls)
            atomic_json(root / "gateway/budget.json", {"requests": [wrong_owner]})
            launched = []
            campaign.launcher = lambda index, replay_only: launched.append(index)
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "blocked")
            self.assertEqual(launched, [])

    def test_one_controller_and_checkpoint_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = self.fixture(root)
            campaign = self.campaign(root, fixture)
            campaign.save()
            with controller_lock(root / "state"):
                with self.assertRaisesRegex(RuntimeError, "live controller"):
                    with controller_lock(root / "state"):
                        self.fail("second controller entered")
            with self.assertRaisesRegex(ValueError, "different frozen plan"):
                Campaign(fixture[3], fixture[1], fixture[2], "different", root / "state", fixture[0])

    def test_live_partial_files_do_not_block_the_other_queue_or_claim_a_grade(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            row = campaign.manifest["attempts"][0]
            source = campaign.bench / "jobs" / row["source_job"]
            trial = source / "fixture"
            trial.mkdir(parents=True)
            for path in (source / "config.json", source / "lock.json", trial / "result.json"):
                path.write_text('{"writing":')
            receipt = campaign.bench / "campaign" / (row["source_job"] + "-dispatch.json")
            receipt.write_text('{"writing":')
            campaign.refresh_report(root / "gateway/budget.json")
            self.assertFalse(campaign.blocked_queues())
            self.assertEqual(json.loads((root / "state/report.json").read_text())["jobs"][0]["completed"], 0)
            # A completed source plus an uncommitted replay must retain usage but no reward.
            for path in (trial / "result.json", source / "config.json", source / "lock.json", receipt):
                path.unlink()
            trial.rmdir()
            self.phase(campaign, 1, "source")
            replay = campaign.bench / "jobs" / row["replay_job"] / "partial"
            replay.mkdir(parents=True)
            (replay / "result.json").write_text('{"writing":')
            campaign.refresh_report(root / "gateway/budget.json")
            report = json.loads((root / "state/report.json").read_text())
            self.assertFalse(campaign.blocked_queues())
            self.assertEqual(len(report["jobs"][0]["ungraded_sources"]), 1)
            self.assertEqual(report["jobs"][0]["completed"], 0)

    def test_report_keeps_durations_cache_context_and_native_tool_layers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            self.phase(campaign, 1, "source")
            self.phase(campaign, 1, "replay")
            row = campaign.manifest["attempts"][0]
            agent = campaign.bench / "jobs" / row["source_job"] / (row["task"] + "__fixture") / "agent"
            agent.mkdir()
            atomic_json(agent / "trajectory.json", {"session_id": "synthetic-session", "steps": [
                {"tool_calls": [{"tool_call_id": "one", "function_name": "exec"}]}]})
            (agent / "codex.txt").write_text("\n".join(json.dumps(event) for event in [
                {"type": "thread.started", "thread_id": "one"},
                {"type": "item.started", "item": {"id": "same", "type": "command_execution"}},
                {"type": "item.completed", "item": {"id": "same", "type": "command_execution", "exit_code": 0}},
                {"type": "turn.completed"}]))
            atomic_json(root / "gateway/budget.json", {"requests": [self.request(campaign)]})
            campaign.refresh_report(root / "gateway/budget.json")
            report = json.loads((root / "state/report.json").read_text())
            trial = report["jobs"][0]["trials"][0]
            self.assertEqual(trial["agent_seconds"], 5)
            self.assertEqual(trial["source_trial_seconds"], 15)
            self.assertEqual(trial["trial_lifecycle_seconds"], trial["end_to_end_seconds"])
            self.assertIsNone(trial["attempt_wall_seconds"])
            self.assertEqual(trial["metrics"]["requests"], 1)
            self.assertEqual(trial["metrics"]["cache_token_hit_rate"], .5)
            self.assertEqual(trial["metrics"]["peak_input_tokens"], 100)
            self.assertIsNone(trial["agent_metrics"]["context"])
            self.assertEqual(trial["agent_metrics"]["tool_usage"]["calls"], 1)
            self.assertEqual(trial["agent_metrics"]["native_operations"]["tool_usage"]["calls"], 1)
            self.assertEqual(len(report["jobs"][0]["source_tool_usage"]["operations"]), 2)
            markdown = (root / "state/report.md").read_text()
            self.assertIn("trial 跨阶段秒数 | attempt 完整秒数", markdown)
            self.assertIn("旧 end_to_end_seconds 保留此口径", markdown)
            self.assertIn("清理终态未确认时保持未知", markdown)

    def test_overlapping_attempts_keep_their_own_dispatch_walls_and_failed_source_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root, tasks=("fixture-a",)))
            for index in (1, 2):
                for phase in ("source", "replay"):
                    self.phase(campaign, index, phase, reward=0 if index == 1 else 1,
                               exception="AgentTimeoutError" if index == 1 and phase == "source" else None)
                    identity = phase_identity(campaign.manifest, campaign.manifest_hash, index, phase)
                    job = campaign.bench / "jobs" / identity["jobId"]
                    result_path = next(job.glob("*/result.json"))
                    result = json.loads(result_path.read_text())
                    result.update({"started_at": "2026-09-01T00:00:02Z" if phase == "source" else "2026-09-01T00:00:20Z",
                                   "finished_at": "2026-09-01T00:00:15Z" if phase == "source" else "2026-09-01T00:00:50Z"})
                    atomic_json(result_path, result)
                    start = f"2026-09-01T00:00:0{index - 1}Z" if phase == "source" else "2026-09-01T00:00:19Z"
                    finish = "2026-09-01T00:00:17Z" if phase == "source" else f"2026-09-01T00:00:{50 + index * 4}Z"
                    atomic_json(campaign.bench / "campaign" / (job.name + "-dispatch.json"),
                                {"request_identity": identity, "phase": phase, "attempt": index,
                                 "trial_result": str(result_path), "status": "finished",
                                 "started_at": start, "finished_at": finish})
            campaign.refresh_report(root / "gateway/budget.json")
            report = json.loads((root / "state/report.json").read_text())
            self.assertEqual(report["report_errors"], [])
            trials = [job["trials"][0] for job in report["jobs"]]
            self.assertEqual([trial["attempt_wall_seconds"] for trial in trials], [54, 57])
            self.assertEqual([trial["trial_lifecycle_seconds"] for trial in trials], [48, 48])
            self.assertEqual(trials[0]["source_exception"], "AgentTimeoutError")
            self.assertEqual([trial["reward"] for trial in trials], [0, 1])
            text = (root / "state/report.md").read_text()
            self.assertIn("| 48.000000 | 54.000000 |", text)
            self.assertIn("| 48.000000 | 57.000000 |", text)
            self.assertIn("并发 attempt 的时间不能相加作为批次墙钟时间", text)

    def test_first_read_markdown_discloses_live_reference_and_mixed_price_estimates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            campaign.state["attempts"]["1"]["status"] = "dispatching"
            campaign.state["attempts"]["2"]["status"] = "dispatching"
            reference = {"kind": "reference_only", "source": "synthetic official price sheet",
                         "upstreamBaseURL": "https://reference-proxy.example/v1"}
            provider = {"kind": "provider_rates", "source": "synthetic provider price sheet",
                        "upstreamBaseURL": "https://provider.example/v1"}
            rows = [self.request(campaign, pricingBasis=reference),
                    self.request(campaign, id="provider-call", pricingBasis=provider, estimatedUsd=.34),
                    self.request(campaign, id="pending-call", pricingBasis=reference,
                                 status="reserved", estimatedUsd=None, usage=None, finishedAt=None),
                    self.request(campaign, index=2, id="legacy-call", estimatedUsd=.22)]
            budget = root / "gateway/budget.json"
            atomic_json(budget, {"requests": rows})
            campaign.refresh_report(budget)
            text = (root / "state/report.md").read_text()
            report = json.loads((root / "state/report.json").read_text())
            self.assertLess(text.index("参考价格估算，实际扣费未知"), text.index("| 尝试 |"))
            self.assertIn("混合依据的总值不代表实际供应商扣费", text)
            self.assertIn("synthetic official price sheet", text)
            self.assertIn("synthetic provider price sheet", text)
            self.assertIn("https://reference-proxy.example/v1", text)
            self.assertIn("历史记录未声明", text)
            self.assertIn("已知估算美元", text)
            self.assertIn("未知估算请求", text)
            self.assertNotIn("| 已知美元 |", text)
            self.assertEqual(report["all_attempt_requests"]["pricing_basis"]["kind"], "mixed")
            self.assertIsNone(report["all_attempt_requests"]["actual_provider_cost_usd"])
            self.assertEqual(report["all_attempt_requests"]["requests"], 4)
            self.assertEqual(report["all_attempt_requests"]["unknown_cost_requests"], 1)
            self.assertAlmostEqual(report["all_attempt_requests"]["known_cost_usd"], .68)

    def test_cleanup_block_and_failed_receipts_never_resume_source_or_replay(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            self.phase(campaign, 1, "source")
            row = campaign.manifest["attempts"][0]
            path = campaign.bench / "campaign" / (row["source_job"] + "-dispatch.json")
            receipt = json.loads(path.read_text())
            receipt.update({"status": "blocked", "cleanup_error_code": "SETTLEMENT_UNKNOWN"})
            atomic_json(path, receipt)
            campaign.reconcile([1])
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "uncertain")
            receipt.update({"status": "failed", "error_code": "HARBOR_PROCESS_FAILED"})
            atomic_json(path, receipt)
            campaign.reconcile([1])
            self.assertEqual(campaign.state["attempts"]["1"]["status"], "infrastructure_failed")

    def test_launch_wires_frozen_gateway_and_replay_without_running_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            campaign.admission = Mock(admission_id="synthetic-parent-epoch")
            with patch("parallel_campaign.subprocess.Popen") as run:
                run.return_value.wait.return_value = 0
                self.assertEqual(campaign.launch(1, True), 0)
            command = run.call_args.args[0]
            self.assertIn("--replay-only", command)
            self.assertIn("--allow-unlimited", command)
            self.assertEqual(command[command.index("--gateway-directory") + 1], str(root / "gateway"))

    def test_official_pass_with_blocked_cleanup_is_not_a_clean_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            self.phase(campaign, 1, "source")
            self.phase(campaign, 1, "replay")
            job = campaign.manifest["attempts"][0]["replay_job"]
            path = campaign.bench / "campaign" / (job + "-dispatch.json")
            receipt = json.loads(path.read_text())
            receipt.update({"status": "blocked", "cleanup_error_code": "SETTLEMENT_UNKNOWN"})
            atomic_json(path, receipt)
            campaign.reconcile([1])
            campaign.refresh_report(root / "gateway/budget.json")
            report = json.loads((root / "state/report.json").read_text())
            self.assertEqual(report["jobs"][0]["trials"][0]["reward"], 1)
            self.assertEqual(report["jobs"][0]["aggregate"]["clean_successes"], 0)
            self.assertEqual(report["jobs"][0]["infrastructure_issues"], 1)
            self.assertEqual(report["blocked_queues"], {"codex": [1]})

    def test_real_controller_signals_forward_once_and_hold_lock_until_launcher_cleanup(self):
        for requested_signal in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=requested_signal), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                bench, manifest, manifest_path, plan, plan_path = self.fixture(root, workers=1)
                interpreter = bench / "venv/bin/python"
                interpreter.parent.mkdir(parents=True)
                # This executable replaces only the launcher interpreter in a private
                # fixture. It creates no Harbor process, container or model request.
                interpreter.write_text(f'''#!{sys.executable}
import json, os, signal, sys, time
from pathlib import Path
root = Path({str(root)!r})
index = sys.argv[sys.argv.index('--attempt') + 1]
signals = []
def stop(number, frame):
    signals.append(number)
    (root / ('cancel-' + index + '.json')).write_text(json.dumps(signals))
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
(root / ('started-' + index + '.json')).write_text(json.dumps({{'pid': os.getpid()}}))
while not signals:
    time.sleep(.01)
time.sleep(.5)
(root / ('cleaned-' + index + '.json')).write_text(json.dumps(signals))
''')
                interpreter.chmod(0o700)
                script = f'''
from pathlib import Path
from parallel_campaign import Campaign, controller_lock, read_json, sha256
from worker_admission_test import passed_probe
root = Path({str(root)!r})
plan_path = root / 'plan.json'
with controller_lock(root / 'state'):
    campaign = Campaign(read_json(plan_path), read_json(root / 'manifest.json'), root / 'manifest.json',
                        sha256(plan_path.read_bytes()), root / 'state', root / 'bench', admission_probe=passed_probe)
    status = campaign.run_batch('integration', root / 'gateway/budget.json')
    (root / 'controller-result').write_text(status)
'''
                environment = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent)}
                with (root / "controller.log").open("w") as log:
                    controller = subprocess.Popen([sys.executable, "-c", script], env=environment,
                        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    child_pid = None
                    try:
                        self.wait_for(lambda: (root / "started-1.json").exists())
                        child_pid = json.loads((root / "started-1.json").read_text())["pid"]
                        controller.send_signal(requested_signal)
                        self.wait_for(lambda: (root / "cancel-1.json").exists())
                        self.assertIsNone(controller.poll(), "controller must await launcher cleanup")
                        with self.assertRaisesRegex(RuntimeError, "live controller"):
                            with controller_lock(root / "state"):
                                self.fail("controller released its lock before cleanup")
                        controller.send_signal(requested_signal)
                        self.assertEqual(controller.wait(timeout=5), 0)
                        self.assertEqual((root / "controller-result").read_text(), "interrupted")
                        self.assertEqual(json.loads((root / "cleaned-1.json").read_text()), [signal.SIGTERM])
                        self.assertFalse((root / "started-2.json").exists())
                        with self.assertRaises(ProcessLookupError):
                            os.kill(child_pid, 0)
                        checkpoint = json.loads((root / "state/checkpoint.json").read_text())
                        self.assertEqual(checkpoint["batches"]["integration"]["status"], "interrupted")
                        self.assertEqual(checkpoint["batches"]["integration"]["interruption"]["signal"], requested_signal)
                        self.assertEqual(checkpoint["attempts"]["1"]["status"], "uncertain")
                        resumed = []
                        reopened = Campaign(plan, manifest, manifest_path, sha256(plan_path.read_bytes()),
                            root / "state", bench, lambda index, replay_only: resumed.append(index) or 1, admission_probe=passed_probe)
                        with self.assertRaises(DispatchError):
                            reopened.run_batch("integration", root / "gateway/budget.json")
                        self.assertNotIn(1, resumed, "cancelled source must never be redispatched")
                        self.assertFalse((root / "started-2.json").exists())
                    finally:
                        if controller.poll() is None:
                            controller.kill()
                            controller.wait(timeout=5)
                        if child_pid is not None:
                            try:
                                os.kill(child_pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass

    def test_natural_launcher_exit_during_signal_does_not_skip_other_children(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            gone, active = Mock(), Mock()
            gone.poll.return_value = active.poll.return_value = None
            gone.send_signal.side_effect = ProcessLookupError
            campaign.launcher_processes = {1: gone, 2: active}
            campaign.cancel_launchers()
            campaign.cancel_launchers()
            gone.send_signal.assert_called_once_with(signal.SIGTERM)
            active.send_signal.assert_called_once_with(signal.SIGTERM)


    def test_21_disk_rejection_is_zero_dispatch_and_same_checkpoint_recovers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = self.fixture(root, tasks=("fixture-a",))
            campaign = self.campaign(root, fixture)
            calls = []
            def launch(index, replay_only):
                calls.append(index)
                self.phase(campaign, index, "source")
                self.phase(campaign, index, "replay")
                return 0
            campaign.launcher = launch
            campaign.admission_probe = lambda *_a, **_k: {"status": "blocked"}
            with self.assertRaises(DispatchError):
                campaign.run_batch("integration", root / "gateway/budget.json")
            self.assertEqual(calls, [])
            self.assertTrue(all(item["status"] == "pending" and "dispatch_started_at" not in item
                for item in campaign.state["attempts"].values()))
            self.assertEqual(list((root / "state").glob("attempt-*.controller.log")), [])
            self.assertEqual(list((fixture[0] / "campaign").glob("*-dispatch.json")), [])
            self.assertEqual(list((fixture[0] / "campaign/attempt-credentials").iterdir()), [])
            campaign.admission_probe = passed_probe
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "completed")
            self.assertEqual(sorted(calls), [1, 2])

    def test_22_report_and_completed_resume_do_not_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root, tasks=("fixture-a",)))
            campaign.admission_probe = Mock(side_effect=AssertionError("unexpected live probe"))
            campaign.refresh_report(root / "gateway/budget.json")
            for index in (1, 2):
                self.phase(campaign, index, "source")
                self.phase(campaign, index, "replay")
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "completed")
            campaign.admission_probe.assert_not_called()

    def test_23_replay_ready_scope_contains_no_source_and_preserves_unknown_usage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root, tasks=("fixture-a",)))
            for index in (1, 2):
                self.phase(campaign, index, "source")
            observed = []
            def launch(index, replay_only):
                self.assertTrue(replay_only)
                observed.extend(item["phase"] for item in campaign.admission.claim["scope"]["members"].values())
                self.phase(campaign, index, "replay")
                return 0
            campaign.launcher = launch
            # Finished unknown cost remains accounting evidence, not an active disk occupant.
            atomic_json(root / "gateway/budget.json", {"requests": [self.request(campaign, usage=None, estimatedUsd=None, budgetUsd=1)]})
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "completed")
            self.assertEqual(set(observed), {"replay"})

    def test_24_stop_before_dispatch_creates_no_epoch_or_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            campaign.admission_probe = Mock(side_effect=AssertionError("unexpected probe"))
            campaign.launcher = Mock()
            campaign.request_stop(signal.SIGTERM)
            self.assertEqual(campaign.run_batch("integration", root / "gateway/budget.json"), "interrupted")
            campaign.launcher.assert_not_called()
            campaign.admission_probe.assert_not_called()
            self.assertFalse((campaign.bench / "campaign/resource-leases/resources.json").exists())

    def test_25_probe_crash_and_unknown_dispatch_are_never_auto_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            campaign = self.campaign(root, self.fixture(root))
            campaign.admission_probe = Mock(side_effect=RuntimeError("synthetic probe crash"))
            campaign.launcher = Mock()
            with self.assertRaises(RuntimeError):
                campaign.run_batch("integration", root / "gateway/budget.json")
            campaign.admission_probe = passed_probe
            with self.assertRaises(DispatchError):
                campaign.run_batch("integration", root / "gateway/budget.json")
            campaign.launcher.assert_not_called()


if __name__ == "__main__":
    unittest.main()
