"""Offline immutable diagnostics/race/privacy contracts; no model or Docker."""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import campaign_diagnostics as diagnostics


class CampaignDiagnosticsTests(unittest.TestCase):
    def fixture(self, root, status="complete"):
        root = root.resolve()
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({"model": "fixture", "gateway": {"directory": str(root)},
                                       "reasoning_effort": "high"}))
        state = root / "state"
        state.mkdir()
        index = {"schema": 1, "status": status, "manifest_sha256": diagnostics.file_digest(manifest),
                 "input_fingerprint": "1" * 64, "issues": [], "artifacts": []}
        report = {"jobs": [], "all_attempt_requests": {}, "comparisons": [],
                  "error": "PRIVATE_PROMPT_API_SECRET", "native": {"message": "PRIVATE_PROVIDER_PROSE"}}
        return manifest, state, index, report

    def run_fixture(self, manifest, state, index, report, **kwargs):
        with patch.object(diagnostics, "collect", return_value=index), \
                patch.object(diagnostics, "implementation_hashes", return_value={"report.py": "a" * 64}), \
                patch.object(diagnostics, "formal_report", return_value=report):
            return diagnostics.run_campaign_diagnostics(manifest, state, bench=manifest.parent / "bench", **kwargs)

    def test_complete_reuse_requires_all_output_hashes_and_preserves_old_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, state, index, report = self.fixture(root)
            first = self.run_fixture(manifest, state, index, report)
            self.assertEqual(first["status"], "complete")
            second = self.run_fixture(manifest, state, index, report)
            self.assertTrue(second["reused"])
            self.assertEqual(first["version"], second["version"])
            path = Path(first["version"]) / "report.json"
            path.write_text("corrupt original retained")
            third = self.run_fixture(manifest, state, index, report)
            self.assertFalse(third["reused"])
            self.assertNotEqual(first["version"], third["version"])
            self.assertEqual(path.read_text(), "corrupt original retained")
            self.assertNotIn("PRIVATE_", "".join(p.read_text() for p in Path(third["version"]).glob("*.json")))

    def test_partial_or_unknown_never_reuses_and_unknown_blocks_report_reader(self):
        for status in ("partial", "unknown"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                manifest, state, index, report = self.fixture(Path(temporary), status)
                with patch.object(diagnostics, "collect", return_value=index), \
                        patch.object(diagnostics, "implementation_hashes", return_value={}), \
                        patch.object(diagnostics, "formal_report", return_value=report) as reader:
                    first = diagnostics.run_campaign_diagnostics(manifest, state)
                    second = diagnostics.run_campaign_diagnostics(manifest, state)
                    self.assertEqual(first["status"], status)
                    self.assertFalse(second["reused"])
                    self.assertNotEqual(first["version"], second["version"])
                    if status == "unknown":
                        reader.assert_not_called()

    def test_active_input_or_analysis_implementation_change_is_unknown_and_never_reusable(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, state, index, report = self.fixture(Path(temporary))
            changed = {**index, "input_fingerprint": "2" * 64}
            for where in ("evidence", "source"):
                with self.subTest(where=where), \
                        patch.object(diagnostics, "collect", side_effect=[index, changed if where == "evidence" else index]), \
                        patch.object(diagnostics, "implementation_hashes", side_effect=[{}, {"source": "new"} if where == "source" else {}]), \
                        patch.object(diagnostics, "formal_report", return_value=report):
                    result = diagnostics.run_campaign_diagnostics(manifest, state)
                    self.assertEqual(result["status"], "unknown")
                    receipt = json.loads((Path(result["version"]) / "publication.json").read_text())
                    self.assertEqual(receipt["status"], "unknown")

    def test_source_changes_invalidate_reuse_even_when_evidence_is_equal(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, state, index, report = self.fixture(Path(temporary))
            first = self.run_fixture(manifest, state, index, report)
            with patch.object(diagnostics, "collect", return_value=index), \
                    patch.object(diagnostics, "implementation_hashes", return_value={"report.py": "b" * 64}), \
                    patch.object(diagnostics, "formal_report", return_value=report):
                next_result = diagnostics.run_campaign_diagnostics(manifest, state)
            self.assertFalse(next_result["reused"])
            self.assertNotEqual(first["input_key"], next_result["input_key"])

    def test_reporting_identity_failure_is_recorded_without_private_prose_or_old_report_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, state, index, _ = self.fixture(Path(temporary))
            old = state / "report.json"
            old.write_text("preserved")
            with patch.object(diagnostics, "collect", return_value=index), \
                    patch.object(diagnostics, "implementation_hashes", return_value={}), \
                    patch.object(diagnostics, "formal_report", side_effect=ValueError("identity PRIVATE_SECRET")):
                result = diagnostics.run_campaign_diagnostics(manifest, state)
            self.assertEqual(result["status"], "unknown")
            saved = json.loads((Path(result["version"]) / "report.json").read_text())
            self.assertEqual(saved["failure"]["category"], "identity_evidence_failed")
            self.assertEqual(old.read_text(), "preserved")
            self.assertNotIn("PRIVATE_SECRET", "".join(p.read_text() for p in state.rglob("*.json")))

    def test_alias_inputs_or_outputs_fail_before_readers_and_do_not_touch_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, state, index, report = self.fixture(root)
            alias = root / "alias.json"
            alias.symlink_to(manifest)
            output_alias = root / "output-alias"
            output_alias.symlink_to(state, target_is_directory=True)
            with patch.object(diagnostics, "collect") as reader:
                with self.assertRaisesRegex(ValueError, "symlinks"):
                    diagnostics.run_campaign_diagnostics(alias, state)
                with self.assertRaisesRegex(ValueError, "symlinks"):
                    diagnostics.run_campaign_diagnostics(manifest, state, output_root=output_alias)
                reader.assert_not_called()
            self.assertFalse((state / "versions").exists())

    def test_implementation_closure_includes_formal_readers_and_never_exposes_sources(self):
        hashes = diagnostics.implementation_hashes()
        for name in ("parallel_campaign.py", "evidence_index.py", "metrics.py", "trace_artifact.py",
                     "report.py", "repository_report.py", "tool_metrics.py", "request_identity.py"):
            self.assertIn(str(diagnostics.HERE / name), hashes)
            self.assertEqual(len(hashes[str(diagnostics.HERE / name)]), 64)


if __name__ == "__main__":
    unittest.main()
