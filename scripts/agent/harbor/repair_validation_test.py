"""Dependency and evidence changes must invalidate reusable repair checks."""

import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from repair_validation import check_contract, import_inputs, reusable, run_checks


class RepairValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "source.py"
        self.source.write_text("print('checked')\n")
        self.plan = {"root": str(self.root), "checks": [{"id": "local", "command": [sys.executable, "source.py"],
                      "inputs": ["source.py"], "timeout_seconds": 3}]}

    def run_plan(self, name, previous=(), execute=True):
        return run_checks(self.plan, self.root / name, previous, execute)

    def test_valid_evidence_reuses_without_running_then_corrupt_log_reruns(self):
        first = self.run_plan("first")
        self.assertEqual(first["status"], "passed")
        with patch("repair_validation.subprocess.Popen", side_effect=AssertionError("duplicate execution")):
            second = self.run_plan("second", [first])
        self.assertEqual(second["checks"][0]["status"], "reused")
        Path(first["checks"][0]["log"]).write_text("altered")
        third = self.run_plan("third", [second])
        self.assertEqual(third["checks"][0]["status"], "passed")

    def test_changed_import_and_package_initializer_invalidate(self):
        package = self.root / "pkg"
        package.mkdir()
        (package / "__init__.py").write_text("from . import helper\n")
        helper = package / "helper.py"
        helper.write_text("VALUE = 1\n")
        self.source.write_text("from pkg import helper\nprint(helper.VALUE)\n")
        first = self.run_plan("first")
        files = first["checks"][0]["contract"]["inputs_sha256"]
        self.assertEqual(set(files), {"source.py", "pkg/__init__.py", "pkg/helper.py"})
        helper.write_text("VALUE = 2\n")
        second = self.run_plan("second", [first])
        self.assertEqual(second["checks"][0]["status"], "passed")
        (package / "__init__.py").write_text("from . import helper\nNEW = True\n")
        self.assertEqual(self.run_plan("third", [second])["checks"][0]["status"], "passed")

    def test_discovery_membership_add_remove_requires_execution(self):
        test = self.root / "test_one.py"
        test.write_text("import unittest\nclass One(unittest.TestCase):\n def test_ok(self): self.assertTrue(True)\n")
        self.plan["checks"][0]["command"] = [sys.executable, "-m", "unittest", "discover", "-s", ".", "-p", "test_*.py"]
        first = self.run_plan("first")
        extra = self.root / "test_two.py"
        extra.write_text(test.read_text())
        second = self.run_plan("second", [first])
        self.assertEqual(second["checks"][0]["status"], "passed")
        self.assertEqual(len(second["checks"][0]["contract"]["discovery_membership"]), 2)
        extra.unlink()
        self.assertEqual(self.run_plan("third", [second])["checks"][0]["status"], "passed")

    def test_environment_is_exact_and_changes_are_bound_without_secret_values(self):
        self.source.write_text("import os\nprint(os.environ.get('APP_CONFIG', 'absent'))\n")
        with patch.dict(os.environ, {"APP_CONFIG": "parent-secret"}):
            first = self.run_plan("first")
        self.assertEqual(Path(first["checks"][0]["log"]).read_text().strip(), "absent")
        self.plan["checks"][0]["environment"] = {"APP_CONFIG": "child-config"}
        second = self.run_plan("second", [first])
        self.assertEqual(second["checks"][0]["status"], "passed")
        self.assertNotIn("child-config", json.dumps(second["checks"][0]["contract"]))

    def test_failure_timeout_and_input_change_are_never_reusable(self):
        self.source.write_text("raise SystemExit(4)\n")
        failed = self.run_plan("failed")
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(self.run_plan("failed-again", [failed])["checks"][0]["status"], "failed")
        self.source.write_text("import time\ntime.sleep(2)\n")
        self.plan["checks"][0]["timeout_seconds"] = .05
        timed = self.run_plan("timeout")
        self.assertEqual(timed["checks"][0]["status"], "timeout")
        self.assertTrue(timed["checks"][0]["timed_out_or_cancelled_parent_reaped"])
        self.plan["checks"][0]["timeout_seconds"] = 3
        self.source.write_text("from pathlib import Path\nPath(__file__).write_text('print(2)\\n')\n")
        changed = self.run_plan("change")
        self.assertEqual(changed["checks"][0]["status"], "inputs_changed")

    def test_contract_timeout_tool_and_test_selection_must_match(self):
        first = self.run_plan("first")
        row = first["checks"][0]
        for key, value in [("timeout_seconds", 9), ("executable_sha256", "wrong"),
                           ("command", [sys.executable, "different.py"]), ("environment_sha256", "wrong")]:
            with self.subTest(key=key):
                changed = copy.deepcopy(row["contract"])
                changed[key] = value
                self.assertFalse(reusable(row, changed, self.root))

    def test_dry_run_has_no_execution_and_evidence_path_cannot_escape(self):
        with patch("repair_validation.subprocess.Popen", side_effect=AssertionError("dry execution")):
            planned = self.run_plan("plan", execute=False)
        self.assertEqual(planned["status"], "planned")
        with tempfile.TemporaryDirectory() as outside:
            external = Path(outside) / "outside.py"
            external.write_text("pass\n")
            (self.root / "escape.py").symlink_to(external)
            self.plan["checks"][0]["inputs"] = ["escape.py"]
            with self.assertRaisesRegex(ValueError, "leaves"):
                check_contract(self.root, self.plan["checks"][0])

    def test_relative_import_closure_and_missing_input_rejects(self):
        package = self.root / "pkg"
        package.mkdir()
        (package / "__init__.py").write_text("")
        (package / "helper.py").write_text("VALUE = 2\n")
        module = package / "module.py"
        module.write_text("from .helper import VALUE\n")
        files = import_inputs(self.root, [module])
        self.assertEqual({str(p.relative_to(self.root)) for p in files},
                         {"pkg/module.py", "pkg/helper.py", "pkg/__init__.py"})
        self.plan["checks"][0]["inputs"] = ["missing.py"]
        with self.assertRaisesRegex(ValueError, "regular"):
            check_contract(self.root, self.plan["checks"][0])

    def test_discovery_argument_forms_reject_external_directories(self):
        with tempfile.TemporaryDirectory() as outside:
            for arguments in [["-s" + outside], ["--start-directory=" + outside], [outside],
                              ["-s", ".", "-t" + outside]]:
                with self.subTest(arguments=arguments):
                    self.plan["checks"][0]["command"] = [sys.executable, "-m", "unittest", "discover", *arguments]
                    with self.assertRaisesRegex(ValueError, "leaves"):
                        check_contract(self.root, self.plan["checks"][0])

    def test_discovery_top_level_imports_are_bound(self):
        package = self.root / "src/pkg"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("")
        helper = package / "helper.py"
        helper.write_text("VALUE = True\n")
        tests = self.root / "src/tests"
        tests.mkdir()
        (tests / "__init__.py").write_text("")
        (tests / "test_ok.py").write_text("import unittest\nfrom pkg import helper\nclass One(unittest.TestCase):\n def test_ok(self): self.assertTrue(helper.VALUE)\n")
        self.plan["checks"][0]["command"] = [sys.executable, "-m", "unittest", "discover", "-s", "src/tests", "-t", "src"]
        first = self.run_plan("first")
        self.assertEqual(first["status"], "passed")
        self.assertIn("src/pkg/helper.py", first["checks"][0]["contract"]["inputs_sha256"])
        helper.write_text("VALUE = True\nCHANGED = True\n")
        self.assertEqual(self.run_plan("second", [first])["checks"][0]["status"], "passed")


if __name__ == "__main__":
    unittest.main()
