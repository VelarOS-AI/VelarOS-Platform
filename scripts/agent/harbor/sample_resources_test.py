"""Offline structural resource sampling boundaries; no real Docker or API calls."""

import argparse
import json
import subprocess
import unittest

from sample_resources import (
    DEFAULT_CONTEXT, INSPECT_FORMAT, collect_sample, controller_status, docker_context,
    parser, resource_values,
)

CID = "a" * 64
OTHER_CID = "b" * 64
PRIVATE = "private-value-never-written"


def completed(stdout="", stderr="", code=0):
    return subprocess.CompletedProcess([], code, stdout, stderr)


def stats(cid=CID):
    return {"Container": cid, "ID": cid, "Name": "fixture__env-main-1",
            "CPUPerc": "31.25%", "MemUsage": "32MiB / 4GiB"}


def inspection(**extra):
    return {"id": CID, "name": "/fixture__env-main-1", "nano_cpus": 1000000000,
            "cpu_quota": 0, "cpu_period": 0, "cpu_shares": 0,
            "memory_bytes": 4294967296, "memory_swap_bytes": 8589934592,
            "pids_limit": None, "network_mode": "fixture_default", **extra}


class ResourceSamplingTest(unittest.TestCase):
    def sample(self, inspector, seen=None, item=None):
        commands = []

        def run(argv, **kwargs):
            commands.append((argv, kwargs))
            if "stats" in argv:
                return completed(json.dumps(item or stats()))
            return inspector(argv, **kwargs)

        result = collect_sample(DEFAULT_CONTEXT, seen if seen is not None else set(),
                                run=run, clock=lambda: "fixture-at", load=lambda: (1, 2, 3))
        return result, commands

    def test_actual_limits_are_selected_and_secrets_never_leave_inspect(self):
        row, commands = self.sample(lambda *_args, **_kwargs: completed(json.dumps(
            inspection(Config={"Env": [PRIVATE], "Cmd": [PRIVATE]}, command=PRIVATE))))
        values = row["resource_limits"][0]["values"]
        self.assertEqual(values["nano_cpus"], 1000000000)
        self.assertEqual(values["memory_bytes"], 4294967296)
        self.assertEqual(row["containers"][0]["CPUPerc"], "31.25%")
        self.assertNotIn(PRIVATE, json.dumps(row))
        self.assertEqual(commands[1][0][-3:], ["--format", INSPECT_FORMAT, CID])
        self.assertNotIn(".Config", INSPECT_FORMAT)
        self.assertNotIn(".State", INSPECT_FORMAT)

    def test_each_new_id_has_one_inspect_even_across_samples(self):
        seen = set()
        first, commands = self.sample(lambda *_args, **_kwargs: completed(json.dumps(inspection())), seen)
        self.assertEqual(len(first["resource_limits"]), 1)
        second, later = self.sample(lambda *_args, **_kwargs: self.fail("repeat inspect"), seen)
        self.assertEqual(second["resource_limits"], [])
        self.assertEqual(len(commands), 2)
        self.assertEqual(len(later), 1)

    def test_disappeared_between_stats_and_inspect_preserves_unknown(self):
        row, _ = self.sample(lambda *_args, **_kwargs: completed(stderr="No such object: " + PRIVATE, code=1))
        observation = row["resource_limits"][0]
        self.assertEqual(observation["status"], "unknown")
        self.assertEqual(observation["reason"], "container_disappeared")
        self.assertIsNone(observation["values"])
        self.assertNotIn(PRIVATE, json.dumps(row))

    def test_inspect_timeout_is_unknown_and_is_not_reissued(self):
        seen = set()

        def timeout(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"], output=PRIVATE, stderr=PRIVATE)

        row, _ = self.sample(timeout, seen)
        self.assertEqual(row["resource_limits"][0]["reason"], "inspect_timeout")
        self.assertIsNone(row["resource_limits"][0]["values"])
        self.assertNotIn(PRIVATE, json.dumps(row))
        _, commands = self.sample(lambda *_args, **_kwargs: self.fail("retry unknown inspection"), seen)
        self.assertEqual(len(commands), 1)

    def test_native_zero_unlimited_and_unset_do_not_become_unknown(self):
        values = resource_values(inspection(nano_cpus=0, cpu_quota=-1, memory_bytes=0,
                                           memory_swap_bytes=-1, pids_limit=-1), CID)
        self.assertEqual(values["nano_cpus"], 0)
        self.assertEqual(values["cpu_quota"], -1)
        self.assertEqual(values["memory_swap_bytes"], -1)
        self.assertEqual(values["pids_limit"], -1)
        self.assertIsNone(resource_values(inspection(), CID)["pids_limit"])

    def test_missing_invalid_boolean_and_wrong_identity_fail_closed(self):
        cases = [inspection(id=OTHER_CID), inspection(nano_cpus=True), inspection(nano_cpus=-1),
                 inspection(cpu_quota=-2), inspection(memory_bytes=None), inspection(network_mode=None)]
        missing = inspection(); missing.pop("cpu_period"); cases.append(missing)
        for case in cases:
            with self.subTest(case=case):
                row, _ = self.sample(lambda *_args, case=case, **_kwargs: completed(json.dumps(case)))
                self.assertEqual(row["resource_limits"][0]["status"], "unknown")
                self.assertEqual(row["resource_limits"][0]["reason"], "invalid_inspect_fields_or_identity")
                self.assertIsNone(row["resource_limits"][0]["values"])

    def test_rename_race_keeps_exact_id_and_marks_changed_name(self):
        row, _ = self.sample(lambda *_args, **_kwargs: completed(json.dumps(inspection(name="/renamed"))))
        observation = row["resource_limits"][0]
        self.assertEqual(observation["status"], "recorded")
        self.assertEqual(observation["container_id"], CID)
        self.assertFalse(observation["name_matches_stats"])

    def test_invalid_stats_id_and_sensitive_extra_fields_are_not_persisted(self):
        row, commands = self.sample(lambda *_args, **_kwargs: self.fail("invalid-ID inspect"), item=stats("a" * 12))
        self.assertEqual(row["containers"], [])
        self.assertEqual(row["stats_errors"][0]["reason"], "invalid_stats_fields_or_identity")
        self.assertEqual(len(commands), 1)
        item = {**stats(), "Env": PRIVATE, "Cmd": PRIVATE}
        valid, _ = self.sample(lambda *_args, **_kwargs: completed(json.dumps(inspection())), item=item)
        self.assertNotIn(PRIVATE, json.dumps(valid))

    def test_stats_timeout_and_nonzero_preserve_reason_without_private_output(self):
        def timeout(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"], output=PRIVATE)
        row = collect_sample(DEFAULT_CONTEXT, set(), run=timeout, load=lambda: (0, 0, 0))
        self.assertEqual(row["error"], "docker_stats_timeout")
        self.assertEqual(row["resource_limits"], [])
        row = collect_sample(DEFAULT_CONTEXT, set(), run=lambda *_args, **_kwargs: completed(PRIVATE, PRIVATE, 7), load=lambda: (0, 0, 0))
        self.assertEqual(row["error"], "docker_stats_nonzero_exit")
        self.assertEqual(row["docker_exit"], 7)
        self.assertNotIn(PRIVATE, json.dumps(row))

    def test_controller_contract_does_not_persist_private_command(self):
        status = controller_status(123, run=lambda *_args, **_kwargs: completed("S python parallel_campaign.py " + PRIVATE))
        self.assertEqual(status, {"state": "running"})
        self.assertNotIn(PRIVATE, json.dumps(status))
        self.assertEqual(controller_status(123, run=lambda *_args, **_kwargs: completed("Z python parallel_campaign.py")), {"state": "stopped"})
        self.assertEqual(controller_status(123, run=lambda *_args, **_kwargs: completed(code=1)), {"state": "stopped"})

    def test_exact_context_and_profile_cli_keep_existing_required_arguments(self):
        args = parser().parse_args(["--output", "fixture.jsonl", "--controller-pid", "123"])
        self.assertEqual(docker_context(args), DEFAULT_CONTEXT)
        args = parser().parse_args(["--output", "fixture.jsonl", "--controller-pid", "123", "--profile", "another"])
        self.assertEqual(docker_context(args), "colima-another")
        self.assertEqual(docker_context(argparse.Namespace(context="explicit-worker", profile=None)), "explicit-worker")
        with self.assertRaises(ValueError):
            docker_context(argparse.Namespace(context="worker; command", profile=None))


if __name__ == "__main__":
    unittest.main()
