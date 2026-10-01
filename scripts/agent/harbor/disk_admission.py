"""Read-only batch disk admission for the dedicated local Harbor worker."""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import time
import tomllib
from pathlib import Path

MIB = 1024 ** 2
GIB = 1024 ** 3
HEADROOM = 4 * GIB
MAX_INTEGER = 2 ** 53 - 1


class AdmissionError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(value, code, message):
    if not value:
        raise AdmissionError(code, message)


def positive(value):
    return type(value) is int and 0 < value <= MAX_INTEGER


def digest(value):
    return hashlib.sha256(value).hexdigest()


def load_plan(manifest_path, expected_sha256, tasks_root, *, profile):
    require(isinstance(profile, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', profile)
            and profile != 'default', 'PROFILE_POLICY', 'An explicit named dedicated Colima profile is required')
    raw = Path(manifest_path).read_bytes()
    require(re.fullmatch(r'[a-f0-9]{64}', expected_sha256 or '') and digest(raw) == expected_sha256,
            'MANIFEST_IDENTITY', 'Manifest bytes do not match the supplied frozen SHA-256')
    manifest = json.loads(raw)
    vm = manifest.get('vm', {})
    require(vm.get('profile') == profile and positive(vm.get('cpus')) and positive(vm.get('memory_bytes')),
            'VM_POLICY', 'Frozen manifest must identify the dedicated worker and its CPU/memory identity')
    pool = manifest.get('resource_pool', {})
    require(all(positive(pool.get(k)) for k in ['max_active_attempts', 'cpus', 'memory_mb']),
            'RESOURCE_POLICY', 'Frozen resource_pool requires positive integer capacity values')
    attempts = manifest.get('attempts')
    require(isinstance(attempts, list) and attempts, 'ATTEMPTS', 'Manifest must contain attempted participants')
    rows, jobs, identities = [], set(), {}
    root = Path(tasks_root).resolve(strict=True)
    for attempt in attempts:
        task, job = attempt.get('task'), attempt.get('source_job')
        require(isinstance(task, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', task) and task not in ('.', '..'),
                'TASK_PATH', 'Invalid task metadata directory name')
        require(isinstance(job, str) and job and job not in jobs, 'ATTEMPT_IDENTITY', 'Each attempt needs a distinct source_job')
        jobs.add(job)
        path = (root / task / 'task.toml').resolve(strict=True)
        require(path.is_relative_to(root / task), 'TASK_PATH', 'Task metadata must remain within its task directory')
        metadata = path.read_bytes()
        expected = manifest.get('tasks', {}).get(task, {}).get('files_sha256', {}).get('task.toml')
        require(isinstance(expected, str) and digest(metadata) == expected,
                'TASK_METADATA_IDENTITY', 'Task resource metadata differs from frozen task.toml SHA-256')
        environment = tomllib.loads(metadata.decode('utf8')).get('environment', {})
        storage = environment.get('storage_mb')
        require(positive(storage) and storage <= MAX_INTEGER // MIB,
                'STORAGE_REQUIREMENT_UNKNOWN', 'Every task must declare positive integer environment.storage_mb in MiB; missing, zero, fractional or string values cannot be admitted')
        rows.append({'task': task, 'source_job': job, 'participant': attempt.get('participant'),
                     'storage_mib': storage, 'storage_bytes': storage * MIB})
        identities[str(path)] = expected
    chosen = sorted(rows, key=lambda r: (-r['storage_bytes'], r['source_job']))[:pool['max_active_attempts']]
    demand = sum(r['storage_bytes'] for r in chosen)
    require(demand + HEADROOM <= MAX_INTEGER, 'STORAGE_REQUIREMENT_RANGE', 'Combined disk requirement exceeds exact JSON integer range')
    return {'manifest_file': str(Path(manifest_path).resolve()), 'manifest_sha256': expected_sha256,
            'task_metadata_sha256': identities, 'vm': vm, 'max_active_attempts': pool['max_active_attempts'],
            'attempts': rows, 'selected_attempts': chosen, 'concurrent_storage_bytes': demand,
            'vm_required_bytes': demand + HEADROOM, 'fixed_headroom_bytes': HEADROOM,
            'units': 'storage_mb is interpreted as MiB (1024^2 bytes); df -Pk units are 1024 bytes',
            'policy': 'Sum the largest per-attempt demands up to max_active_attempts; equal task IDs are not deduplicated. Source/replay phases of one attempt are sequential. Existing image layers are already reflected in available space; no image-size subtraction.'}


def docker_identity(plan, host, guest):
    keys = ['ID', 'Name', 'DockerRootDir', 'OSType', 'Architecture', 'NCPU', 'MemTotal']
    require(all(k in host and k in guest for k in keys) and all(host[k] == guest[k] for k in keys),
            'DOCKER_IDENTITY', 'Explicit socket and dedicated Colima SSH must identify the same Docker daemon')
    require(type(host['NCPU']) is int and type(host['MemTotal']) is int and isinstance(host['ID'], str) and host['ID'] and host['Name'] == 'colima-' + plan['vm']['profile']
            and host['DockerRootDir'] == '/var/lib/docker' and host['OSType'] == 'linux'
            and host['NCPU'] == plan['vm']['cpus'] and host['MemTotal'] == plan['vm']['memory_bytes']
            and host['Architecture'] == plan['vm'].get('architecture'),
            'DOCKER_IDENTITY', 'Dedicated Docker identity or frozen VM hardware differs')
    # A batch-level free-space snapshot assumes no unaccounted running containers.
    require(all(type(info.get(k)) is int and info[k] == 0 for info in [host, guest] for k in ['ContainersRunning', 'ContainersPaused']),
            'WORKER_NOT_QUIESCENT', 'Batch disk admission requires no running or paused dedicated-worker containers')
    return {k: host[k] for k in keys + ['ContainersRunning', 'ContainersPaused']}


def parse_df(value):
    lines = value.strip().splitlines()
    require(len(lines) == 2 and '1024-blocks' in lines[0].split(), 'DF_FORMAT', 'Expected exactly one POSIX df -Pk filesystem in 1024-byte blocks')
    cells = lines[1].split()
    require(len(cells) == 6 and all(re.fullmatch(r'[0-9]+', s) for s in cells[1:4])
            and re.fullmatch(r'[0-9]+%', cells[4]) and cells[5].startswith('/'),
            'DF_FORMAT', 'Malformed df -Pk numeric fields or mount point')
    total, used, free = map(int, cells[1:4])
    require(total > 0 and used + free <= total and int(cells[4][:-1]) <= 100
            and total <= MAX_INTEGER // 1024,
            'DF_RANGE', 'df filesystem capacity is inconsistent or outside the exact numeric range')
    return {'filesystem': cells[0], 'mountpoint': cells[5], 'total_bytes': total * 1024,
            'used_bytes': used * 1024, 'available_bytes': free * 1024, 'unit_bytes': 1024}


def host_disks(plan, backing, artifacts):
    groups = {}
    for role, observation in [('colima_backing', backing), ('bench_artifacts', artifacts)]:
        device = observation['device']
        require(type(device) is int and device >= 0 and all(type(observation.get(k)) is int and 0 <= observation[k] <= MAX_INTEGER for k in ['total_bytes', 'free_bytes']),
                'HOST_DISK_FORMAT', 'Host disk usage must contain nonnegative exact byte values and device identity')
        require(0 < observation['total_bytes'] and observation['free_bytes'] <= observation['total_bytes'], 'HOST_DISK_RANGE', 'Host disk free space exceeds capacity')
        entry = groups.setdefault(device, {'device': device, 'roles': [], 'paths': [], 'free_bytes': observation['free_bytes'], 'total_bytes': observation['total_bytes'], 'growth_bytes': 0})
        require(entry['total_bytes'] == observation['total_bytes'], 'HOST_DISK_IDENTITY', 'Same host filesystem reported inconsistent capacity')
        entry['free_bytes'] = min(entry['free_bytes'], observation['free_bytes'])
        entry['roles'].append(role)
        entry['paths'].append(observation['path'])
        # Shared backing/artifacts filesystem counts task growth once, not once per path.
        if role == 'colima_backing':
            entry['growth_bytes'] = plan['concurrent_storage_bytes']
    for entry in groups.values():
        entry['headroom_bytes'] = HEADROOM
        entry['required_bytes'] = entry['growth_bytes'] + HEADROOM
        entry['sufficient'] = entry['free_bytes'] >= entry['required_bytes']
    return list(groups.values())


def probe(manifest_path, expected_sha256, tasks_root, host_path, *, profile, colima_home, docker_config):
    evidence = {'schema': 1, 'status': 'blocked', 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'script_sha256': digest(Path(__file__).read_bytes()), 'requested_manifest_sha256': expected_sha256, 'commands': [],
                'limitations': ['Read-only point-in-time admission; not a disk quota, reservation or race-free lease.',
                    'Caller must serialize admission with dispatch and recheck immediately before launch; later disk growth can still exhaust space.',
                    'Docker backend does not enforce task storage_mb. This policy conservatively reserves it as incremental writable demand.',
                    'Host fixed headroom covers artifacts outside VM; it is not a bound on arbitrarily large logs.']}
    try:
        plan = load_plan(manifest_path, expected_sha256, tasks_root, profile=profile)
        evidence['plan'] = plan
        evidence['manifest_sha256'] = plan['manifest_sha256']
        colima_root = Path(colima_home).resolve(strict=True)
        docker_config_path = Path(docker_config).resolve(strict=True)
        require(colima_root.is_dir() and docker_config_path.is_dir(), 'ENVIRONMENT_PATH', 'Colima home and Docker configuration must be existing directories')
        socket = colima_root / profile / 'docker.sock'
        backing = colima_root / '_lima/_disks' / ('colima-' + profile) / 'datadisk'
        instance = colima_root / '_lima' / ('colima-' + profile)
        require(stat.S_ISSOCK(socket.stat().st_mode), 'DOCKER_SOCKET', 'Dedicated Colima Docker socket is unavailable')
        require(backing.is_file() and (backing.parent / 'in_use_by').resolve(strict=True) == instance.resolve(strict=True),
                'COLIMA_BACKING_IDENTITY', 'Dedicated Colima data disk ownership could not be verified')
        artifacts = Path(host_path).resolve(strict=True)
        require(artifacts.is_dir(), 'HOST_PATH', 'Artifact host path must be an existing directory')
        env = {key: os.environ[key] for key in ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR'] if key in os.environ}
        env.update({'LC_ALL': 'C', 'LANG': 'C', 'DOCKER_CONFIG': str(docker_config_path), 'COLIMA_HOME': str(colima_root)})
        evidence['environment_paths'] = {'profile': profile, 'colima_home': str(colima_root), 'docker_config': str(docker_config_path), 'socket': str(socket), 'backing': str(backing.resolve()), 'artifacts': str(artifacts)}
        def command(args):
            started = time.monotonic()
            try:
                result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=30, check=False)
            except subprocess.TimeoutExpired:
                raise AdmissionError('PROBE_TIMEOUT', 'Read-only disk identity probe exceeded 30 seconds') from None
            evidence['commands'].append({'args': args, 'exit_code': result.returncode,
                'seconds': time.monotonic() - started, 'stdout_sha256': digest(result.stdout.encode())})
            require(result.returncode == 0, 'PROBE_COMMAND_FAILED', 'Read-only disk identity command failed; no admission granted')
            return result.stdout
        host = json.loads(command(['docker', '--host', 'unix://' + str(socket), 'info', '--format', '{{json .}}']))
        guest = json.loads(command(['colima', '-p', profile, 'ssh', '--', 'docker', 'info', '--format', '{{json .}}']))
        evidence['docker'] = docker_identity(plan, host, guest)
        evidence['vm_disk'] = parse_df(command(['colima', '-p', profile, 'ssh', '--', 'df', '-Pk', '/var/lib/docker']))
        def disk(path):
            usage = shutil.disk_usage(path)
            return {'path': str(path.resolve()), 'device': path.stat().st_dev, 'total_bytes': usage.total, 'free_bytes': usage.free}
        evidence['host_filesystems'] = host_disks(plan, disk(backing), disk(artifacts))
        # Re-read only metadata to reject mutation during the snapshot.
        require(plan == load_plan(manifest_path, expected_sha256, tasks_root, profile=profile), 'PLAN_CHANGED', 'Frozen resources changed during admission')
        blockers = []
        if evidence['vm_disk']['available_bytes'] < plan['vm_required_bytes']:
            blockers.append('VM_DISK_INSUFFICIENT')
        if any(not row['sufficient'] for row in evidence['host_filesystems']):
            blockers.append('HOST_DISK_INSUFFICIENT')
        evidence['blockers'] = blockers
        if blockers:
            raise AdmissionError('DISK_INSUFFICIENT', 'Available bytes do not cover concurrent task storage plus fixed 4 GiB headroom')
        evidence['status'] = 'passed'
    except AdmissionError as error:
        evidence['error'] = {'code': error.code, 'message': str(error)}
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        evidence['error'] = {'code': 'PROBE_READ_ERROR', 'type': type(error).__name__, 'message': 'Required metadata, Docker identity or disk state could not be read and validated'}
    evidence['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--tasks-root', type=Path, required=True)
    parser.add_argument('--host-path', type=Path, required=True)
    parser.add_argument('--profile', required=True, help='Named dedicated profile matching frozen vm.profile')
    parser.add_argument('--colima-home', type=Path, required=True, help='Explicit Colima state root')
    parser.add_argument('--docker-config', type=Path, required=True, help='Explicit Docker CLI configuration directory')
    parser.add_argument('--output', type=Path, required=True, help='New exclusive evidence directory')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    result = probe(args.manifest, args.manifest_sha256, args.tasks_root, args.host_path,
                   profile=args.profile, colima_home=args.colima_home, docker_config=args.docker_config)
    with (args.output / 'result.json').open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'status': result['status'], 'result': str((args.output / 'result.json').resolve()), 'error_code': result.get('error', {}).get('code')}))
    return 0 if result['status'] == 'passed' else 2


if __name__ == '__main__':
    raise SystemExit(main())
