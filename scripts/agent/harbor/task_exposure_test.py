"""Independent evidence must be unexposed at the candidate freeze, regardless of scores."""

import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from repository_launch import validate
from task_exposure import job_observations, task_exposure


class TaskExposureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.jobs = self.root / "jobs"
        self.jobs.mkdir()
        self.manifest = {"frozen_at": "2026-09-01T01:00:00Z", "attempts": [
            {"task": "fresh", "source_job": "new-source", "replay_job": "new-replay"}],
            "evaluation": {"schema": 1, "roles": {"fresh": "held_out"}}}
        self.snapshot = {"schema": 1, "created_at": "2026-09-01T00:59:00Z", "observations": []}
        self.save()

    def save(self):
        path = self.root / "exposure.json"
        raw = json.dumps(self.snapshot).encode()
        path.write_bytes(raw)
        self.manifest["evaluation"]["exposure_snapshot"] = {
            "file": str(path), "sha256": hashlib.sha256(raw).hexdigest()}

    def job(self, name, task, at):
        job = self.jobs / name
        job.mkdir()
        (job / "config.json").write_text(json.dumps({"tasks": [{"path": "/tasks/" + task}]}))
        if at is not None:
            (job / "result.json").write_text(json.dumps({"started_at": at}))

    def test_frozen_block_stays_independent_after_its_first_participant_starts(self):
        before = copy.deepcopy(self.manifest)
        self.job("new-source", "fresh", "2026-09-01T01:00:01Z")
        result = task_exposure(self.manifest, self.jobs, require_definition=True)
        self.assertEqual(result["independent_held_out_tasks"], ["fresh"])
        self.assertEqual(self.manifest, before)

    def test_repeat_cannot_be_claimed_as_held_out_even_with_a_new_job_name(self):
        self.job("earlier-failure", "fresh", "2026-09-01T00:00:00Z")
        self.snapshot["observations"] = job_observations(self.jobs)
        self.save()
        with self.assertRaisesRegex(ValueError, "development evidence"):
            task_exposure(self.manifest, self.jobs)
        self.manifest["evaluation"]["roles"]["fresh"] = "development"
        result = task_exposure(self.manifest, self.jobs)
        self.assertEqual(result["development_tasks"], ["fresh"])
        self.assertEqual(result["independent_held_out_tasks"], [])

    def test_snapshot_cannot_omit_prior_jobs_or_rewrite_their_timestamp(self):
        self.job("prior", "elsewhere", "2026-09-01T00:00:00Z")
        with self.assertRaisesRegex(ValueError, "omits or changes"):
            task_exposure(self.manifest, self.jobs)
        self.snapshot["observations"] = job_observations(self.jobs)
        self.snapshot["observations"][0]["observed_at"] = "2026-09-01T00:01:00Z"
        self.save()
        with self.assertRaisesRegex(ValueError, "omits or changes"):
            task_exposure(self.manifest, self.jobs)

    def test_manual_exposure_and_unknown_dates_are_conservative(self):
        for date in [None, "2026-09-01T00:00:00Z"]:
            self.snapshot["observations"] = [{"task": "fresh", "source": "manual-review", "observed_at": date}]
            self.save()
            with self.assertRaisesRegex(ValueError, "development evidence"):
                task_exposure(self.manifest, self.jobs)
        self.job("interrupted", "fresh", None)
        self.snapshot["observations"] = job_observations(self.jobs)
        self.save()
        with self.assertRaisesRegex(ValueError, "development evidence"):
            task_exposure(self.manifest, self.jobs)

    def test_snapshot_hash_dates_and_task_set_are_checked(self):
        path = Path(self.manifest["evaluation"]["exposure_snapshot"]["file"])
        path.write_text(path.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "snapshot changed"):
            task_exposure(self.manifest, self.jobs)
        self.save()
        self.manifest["evaluation"]["roles"] = {}
        with self.assertRaisesRegex(ValueError, "exactly"):
            task_exposure(self.manifest, self.jobs)
        self.manifest["evaluation"]["roles"] = {"fresh": "held_out"}
        self.snapshot["created_at"] = "2026-09-01T02:00:00Z"
        self.save()
        with self.assertRaisesRegex(ValueError, "precede"):
            task_exposure(self.manifest, self.jobs)

    def test_old_reports_remain_readable_but_cannot_establish_independent_evidence(self):
        del self.manifest["evaluation"]
        result = task_exposure(self.manifest, self.jobs)
        self.assertEqual(result["status"], "unverified")
        self.assertEqual(result["unknown_tasks"], ["fresh"])
        self.assertEqual(result["independent_held_out_tasks"], [])
        with self.assertRaisesRegex(ValueError, "structured evaluation"):
            task_exposure(self.manifest, self.jobs, require_definition=True)
        with self.assertRaisesRegex(ValueError, "structured evaluation"):
            validate(self.manifest, self.manifest["attempts"][0], {})

    def test_install_only_job_and_timezone_equivalence_are_recorded(self):
        job = self.jobs / "setup"
        job.mkdir()
        (job / "lock.json").write_text(json.dumps({"created_at": "2026-09-01T08:00:00+08:00",
            "trials": [{"task": {"path": "/tasks/fresh"}, "install_only": True}]}))
        self.snapshot["observations"] = job_observations(self.jobs)
        self.snapshot["observations"][0]["observed_at"] = "2026-09-01T00:00:00Z"
        self.save()
        self.manifest["evaluation"]["roles"]["fresh"] = "development"
        self.assertEqual(task_exposure(self.manifest, self.jobs)["status"], "verified")

    def test_snapshot_cli_preserves_archived_and_manual_history_and_refuses_overwrite(self):
        prior = self.root / "previous.json"
        observations = [{"task": "archived-task", "source": "job:archived", "observed_at": None},
                        {"task": "reviewed-task", "source": "manual-review", "observed_at": "2026-09-01T00:00:00Z"}]
        prior.write_text(json.dumps({"schema": 1, "observations": observations}))
        target = self.root / "next.json"
        command = [sys.executable, str(Path(__file__).with_name("task_exposure.py")),
                   "--jobs-root", str(self.jobs), "--output", str(target), "--previous", str(prior),
                   "--observed-task", "new-review", "--observed-task", "new-review"]
        subprocess.run(command, check=True, capture_output=True)
        rows = json.loads(target.read_text())["observations"]
        self.assertEqual(rows[:2], observations)
        self.assertEqual(len(rows), 3)
        before = target.read_bytes()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual(target.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
