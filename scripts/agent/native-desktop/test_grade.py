"""用途：防止参数名称、官方别名冲突或跳过用例产生错误的原生判分。"""
import json
import tempfile
from pathlib import Path
import unittest

from grade import baseline_expected, expected_case, grade_cases, native_input_identity, native_test_invocation, pytest_results, sympy_results, unittest_case_key, unittest_results


def status_reader(line, _):
    label, terminal = line.rsplit(" ... ", 1)
    names = {"ok": "PASSED", "OK": "PASSED", "FAIL": "FAILED", "ERROR": "ERROR", "skipped": "SKIPPED"}
    return {label: names[terminal.split()[0]]}


def sympy_reader(line, _):
    name, terminal = line.split()
    return {name: {"ok": "PASSED", "F": "FAILED", "E": "ERROR"}[terminal]}


def sympy_log(files, summary):
    return "=== test process starts ===\n" + files + "\n=== tests finished: " + summary + ", in 0.01 seconds ===\n"


class NativeGradingTests(unittest.TestCase):
    def test_sympy_file_trailer_does_not_discard_last_case_and_errors_reproduce_baseline(self):
        log = sympy_log("pkg/test_one.py[2]\ntest_old ok\ntest_new E [FAIL]\n", "1 passed, 1 exceptions")
        cases, aliases = sympy_results(log, 1, sympy_reader)
        task = {"FAIL_TO_PASS": ["test_new"], "PASS_TO_PASS": ["test_old"]}
        assessment = grade_cases(task, cases, label_format="sympy", aliases=aliases)
        self.assertTrue(baseline_expected(assessment))
        self.assertEqual(assessment["caseCount"], 2)
        self.assertEqual(assessment["missing"], 0)
        self.assertFalse(assessment["resolved"])

    def test_sympy_alias_collisions_preserve_every_file_and_qualified_identity(self):
        log = sympy_log("a/test_one.py[1]\ntest_same F [FAIL]\nb/test_two.py[1]\ntest_same ok [OK]\n", "1 passed, 1 failed")
        cases, aliases = sympy_results(log, 1, sympy_reader)
        task = {"FAIL_TO_PASS": ["test_same"], "PASS_TO_PASS": ["b/test_two.py:test_same"]}
        assessment = grade_cases(task, cases, label_format="sympy", aliases=aliases)
        self.assertEqual(len(assessment["officialLabelCases"]["test_same"]), 2)
        self.assertEqual(assessment["groups"]["FAIL_TO_PASS"]["test_same"], "failure")
        self.assertEqual(assessment["groups"]["PASS_TO_PASS"][task["PASS_TO_PASS"][0]], "passed")

    def test_sympy_skips_expected_failures_and_xpasses_are_not_passed(self):
        log = sympy_log("a/test.py[4]\ntest_new ok\ntest_xfail f\ntest_xpass X\ntest_optional missing dependency s [OK]\n", "1 passed, 1 skipped, 1 expected to fail, 1 expected to fail but passed")
        cases, aliases = sympy_results(log, 0, sympy_reader)
        for name in ["test_xfail", "test_xpass", "test_optional"]:
            task = {"FAIL_TO_PASS": ["test_new"], "PASS_TO_PASS": [name]}
            assessment = grade_cases(task, cases, label_format="sympy", aliases=aliases)
            self.assertEqual(assessment["groups"]["PASS_TO_PASS"][name], "skipped")
            self.assertFalse(assessment["resolved"])

    def test_sympy_truncated_duplicate_and_miscounted_outputs_are_rejected(self):
        files = "a/test.py[1]\ntest_old ok [OK]\n"
        good = sympy_log(files, "1 passed")
        malformed = [
            good.split("=== tests finished:")[0],
            good + good,
            good.replace("[1]", "[2]"),
            good.replace("1 passed", "2 passed"),
            good.replace("[OK]", "[FAIL]"),
            sympy_log("a/test.py[2]\ntest_old ok\ntest_old ok [OK]\n", "2 passed"),
            sympy_log("a/test.py[2]\ntest_old ok\nb/test.py[1]\ntest_new ok [OK]\n", "2 passed"),
            good.replace("test_old ok", "test_old uncertain"),
            good.replace("1 passed", "1 passed, 1 passed"),
        ]
        for log in malformed:
            with self.subTest(log=log), self.assertRaises(ValueError):
                sympy_results(log, 0, sympy_reader)

    def test_sympy_exit_and_official_parser_disagreement_are_rejected(self):
        log = sympy_log("a/test.py[1]\ntest_old ok [OK]\n", "1 passed")
        with self.assertRaisesRegex(ValueError, "exit code"):
            sympy_results(log, 1, sympy_reader)
        with self.assertRaisesRegex(ValueError, "official parser"):
            sympy_results(log, 0, lambda line, _: {"test_old": "FAILED"})
        with self.assertRaisesRegex(ValueError, "unknown outcomes"):
            sympy_results(log.replace("1 passed", "1 guessed"), 0, sympy_reader)

    def test_sympy_wrapped_summary_and_timeout_classification(self):
        log = sympy_log("a/test.py[2]\ntest_optional Timeout T\ntest_deadline T [FAIL]\n", "0 passed, 1 skipped,\n1 exceptions")
        cases, _ = sympy_results(log, 1, sympy_reader)
        self.assertEqual(cases[("a/test.py", "test_optional")], "skipped")
        self.assertEqual(cases[("a/test.py", "test_deadline")], "error")

    def test_baseline_requires_failed_case_and_intact_regressions(self):
        for failure in ["passed", "skipped", "missing"]:
            self.assertFalse(baseline_expected({"groups": {"FAIL_TO_PASS": {"a": failure}, "PASS_TO_PASS": {"b": "passed"}}}))
        for failure in ["failure", "error"]:
            self.assertTrue(baseline_expected({"groups": {"FAIL_TO_PASS": {"a": failure}, "PASS_TO_PASS": {"b": "passed"}}}))
            self.assertFalse(baseline_expected({"groups": {"FAIL_TO_PASS": {"a": failure}, "PASS_TO_PASS": {"b": "error"}}}))
    def test_acceptance_identity_binds_every_native_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["task.json", "test.patch", "grade.py", "prepare.py", "parser.py", "constants.py"]:
                (root / name).write_text(name)
            (root / "native-test-profile.json").write_text(json.dumps({"official_parser": {"source": str(root / "parser.py"), "constants": str(root / "constants.py")}}))
            original = native_input_identity(root, root)
            self.assertIsNone(original["environmentLockSha256"])
            for name in ["task.json", "native-test-profile.json", "test.patch", "grade.py", "prepare.py", "parser.py", "constants.py"]:
                content = (root / name).read_bytes()
                (root / name).write_bytes(content + b"\n")
                self.assertNotEqual(native_input_identity(root, root), original, name)
                (root / name).write_bytes(content)
            (root / "native-environment-lock.json").write_text('{}')
            self.assertNotEqual(native_input_identity(root, root), original)

    def test_parameter_separators_do_not_change_case_class(self):
        self.assertEqual(expected_case("tests/test_urls.py::TestUrl::test_url[http://[::1]/]"), ("tests.test_urls.TestUrl", "test_url[http://[::1]/]"))

    def test_alias_collisions_keep_every_failure(self):
        task = {"FAIL_TO_PASS": ["tests/test_names.py::test_name[a"], "PASS_TO_PASS": ["tests/test_names.py::test_ok"]}
        cases = {("tests.test_names", "test_name[a one]"): "failure", ("tests.test_names", "test_name[a two]"): "passed", ("tests.test_names", "test_ok"): "passed"}
        reader = lambda line, _: {line.split()[1]: line.split()[0]}
        result = grade_cases(task, cases, reader)
        self.assertFalse(result["resolved"])
        self.assertEqual(len(result["officialLabelCases"][task["FAIL_TO_PASS"][0]]), 2)
        cases[("tests.test_names", "test_name[a one]")] = "passed"
        self.assertTrue(grade_cases(task, cases, reader)["resolved"])

    def test_missing_and_skipped_required_cases_are_not_passed(self):
        task = {"FAIL_TO_PASS": ["tests/test_case.py::test_new"], "PASS_TO_PASS": ["tests/test_case.py::test_old"]}
        self.assertFalse(grade_cases(task, {("tests.test_case", "test_new"): "passed"})["resolved"])
        self.assertFalse(grade_cases(task, {("tests.test_case", "test_new"): "passed", ("tests.test_case", "test_old"): "skipped"})["resolved"])

    def test_junit_duplicate_case_id_cannot_hide_a_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cases.xml"
            path.write_text('<testsuite><testcase classname="m" name="f"><failure/></testcase><testcase classname="m" name="f"/></testsuite>')
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                pytest_results(path)

    def test_unittest_keeps_class_qualified_official_labels(self):
        task = {"FAIL_TO_PASS": ["test_changed (app.test_changes.TestChanged)"], "PASS_TO_PASS": ["test_old (app.test_changes.TestOld)"]}
        statuses = {"test_changed (app.test_changes.TestChanged)": "FAILED", "test_old (app.test_changes.TestOld)": "PASSED", "test_changed": "FAILED"}
        log = "test_changed (app.test_changes.TestChanged) ... FAIL\ntest_old (app.test_changes.TestOld) ... ok\nRan 2 tests in 0.001s\nFAILED (failures=1)\n"
        cases, _ = unittest_results(log, statuses, 1, status_reader)
        result = grade_cases(task, cases, label_format="unittest")
        self.assertEqual(result["caseCount"], 2)
        self.assertEqual(result["missing"], 0)
        self.assertFalse(result["resolved"])
        cases[("app.test_changes.TestChanged", "test_changed")] = "passed"
        self.assertTrue(grade_cases(task, cases, label_format="unittest")["resolved"])

    def test_unittest_failure_summary_cannot_be_overwritten_by_a_pass(self):
        log = "test_changed (app.Case) ... ok\nFAIL: test_changed (app.Case)\nRan 1 test in 0.1s\nFAILED (failures=1)\n"
        cases, _ = unittest_results(log, {"test_changed (app.Case)": "PASSED"}, 1, status_reader)
        self.assertEqual(cases[("app.Case", "test_changed")], "failure")

    def test_unittest_truncated_duplicate_and_wrong_count_runs_are_rejected(self):
        statuses = {"test_one (app.Case)": "PASSED"}
        for log in ["test_one (app.Case) ... ok\n", "test_one (app.Case) ... ok\nRan 2 tests in 0.1s\nOK\n", "Ran 1 test in 0.1s\nOK\nRan 1 test in 0.1s\nOK\n"]:
            with self.subTest(log=log), self.assertRaises(ValueError):
                unittest_results(log, statuses, 0, status_reader)

    def test_unittest_exit_code_and_terminal_errors_are_not_success(self):
        for log, statuses, code in [
            ("test_one (app.Case) ... ok\nRan 1 test in 0.1s\nOK\n", {"test_one (app.Case)": "PASSED"}, 1),
            ("test_one (app.Case) ... ERROR\nRan 1 test in 0.1s\nOK\n", {"test_one (app.Case)": "ERROR"}, 0),
            ("test_one (app.Case) ... ok\nERROR: test_missing (app.Case)\nRan 1 test in 0.1s\nFAILED (errors=1)\n", {"test_one (app.Case)": "PASSED"}, 1),
        ]:
            with self.subTest(log=log), self.assertRaises(ValueError):
                unittest_results(log, statuses, code, status_reader)

    def test_unittest_required_skip_stays_unresolved(self):
        log = "test_new (app.Case) ... ok\ntest_old (app.Case) ... skipped 'optional'\nRan 2 tests in 0.1s\nOK (skipped=1)\n"
        cases, _ = unittest_results(log, {"test_new (app.Case)": "PASSED", "test_old (app.Case)": "SKIPPED"}, 0, status_reader)
        task = {"FAIL_TO_PASS": ["test_new (app.Case)"], "PASS_TO_PASS": ["test_old (app.Case)"]}
        self.assertFalse(grade_cases(task, cases, label_format="unittest")["resolved"])

    def test_unittest_multiline_description_and_python_method_display_are_canonical(self):
        log = "test_read (app.Case.test_read)\nA description of the behaviour ... ok\ntest_write (app.Case.test_write) ... FAIL\nFAIL: test_write (app.Case.test_write)\nRan 2 tests in 0.1s\nFAILED (failures=1)\n"
        raw = {"A description of the behaviour": "PASSED", "test_write (app.Case.test_write)": "FAILED"}
        cases, aliases = unittest_results(log, raw, 1, status_reader)
        self.assertEqual(cases, {("app.Case", "test_read"): "passed", ("app.Case", "test_write"): "failure"})
        self.assertEqual(aliases, {"A description of the behaviour": [("app.Case", "test_read")]})
        self.assertEqual(unittest_case_key("test_read (app.Case.other_method)"), ("app.Case.other_method", "test_read"))

    def test_unittest_duplicate_or_unfinished_case_headers_cannot_hide_missing_results(self):
        for log in [
            "test_one (app.Case) ... ok\ntest_one (app.Case.test_one) ... ok\nRan 2 tests in 0.1s\nOK\n",
            "test_one (app.Case)\nAn incomplete description\ntest_two (app.Case) ... ok\nRan 2 tests in 0.1s\nOK\n",
        ]:
            with self.subTest(log=log), self.assertRaises(ValueError):
                unittest_results(log, {}, 0, status_reader)

    def test_unittest_description_alias_preserves_every_case_and_missing_aliases(self):
        log = "test_one (app.First.test_one)\nThe same description ... FAIL\ntest_two (app.Second.test_two)\nThe same description ... ok\nRan 2 tests in 0.1s\nFAILED (failures=1)\n"
        cases, aliases = unittest_results(log, {"The same description": "PASSED"}, 1, status_reader)
        task = {"FAIL_TO_PASS": ["The same description"], "PASS_TO_PASS": ["Not emitted"]}
        result = grade_cases(task, cases, label_format="unittest", aliases=aliases)
        self.assertEqual(result["groups"]["FAIL_TO_PASS"]["The same description"], "failure")
        self.assertEqual(len(result["officialLabelCases"]["The same description"]), 2)
        self.assertEqual(result["missing"], 1)
        self.assertFalse(result["resolved"])

    def test_native_runner_does_not_supply_pytest_args_to_django(self):
        profile = {"runner": "django", "python": "/native/python", "args": ["app.tests", "--parallel=1", "--verbosity=2"]}
        self.assertEqual(native_test_invocation(profile, Path("/private/pytest.xml")), ["/native/python", "tests/runtests.py", *profile["args"]])
        profile.update(runner="pytest", pytest_plugins=["pytester"])
        invocation = native_test_invocation(profile, Path("/private/pytest.xml"))
        self.assertIn("--junitxml=/private/pytest.xml", invocation)
        self.assertEqual(invocation[:6], ["/native/python", "-m", "pytest", "-rA", "-p", "pytester"])
        self.assertEqual(native_test_invocation({**profile, "runner": "sympy"}, Path("/private/pytest.xml")), ["/native/python", "bin/test", *profile["args"]])
        with self.assertRaises(ValueError):
            native_test_invocation({**profile, "runner": "unknown"}, Path("/private/pytest.xml"))


if __name__ == "__main__":
    unittest.main()
