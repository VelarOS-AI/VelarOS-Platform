import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from version_regression import compare, compare_config, digest


class VersionRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scriptact-version-regression-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.price = self.root / "price.json"
        self.price.write_text(json.dumps({"input": 4, "cached": .4, "output": 20}))
        self.config = {"tasks": ["task-a"]}
        for role in ("baseline", "candidate"):
            manifest = {"model": "same-model", "reasoning_effort": "high", "vm": {"cpus": 4},
                        "resource_pool": {"cpus": 2}, "trial_concurrency": 2,
                        "source_phase_seconds": 500, "agent_budget_seconds": 400,
                        "dataset_revision": "frozen", "official_replay_sha256": "frozen-verifier",
                        "gateway": {"upstream": "same-upstream"},
                        "files_sha256": {"price.json": digest(self.price)},
                        "tasks": {"task-a": {"files_sha256": {"instruction": "opaque-hash"}, "image": "sha256:image"}},
                        "participants": {p: {"agent": "agent:" + p, "model": "same-model",
                                            "kwargs": {"reasoning_effort": "high", "version": "same-control" if p == "control" else role,
                                                       "config": {"model_reasoning_effort": "high"}},
                                            "identity": {"modelName": "same-model", "reasoningEffort": "high"}}
                                         for p in ("agent", "control")},
                        "attempts": [{"task": "task-a", "participant": p, "source_job": f"{role}-{p}",
                                      "replay_job": f"{role}-{p}-replay"} for p in ("agent", "control")]}
            mp = self.root / (role + "-manifest.json")
            mp.write_text(json.dumps(manifest))
            report = {"manifest_sha256": digest(mp), "model": "same-model", "reasoning_effort": "high",
                      "unsettled_requests": 0, "issues": [], "report_errors": [], "jobs": []}
            for participant in ("agent", "control"):
                t = {"task": "swebench-pro/task-a", "source_job": f"{role}-{participant}",
                     "replay_job": f"{role}-{participant}-replay", "reward": 1,
                     "score_authority": "official replay", "agent_seconds": 10,
                     "attempt_wall_seconds": 20, "infrastructure_issue": None,
                     "metrics": {"known_cost_usd": 1, "unknown_cost_requests": 0,
                                 "actual_provider_cost_usd": None, "input_tokens": 100,
                                 "output_tokens": 10, "cache_read_tokens": 80, "request_failure_counts": {}},
                     "agent_metrics": {"response_rejections": {"total": 0}, "tool_usage": {"scope": "host"}}}
                report["jobs"].append({"job": participant, "trials": [t]})
            rp = self.root / (role + "-report.json")
            rp.write_text(json.dumps(report))
            self.config[role] = {"root": str(self.root), "manifest": str(mp), "report": str(rp),
                                 "pricing": str(self.price), "participant": "agent", "control": "control"}

    def mutate_report(self, role, fn):
        path = Path(self.config[role]["report"])
        report = json.loads(path.read_bytes())
        fn(report)
        path.write_text(json.dumps(report))

    def mutate_manifest(self, role, fn):
        path = Path(self.config[role]["manifest"])
        manifest = json.loads(path.read_bytes())
        fn(manifest)
        path.write_text(json.dumps(manifest))
        self.mutate_report(role, lambda d: d.update(manifest_sha256=digest(path)))

    def test_same_task_success_reports_observations_without_causal_claim(self):
        result = compare(self.config)
        self.assertEqual(result["status"], "compared")
        self.assertEqual(result["rows"][0]["agent_time_change"]["ratio"], 1)
        self.assertFalse(result["causal_performance_gain_proved"])
        self.assertFalse(result["general_superiority_proved"])

    def test_cheaper_input_does_not_hide_time_regression(self):
        def edit(report):
            t = report["jobs"][0]["trials"][0]
            t["agent_seconds"] = 12
            t["metrics"].update(known_cost_usd=.8, input_tokens=50)
        self.mutate_report("candidate", edit)
        result = compare(self.config)
        self.assertEqual(result["status"], "review_required")
        row = result["rows"][0]
        self.assertIn("observed_agent_time_increase", row["review_flags"])
        self.assertAlmostEqual(row["reference_fee_change"]["difference"], -.2)

    def test_failed_fast_exit_is_not_a_successful_speed_gain(self):
        self.mutate_report("candidate", lambda d: d["jobs"][0]["trials"][0].update(reward=0, agent_seconds=1))
        row = compare(self.config)["rows"][0]
        self.assertIsNone(row["agent_time_change"])
        self.assertIn("official_quality_regression", row["review_flags"])

    def test_unknown_fee_stays_unknown_and_control_failure_is_kept(self):
        def edit(report):
            report["jobs"][0]["trials"][0]["metrics"]["unknown_cost_requests"] = 1
            t = report["jobs"][1]["trials"][0]
            t["agent_metrics"]["response_rejections"] = {"total": 1, "by_error_code": {"MODEL_PROVIDER": 1}}
            t["metrics"]["request_failure_counts"] = {"model_transport_failed": 1}
        self.mutate_report("candidate", edit)
        row = compare(self.config)["rows"][0]
        self.assertIsNone(row["reference_fee_change"])
        self.assertEqual(row["control_candidate"]["SDK_response_rejections"]["total"], 1)
        self.assertEqual(row["control_candidate"]["gateway_request_failures"], {"model_transport_failed": 1})

    def test_changed_contracts_are_not_comparable(self):
        for key, value in (("model", "other"), ("reasoning_effort", "low"),
                           ("vm", {"cpus": 8}), ("resource_pool", {"cpus": 4}),
                           ("agent_budget_seconds", 600), ("dataset_revision", "other"),
                           ("official_replay_sha256", "other")):
            with self.subTest(key=key):
                original = Path(self.config["candidate"]["manifest"]).read_bytes()
                report = Path(self.config["candidate"]["report"]).read_bytes()
                self.mutate_manifest("candidate", lambda m: m.update({key: value}))
                with self.assertRaises(ValueError):
                    compare(self.config)
                Path(self.config["candidate"]["manifest"]).write_bytes(original)
                Path(self.config["candidate"]["report"]).write_bytes(report)

    def test_changed_task_or_upstream_is_rejected(self):
        self.mutate_manifest("candidate", lambda m: m["tasks"]["task-a"].update(image="other"))
        with self.assertRaises(ValueError):
            compare(self.config)

    def test_report_binding_unsettled_duplicate_and_unknown_quality_are_rejected(self):
        edits = [lambda d: d.update(manifest_sha256="wrong"), lambda d: d.update(unsettled_requests=1),
                 lambda d: d["jobs"][0]["trials"].append(copy.deepcopy(d["jobs"][0]["trials"][0])),
                 lambda d: d["jobs"][0]["trials"][0].update(reward=None),
                 lambda d: d["jobs"][0]["trials"][0].update(source_job="wrong")]
        path = Path(self.config["candidate"]["report"])
        original = path.read_bytes()
        for edit in edits:
            with self.subTest(edit=edits.index(edit)):
                self.mutate_report("candidate", edit)
                with self.assertRaises(ValueError):
                    compare(self.config)
                path.write_bytes(original)

    def test_changed_frozen_price_suppresses_fee_delta(self):
        new_price = self.root / "new-price.json"
        new_price.write_text(json.dumps({"input": 8, "cached": .8, "output": 40}))
        self.config["candidate"]["pricing"] = str(new_price)
        self.mutate_manifest("candidate", lambda m: m["files_sha256"].update({"new-price.json": digest(new_price)}))
        result = compare(self.config)
        self.assertFalse(result["equal_reference_price_contracts"])
        self.assertIsNone(result["rows"][0]["reference_fee_change"])

    def test_invalid_numbers_do_not_produce_a_gain(self):
        for invalid in (True, -1, float("nan"), float("inf"), None):
            with self.subTest(value=invalid):
                self.mutate_report("candidate", lambda d: d["jobs"][0]["trials"][0].update(agent_seconds=invalid))
                result = compare(self.config)
                self.assertIsNone(result["rows"][0]["agent_time_change"])
                self.assertEqual(result["status"], "review_required")

    def test_control_cannot_be_the_version_participant(self):
        self.config["candidate"]["control"] = "agent"
        with self.assertRaises(ValueError):
            compare(self.config)

    def test_each_selected_participant_model_and_effort_override_is_bound(self):
        edits = [
            lambda p: p.update(model="other-model"),
            lambda p: p["kwargs"].update(reasoning_effort="low"),
            lambda p: p["kwargs"]["config"].update(model="other-model"),
            lambda p: p["kwargs"]["config"].update(model_reasoning_effort="low"),
            lambda p: p["identity"].update(modelName="other-model"),
            lambda p: p["identity"].update(reasoningEffort="low"),
        ]
        for role in ("baseline", "candidate"):
            for participant in ("agent", "control"):
                for index, edit in enumerate(edits):
                    with self.subTest(role=role, participant=participant, override=index):
                        path = Path(self.config[role]["manifest"])
                        report_path = Path(self.config[role]["report"])
                        original, report = path.read_bytes(), report_path.read_bytes()
                        self.mutate_manifest(role, lambda m: edit(m["participants"][participant]))
                        with self.assertRaises(ValueError):
                            compare(self.config)
                        path.write_bytes(original)
                        report_path.write_bytes(report)

    def test_independent_control_is_stable_but_candidate_version_can_change(self):
        self.assertEqual(compare(self.config)["status"], "compared")
        edits = [lambda p: p.update(agent="other:control"),
                 lambda p: p["kwargs"].update(version="changed-version"),
                 lambda p: p["kwargs"]["config"].update(model_context_window=1024)]
        for index, edit in enumerate(edits):
            with self.subTest(change=index):
                path = Path(self.config["candidate"]["manifest"])
                report_path = Path(self.config["candidate"]["report"])
                original, report = path.read_bytes(), report_path.read_bytes()
                self.mutate_manifest("candidate", lambda m: edit(m["participants"]["control"]))
                with self.assertRaises(ValueError):
                    compare(self.config)
                path.write_bytes(original)
                report_path.write_bytes(report)

    def test_known_harbor_model_spelling_is_accepted_without_other_provider_aliases(self):
        for role in ("baseline", "candidate"):
            self.mutate_manifest(role, lambda m: [p.update(model="openai/same-model")
                                                for p in m["participants"].values()])
        self.assertEqual(compare(self.config)["status"], "compared")
        self.mutate_manifest("candidate", lambda m: m["participants"]["agent"].update(model="other/same-model"))
        with self.assertRaises(ValueError):
            compare(self.config)

    def test_control_binary_and_identity_are_bound_while_candidate_artifacts_can_change(self):
        for role in ("baseline", "candidate"):
            self.mutate_manifest(role, lambda m: [p.update(files_sha256={"archive": "same-binary"})
                                                for p in m["participants"].values()])
        self.mutate_manifest("candidate", lambda m: m["participants"]["agent"].update(files_sha256={"archive": "new-candidate"}))
        self.mutate_manifest("candidate", lambda m: m["participants"]["agent"]["identity"].update(bundleFingerprint="new-candidate"))
        self.assertEqual(compare(self.config)["status"], "compared")
        edits = [lambda p: p["files_sha256"].update(archive="different-control-binary"),
                 lambda p: p["identity"].update(bundleFingerprint="different-control-identity")]
        for index, edit in enumerate(edits):
            with self.subTest(change=index):
                path = Path(self.config["candidate"]["manifest"])
                report_path = Path(self.config["candidate"]["report"])
                original, report = path.read_bytes(), report_path.read_bytes()
                self.mutate_manifest("candidate", lambda m: edit(m["participants"]["control"]))
                with self.assertRaises(ValueError):
                    compare(self.config)
                path.write_bytes(original)
                report_path.write_bytes(report)

    def test_config_raw_hash_is_bound_and_mid_comparison_change_is_rejected(self):
        path = self.root / "config.json"
        path.write_text(json.dumps(self.config, indent=2))
        expected = digest(path)
        self.assertEqual(compare_config(path)["comparison_config_sha256"], expected)
        real_compare = compare

        def changed(config):
            result = real_compare(config)
            path.write_text(json.dumps(self.config))
            return result

        with patch("version_regression.compare", side_effect=changed):
            with self.assertRaises(ValueError):
                compare_config(path)

    def test_cohort_must_be_predeclared_unique_and_present(self):
        for tasks in ([], ["task-a", "task-a"], ["task-b"]):
            with self.subTest(tasks=tasks):
                self.config["tasks"] = tasks
                with self.assertRaises(ValueError):
                    compare(self.config)


if __name__ == "__main__":
    unittest.main()
