"""Repository grades must not hide source failures, costs, or pending replay."""

import json
import hashlib
import tempfile
import unittest
from pathlib import Path

from repository_report import comparison_manifest, image_selection_coverage, summarize_repository


class RepositoryReportTests(unittest.TestCase):
    def test_image_gaps_remain_outside_scores_with_verified_selection_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selection = root / "selection.json"
            selection.write_text(json.dumps({"validation_tasks": ["missing", "ready", "unchecked"]}))
            selection_sha = hashlib.sha256(selection.read_bytes()).hexdigest()
            evidence = root / "images.json"
            checks = {"source_manifest": str(selection), "source_sha256": selection_sha,
                "rows": [{"task": "missing", "selection_position": 0, "status": "unavailable",
                    "http_status": 404, "registry_error_codes": ["MANIFEST_UNKNOWN"]},
                    {"task": "ready", "selection_position": 1, "status": "resolved", "http_status": 200}]}
            evidence.write_text(json.dumps(checks))
            manifest = {"selection_sha256": selection_sha, "image_selection_evidence": {
                "file": str(evidence), "sha256": hashlib.sha256(evidence.read_bytes()).hexdigest()},
                "attempts": [{"participant": "codex", "task": "ready"}, {"participant": "scriptact", "task": "ready"}]}
            before = json.dumps(manifest)
            result = image_selection_coverage(manifest)
            self.assertEqual(result["validation_task_count"], 3)
            self.assertEqual(result["scheduled_task_count"], 1)
            self.assertEqual(result["checked_image_count"], 2)
            self.assertEqual(result["resolved_image_manifest_count"], 1)
            self.assertEqual(result["image_issues"], [{"task": "missing", "status": "unavailable",
                "http_status": 404, "registry_error_codes": ["MANIFEST_UNKNOWN"]}])
            self.assertEqual(result["unchecked_tasks"], ["unchecked"])
            self.assertEqual(json.dumps(manifest), before)
            self.assertIsNone(image_selection_coverage({}))
            with self.assertRaisesRegex(ValueError, "no resolved image"):
                image_selection_coverage({**manifest, "attempts": [{"task": "missing"}]})
            evidence.write_text(evidence.read_text() + "\n")
            with self.assertRaisesRegex(ValueError, "Image selection evidence changed"):
                image_selection_coverage(manifest)
            evidence.write_text(json.dumps(checks))
            selection.write_text(selection.read_text() + "\n")
            with self.assertRaisesRegex(ValueError, "Validation selection changed"):
                image_selection_coverage(manifest)

    def test_reference_sources_are_frozen_and_task_matched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = {"model": "gpt-6-sol", "reasoning_effort": "high", "dataset_revision": "fixed",
                "tasks": {"instance_fixture": {"identity": "fixed"}}, "participants": {"reference": {}},
                "attempts": [{"participant": "reference", "task": "instance_fixture",
                    "source_job": "reference-source", "replay_job": "reference-replay"}]}
            path = root / "reference.json"
            path.write_text(json.dumps(reference))
            candidate = {**reference, "participants": {"candidate": {}},
                "attempts": [{"participant": "candidate", "task": "instance_fixture",
                    "source_job": "candidate-source", "replay_job": "candidate-replay"}],
                "reference_manifest": str(path),
                "reference_manifest_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "reference_sources": reference["attempts"]}
            combined = comparison_manifest(candidate)
            self.assertEqual(list(combined["participants"]), ["reference", "candidate"])
            self.assertEqual(len(combined["attempts"]), 2)
            summaries = summarize_repository(combined, root, [])
            self.assertEqual([row["completed"] for row in summaries], [0, 0])
            self.assertEqual([row["planned"] for row in summaries], [1, 1])
            self.assertTrue(all(row["mean_score"] is None for row in summaries))
            altered = {**candidate, "reference_sources": [{**reference["attempts"][0], "source_job": "replacement"}]}
            with self.assertRaisesRegex(ValueError, "not a frozen reference attempt"):
                comparison_manifest(altered)
            with self.assertRaisesRegex(ValueError, "protocol differs"):
                comparison_manifest({**candidate, "reasoning_effort": "low"})
            with self.assertRaisesRegex(ValueError, "protocol differs: execution_env"):
                comparison_manifest({**candidate, "execution_env": {"GODEBUG": "cpu.avx2=off"}})
            with self.assertRaisesRegex(ValueError, "task set"):
                comparison_manifest({**candidate, "attempts": [{**candidate["attempts"][0], "task": "other"}]})
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                comparison_manifest({**candidate, "reference_sources": reference["attempts"] * 2})
            path.write_text(path.read_text() + "\n")
            with self.assertRaisesRegex(ValueError, "Reference manifest changed"):
                comparison_manifest(candidate)

    def fixture(self, root, *, replay=True, source_exception=None, reward=1):
        manifest = {"model": "gpt-6-sol", "participants": {"scriptact": {}}, "attempts": [
            {"participant": "scriptact", "task": "instance_fixture", "source_job": "source", "replay_job": "replay"}]}
        job = root / "source"
        trial = job / "instance_fixture__one"
        trial.mkdir(parents=True)
        (job / "config.json").write_text(json.dumps({"agents": [{"model_name": "openai/gpt-6-sol"}]}))
        (job / "lock.json").write_text(json.dumps({"trials": [{"task": {"path": "instance_fixture"}}]}))
        (trial / "config.json").write_text(json.dumps({"task": {"path": "instance_fixture"}}))
        source = {"task_name": "swebench-pro/instance_fixture", "trial_name": trial.name,
            "started_at": "2026-09-28T00:00:00Z", "finished_at": "2026-09-28T00:00:15Z",
            "agent_execution": {"started_at": "2026-09-28T00:00:05Z", "finished_at": "2026-09-28T00:00:10Z"},
            "exception_info": {"exception_type": source_exception} if source_exception else None,
            "verifier_result": None}
        (trial / "result.json").write_text(json.dumps(source))
        calls = [{"id": "source-call", "startedAt": "2026-09-28T00:00:06Z", "finishedAt": "2026-09-28T00:00:09Z",
            "estimatedUsd": .12, "status": "http-200", "usage": {"input_tokens": 100, "output_tokens": 10,
                "input_tokens_details": {"cached_tokens": 50, "cache_write_tokens": 0}}}]
        if replay:
            target = root / "replay/instance_fixture__two"
            (target / "agent").mkdir(parents=True)
            (target / "agent/replay.json").write_text(json.dumps({"apply_rc": 0}))
            (target / "result.json").write_text(json.dumps({"task_name": "swebench-pro/instance_fixture",
                "started_at": "2026-09-28T00:00:20Z", "finished_at": "2026-09-28T00:00:50Z",
                "agent_execution": {"started_at": "2026-09-28T00:00:25Z", "finished_at": "2026-09-28T00:00:27Z"},
                "verifier": {"started_at": "2026-09-28T00:00:27Z", "finished_at": "2026-09-28T00:00:49Z"},
                "verifier_result": {"rewards": {"reward": reward}}}))
        return manifest, calls

    def test_replay_grade_keeps_source_cost_and_timeout_and_separates_durations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, calls = self.fixture(root, source_exception="AgentTimeoutError")
            result = summarize_repository(manifest, root, calls)[0]
            self.assertEqual(result["mean_score"], 1)
            self.assertEqual(result["aggregate"]["clean_successes"], 0)
            trial = result["trials"][0]
            self.assertEqual(trial["metrics"]["known_cost_usd"], .12)
            self.assertEqual(trial["agent_seconds"], 5)
            self.assertEqual(trial["source_trial_seconds"], 15)
            self.assertEqual(trial["replay_trial_seconds"], 30)
            self.assertEqual(trial["replay_verifier_seconds"], 22)
            self.assertEqual(trial["end_to_end_seconds"], 50)
            self.assertIsNone(trial["source_verifier_reward"])

    def test_native_codex_failure_excludes_clean_success_without_rewriting_official_grade(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, calls = self.fixture(root)
            trial = root / "source/instance_fixture__one"
            before = (trial / "result.json").read_bytes()
            (trial / "agent").mkdir()
            (trial / "agent/codex.txt").write_text(json.dumps({"type": "turn.failed", "error": {"message": "transport failed"}}) + "\n")
            result = summarize_repository(manifest, root, calls)[0]
            self.assertEqual(result["aggregate"]["successes"], 1)
            self.assertEqual(result["aggregate"]["clean_successes"], 0)
            self.assertEqual(result["errors"], 1)
            measured = result["trials"][0]
            self.assertEqual(measured["exception"], "CodexTurnFailed")
            self.assertIsNone(measured["reported_exception"])
            self.assertEqual(measured["native_execution"]["failed_turn_events"], 1)
            self.assertEqual(measured["metrics"]["known_cost_usd"], .12)
            self.assertEqual((trial / "result.json").read_bytes(), before)

    def test_recovered_native_errors_do_not_mark_a_completed_turn_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, calls = self.fixture(root)
            agent = root / "source/instance_fixture__one/agent"
            agent.mkdir()
            (agent / "codex.txt").write_text('\n'.join(json.dumps(row) for row in [
                {"type": "error", "message": "reconnecting"}, {"type": "turn.completed"}]))
            result = summarize_repository(manifest, root, calls)[0]
            self.assertEqual(result["aggregate"]["clean_successes"], 1)
            self.assertIsNone(result["trials"][0]["exception"])
            self.assertEqual(result["trials"][0]["native_execution"]["error_events"], 1)

    def test_native_log_without_terminal_event_does_not_confirm_clean_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, calls = self.fixture(root)
            agent = root / "source/instance_fixture__one/agent"
            agent.mkdir()
            (agent / "codex.txt").write_text('partial or interrupted output\n')
            result = summarize_repository(manifest, root, calls)[0]
            self.assertEqual(result["aggregate"]["clean_successes"], 0)
            self.assertEqual(result["trials"][0]["exception"], "CodexCompletionUnconfirmed")

    def test_pending_replay_has_no_grade_but_retains_spend(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, calls = self.fixture(root, replay=False)
            result = summarize_repository(manifest, root, calls)[0]
            self.assertEqual(result["completed"], 0)
            self.assertIsNone(result["mean_score"])
            self.assertEqual(result["completed_source_usage"][0]["metrics"]["known_cost_usd"], .12)
            self.assertEqual(len(result["ungraded_sources"]), 1)

    def test_failed_replay_counts_zero_and_wrong_task_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, calls = self.fixture(root, reward=0)
            result = summarize_repository(manifest, root, calls)[0]
            self.assertEqual(result["mean_score"], 0)
            self.assertEqual(result["aggregate"]["known_cost_usd"], .12)
            path = root / "replay/instance_fixture__two/result.json"
            replay = json.loads(path.read_text())
            replay["task_name"] = "instance_wrong"
            path.write_text(json.dumps(replay))
            with self.assertRaisesRegex(ValueError, "tasks differ"):
                summarize_repository(manifest, root, calls)


if __name__ == "__main__":
    unittest.main()
