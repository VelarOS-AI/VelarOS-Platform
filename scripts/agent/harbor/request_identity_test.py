import json
import tempfile
import unittest
from pathlib import Path
from request_identity import attributed_requests, prepare_attempt_environment, validate_request_ledger, verify_unique_attribution


class IdentityTests(unittest.TestCase):
    def test_overlapping_attempts_use_identity_including_late_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []
            jobs = []
            for name in ('a', 'b'):
                job = root / name
                (job / 'trial').mkdir(parents=True)
                (job / 'trial/config.json').write_text('{}')
                identity = dict(campaignId='campaign', candidateId='candidate', participantId='scriptact',
                    taskId='same-task', attemptId=name, jobId=name, phase='source')
                (job / 'request-identity.json').write_text(json.dumps(identity))
                calls.append({'id': name, 'identity': identity, 'startedAt': '2030-01-01T00:00:00Z'})
                jobs.append(job)
            for job in jobs:
                owned, metadata = attributed_requests(job, job / 'trial', {'task_name': 'same-task'}, {}, calls)
                self.assertEqual([call['id'] for call in owned], [job.name])
                self.assertEqual(metadata['mode'], 'identity')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                validate_request_ledger(calls + calls[:1])
            (jobs[0] / 'request-identity.json').unlink()
            with self.assertRaisesRegex(ValueError, 'manifest is missing'):
                attributed_requests(jobs[0], jobs[0] / 'trial', {}, {}, calls)

    def test_unidentified_parallel_and_duplicate_attribution_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'explicit request identities'):
                attributed_requests(Path(directory), None, {}, {'n_concurrent_trials': 2}, [])
        with self.assertRaisesRegex(ValueError, 'multiple trials'):
            verify_unique_attribution([{'trials': [dict(result=owner, request_attribution={'request_ids': ['r']})
                for owner in ('a', 'b')]}])

    def test_attempt_secrets_stay_private_and_controller_environment_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            admin = root / 'controller'
            admin.write_text('fixture-secret')
            original = {'SCRIPTACT_BENCH_TOKEN_FILE': str(admin), 'OPENAI_API_KEY': 'fixture-secret'}
            identity = dict(campaignId='campaign', candidateId='candidate', participantId='scriptact',
                taskId='task', attemptId='attempt', jobId='job', phase='source')
            scoped = prepare_attempt_environment(original, identity, root / 'private')
            self.assertEqual(original['OPENAI_API_KEY'], 'fixture-secret')
            self.assertTrue(scoped['OPENAI_API_KEY'].startswith('sa1.'))
            self.assertEqual(Path(scoped['SCRIPTACT_BENCH_TOKEN_FILE']).stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                prepare_attempt_environment(original, identity, root / 'private')

if __name__ == '__main__':
    unittest.main()
