"""Offline admission boundaries; no real Docker, Colima, network or model calls."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

if __package__:
    from . import disk_admission as check
else:
    import disk_admission as check

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


class DiskAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='velaros-disk-admission-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.tasks = self.root / 'tasks'
        self.tasks.mkdir()
        self.manifest_path = self.root / 'manifest.json'
        self.profile = 'disk-audit-test'
        self.manifest = {'vm': {'profile': self.profile, 'cpus': 4, 'memory_bytes': 10 * check.GIB, 'architecture': 'aarch64'},
                         'resource_pool': {'max_active_attempts': 2, 'cpus': 2, 'memory_mb': 8192}, 'tasks': {}, 'attempts': []}
        self.add_task('same', 10240)
        self.manifest['attempts'] = [{'task': 'same', 'source_job': f'job-{i}', 'participant': f'agent-{i}'} for i in range(2)]
        self.freeze()
        self.home = self.root / 'home'
        self.instance = self.home / ('.colima/_lima/colima-' + self.profile)
        self.instance.mkdir(parents=True)
        self.backing = self.home / ('.colima/_lima/_disks/colima-' + self.profile + '/datadisk')
        self.backing.parent.mkdir(parents=True)
        self.backing.write_bytes(b'fixture')
        (self.backing.parent / 'in_use_by').symlink_to(self.instance, target_is_directory=True)
        self.socket_path = self.home / ('.colima/' + self.profile + '/docker.sock')
        self.socket_path.parent.mkdir(parents=True)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        self.docker_config = self.root / 'docker-config'
        self.docker_config.mkdir()
        self.info = {'ID': 'same-daemon', 'Name': 'colima-' + self.profile, 'DockerRootDir': '/var/lib/docker',
                     'OSType': 'linux', 'Architecture': 'aarch64', 'NCPU': 4, 'MemTotal': 10 * check.GIB,
                     'ContainersRunning': 0, 'ContainersPaused': 0}
        self.df = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 50331648 25165824 25165824 50% /var/lib/docker\n'
        self.commands = []

    def add_task(self, task, storage):
        directory = self.tasks / task
        directory.mkdir(exist_ok=True)
        value = '' if storage is None else 'storage_mb = ' + (json.dumps(storage)) + '\n'
        raw = ('[environment]\n' + value).encode()
        (directory / 'task.toml').write_bytes(raw)
        self.manifest['tasks'][task] = {'files_sha256': {'task.toml': check.digest(raw)}}

    def freeze(self):
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.sha = check.digest(self.manifest_path.read_bytes())

    def plan(self):
        return check.load_plan(self.manifest_path, self.sha, self.tasks, profile=self.profile)

    def fake_command(self, args, **kwargs):
        self.commands.append(args)
        self.assertEqual(kwargs['timeout'], 30)
        self.assertNotIn('DOCKER_CONTEXT', kwargs['env'])
        self.assertNotIn('DOCKER_HOST', kwargs['env'])
        self.assertEqual(kwargs['env']['COLIMA_HOME'], str(self.home / '.colima'))
        self.assertEqual(kwargs['env']['DOCKER_CONFIG'], str(self.docker_config))
        return SimpleNamespace(returncode=0, stdout=self.df if 'df' in args else json.dumps(self.info))

    def probe(self, command=None, free=None):
        # Only socket mode needs a fake, the disk layout/owner symlink are real temporary files.
        original_stat = Path.stat
        def path_stat(path, *args, **kwargs):
            if path == self.socket_path:
                return SimpleNamespace(st_mode=0o140000)
            return original_stat(path, *args, **kwargs)
        with patch.object(Path, 'stat', path_stat), \
             patch.object(check.subprocess, 'run', side_effect=command or self.fake_command), \
             patch.object(check.shutil, 'disk_usage', return_value=SimpleNamespace(total=100 * check.GIB, free=24 * check.GIB if free is None else free)):
            return check.probe(self.manifest_path, self.sha, self.tasks, self.artifacts, profile=self.profile, colima_home=self.home / '.colima', docker_config=self.docker_config)

    def test_parameterized_profile_must_match_frozen_named_worker(self):
        for profile in ['default', '../worker', '', 'another-worker']:
            with self.subTest(profile=profile), self.assertRaises(check.AdmissionError):
                check.load_plan(self.manifest_path, self.sha, self.tasks, profile=profile)
        result = self.probe()
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['environment_paths']['profile'], self.profile)
        self.assertEqual(result['environment_paths']['colima_home'], str(self.home / '.colima'))
        self.assertTrue(all(self.profile in command for command in self.commands if command[0] == 'colima'))

    def test_script_and_module_cli_write_fail_closed_evidence_without_external_commands(self):
        for index, entry in enumerate([[sys.executable, str(HERE / 'disk_admission.py')],
                                       [sys.executable, '-m', 'scripts.agent.harbor.disk_admission']]):
            output = self.root / f'cli-{index}'
            command = entry + ['--manifest', str(self.manifest_path), '--manifest-sha256', '0' * 64,
                '--tasks-root', str(self.tasks), '--host-path', str(self.artifacts), '--profile', self.profile,
                '--colima-home', str(self.home / '.colima'), '--docker-config', str(self.docker_config), '--output', str(output)]
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, result.stderr)
            evidence = json.loads((output / 'result.json').read_text())
            self.assertEqual(evidence['error']['code'], 'MANIFEST_IDENTITY')
            self.assertEqual(evidence['commands'], [])
            self.assertNotIn('manifest_sha256', evidence)

    def test_same_task_two_participants_reserve_two_demands(self):
        p = self.plan()
        self.assertEqual(len(p['selected_attempts']), 2)
        self.assertEqual(p['concurrent_storage_bytes'], 20 * check.GIB)
        self.assertEqual(p['vm_required_bytes'], 24 * check.GIB)

    def test_largest_demands_up_to_slot_count_without_cpu_optimism(self):
        self.add_task('large', 20480)
        self.manifest['attempts'].append({'task': 'large', 'source_job': 'third'})
        self.freeze()
        self.assertEqual(self.plan()['concurrent_storage_bytes'], 30 * check.GIB)

    def test_unknown_or_invalid_storage_fails_closed(self):
        for value in [None, 0, -1, True, '10240', 10.5, check.MAX_INTEGER]:
            with self.subTest(value=value):
                self.add_task('same', value)
                self.freeze()
                with self.assertRaises(check.AdmissionError) as context:
                    self.plan()
                self.assertEqual(context.exception.code, 'STORAGE_REQUIREMENT_UNKNOWN')

    def test_manifest_hash_mismatch(self):
        with self.assertRaises(check.AdmissionError) as context:
            check.load_plan(self.manifest_path, '0' * 64, self.tasks, profile=self.profile)
        self.assertEqual(context.exception.code, 'MANIFEST_IDENTITY')

    def test_task_resource_hash_mismatch(self):
        (self.tasks / 'same/task.toml').write_text('[environment]\nstorage_mb=1\n')
        with self.assertRaises(check.AdmissionError) as context:
            self.plan()
        self.assertEqual(context.exception.code, 'TASK_METADATA_IDENTITY')

    def test_task_traversal_and_duplicate_attempt_rejected(self):
        for field, value in [('task', '../outside'), ('source_job', 'job-0')]:
            old = self.manifest['attempts'][1][field]
            self.manifest['attempts'][1][field] = value
            self.freeze()
            with self.assertRaises(check.AdmissionError):
                self.plan()
            self.manifest['attempts'][1][field] = old

    def test_capacity_bool_fraction_and_zero_rejected(self):
        for value in [True, 0, 1.5, '2']:
            self.manifest['resource_pool']['max_active_attempts'] = value
            self.freeze()
            with self.assertRaises(check.AdmissionError):
                self.plan()

    def test_shared_host_filesystem_growth_counted_once(self):
        row = {'path': 'a', 'device': 1, 'total_bytes': 100 * check.GIB, 'free_bytes': 24 * check.GIB}
        result = check.host_disks(self.plan(), row, {**row, 'path': 'b'})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['required_bytes'], 24 * check.GIB)
        self.assertTrue(result[0]['sufficient'])
        result = check.host_disks(self.plan(), row, {**row, 'free_bytes': 24 * check.GIB - 1})
        self.assertFalse(result[0]['sufficient'])

    def test_distinct_host_filesystems_reserve_backing_and_artifact_headroom(self):
        row = {'path': 'a', 'device': 1, 'total_bytes': 100 * check.GIB, 'free_bytes': 24 * check.GIB}
        result = check.host_disks(self.plan(), row, {**row, 'path': 'b', 'device': 2, 'free_bytes': 4 * check.GIB - 1})
        self.assertEqual([r['required_bytes'] for r in result], [24 * check.GIB, 4 * check.GIB])
        self.assertFalse(result[1]['sufficient'])

    def test_df_units_exact_and_bad_formats_fail(self):
        self.assertEqual(check.parse_df(self.df)['available_bytes'], 24 * check.GIB)
        for value in ['', self.df.replace('1024-blocks', '1K-blocks'), self.df.replace('25165824 50%', '-1 50%'),
                      self.df.replace('25165824 50%', 'NaN 50%'), self.df + self.df.splitlines()[1],
                      self.df.replace('50331648', '1'), self.df.replace('50%', '101%')]:
            with self.subTest(value=value), self.assertRaises(check.AdmissionError):
                check.parse_df(value)

    def test_identity_wrong_daemon_root_hardware_or_active_worker_rejected(self):
        for field, value in [('ID', 'other'), ('DockerRootDir', '/wrong'), ('NCPU', True), ('MemTotal', 1),
                             ('Name', 'other'), ('Architecture', 'amd64'), ('ContainersRunning', 1), ('ContainersPaused', 1)]:
            changed = {**self.info, field: value}
            with self.subTest(field=field), self.assertRaises(check.AdmissionError):
                check.docker_identity(self.plan(), changed, changed if field != 'ID' else self.info)

    def test_guest_container_started_between_identity_reads_blocks(self):
        with self.assertRaises(check.AdmissionError) as context:
            check.docker_identity(self.plan(), self.info, {**self.info, 'ContainersRunning': 1})
        self.assertEqual(context.exception.code, 'WORKER_NOT_QUIESCENT')

    def test_host_numeric_values_are_not_coerced(self):
        row = {'path': 'a', 'device': 1, 'total_bytes': 100 * check.GIB, 'free_bytes': 24 * check.GIB}
        for value in [None, True, '1000', float('nan'), -1]:
            with self.subTest(value=value), self.assertRaises(check.AdmissionError):
                check.host_disks(self.plan(), {**row, 'free_bytes': value}, row)

    def test_cli_blocked_evidence_persisted_and_cannot_be_overwritten(self):
        output = self.root / 'new-evidence'
        args = ['disk_admission.py', '--profile', self.profile, '--colima-home', str(self.home / '.colima'), '--docker-config', str(self.docker_config), '--manifest', str(self.manifest_path), '--manifest-sha256', self.sha,
                '--tasks-root', str(self.tasks), '--host-path', str(self.artifacts), '--output', str(output)]
        result = {'status': 'blocked', 'error': {'code': 'PROBE_READ_ERROR'}}
        with patch('sys.argv', args), patch.object(check, 'probe', return_value=result):
            self.assertEqual(check.main(), 2)
        self.assertEqual(json.loads((output / 'result.json').read_text()), result)
        with patch('sys.argv', args), patch.object(check, 'probe') as probe:
            with self.assertRaises(FileExistsError):
                check.main()
            probe.assert_not_called()
        self.assertEqual(json.loads((output / 'result.json').read_text()), result)

    def test_full_probe_boundary_passes_and_uses_only_three_read_commands(self):
        result = self.probe()
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['manifest_sha256'], self.sha)
        self.assertEqual(len(self.commands), 3)
        self.assertEqual(self.commands[-1][-3:], ['df', '-Pk', '/var/lib/docker'])
        self.assertTrue(all('info' in command or 'df' in command for command in self.commands))

    def test_vm_shortfall_and_host_shortfall_are_both_retained(self):
        self.df = self.df.replace('25165824 50%', '25165823 50%')
        result = self.probe(free=24 * check.GIB - 1)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['blockers'], ['VM_DISK_INSUFFICIENT', 'HOST_DISK_INSUFFICIENT'])

    def test_command_failure_timeout_and_json_failure_fail_closed(self):
        for behavior, code in [(lambda *a, **k: SimpleNamespace(returncode=1, stdout=''), 'PROBE_COMMAND_FAILED'),
                               (lambda *a, **k: SimpleNamespace(returncode=0, stdout='invalid'), 'PROBE_READ_ERROR'),
                               (lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired('fixture', 30)), 'PROBE_TIMEOUT')]:
            with self.subTest(code=code):
                result = self.probe(command=behavior)
                self.assertEqual(result['status'], 'blocked')
                self.assertEqual(result['error']['code'], code)

    def test_wrong_backing_owner_rejected_before_any_command(self):
        owner = self.backing.parent / 'in_use_by'
        owner.unlink()
        owner.symlink_to(self.root)
        self.assertEqual(self.probe()['error']['code'], 'COLIMA_BACKING_IDENTITY')
        self.assertEqual(self.commands, [])

    def test_metadata_mutation_during_probe_fails_closed(self):
        def command(args, **kwargs):
            result = self.fake_command(args, **kwargs)
            if 'df' in args:
                (self.tasks / 'same/task.toml').write_text('[environment]\nstorage_mb=1\n')
            return result
        result = self.probe(command=command)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['error']['code'], 'TASK_METADATA_IDENTITY')

    def test_host_read_failure_does_not_default_to_infinite_space(self):
        with patch.object(check, 'host_disks', side_effect=OSError('fixture')):
            result = self.probe()
        self.assertEqual(result['error']['code'], 'PROBE_READ_ERROR')

    def test_cli_refuses_existing_evidence_directory_without_probe(self):
        args = ['disk_admission.py', '--profile', self.profile, '--colima-home', str(self.home / '.colima'), '--docker-config', str(self.docker_config), '--manifest', str(self.manifest_path), '--manifest-sha256', self.sha,
                '--tasks-root', str(self.tasks), '--host-path', str(self.artifacts), '--output', str(self.artifacts)]
        with patch('sys.argv', args), patch.object(check, 'probe') as probe:
            with self.assertRaises(FileExistsError):
                check.main()
            probe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
