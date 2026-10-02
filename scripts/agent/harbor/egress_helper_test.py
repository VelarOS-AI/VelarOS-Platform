"""Offline contracts for the bounded GOST HTTP response-header deadline."""
import copy
import hashlib
import importlib.util
import json
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml
from harbor.environments.docker import EGRESS_CONTROL_SIDECAR_CONTEXT_PATH
from harbor.utils.container_cache import docker_build_context_hash
from scripts.agent.harbor.repository_environment import helper_evidence

SOURCE = Path(__file__).with_name('prepare-egress.py')
spec = importlib.util.spec_from_file_location('prepare_egress_offline', SOURCE)
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

class EgressHelperTest(unittest.TestCase):
    def fixture(self, directory, timeout='900s', proof_seconds=900, revision=2):
        context = directory / 'context'; context.mkdir()
        (context / 'Dockerfile').write_text('FROM scratch\n')
        config = {'services': [{'name': 'fixture', 'handler': {'type': 'red', 'metadata': {'readTimeout': timeout, 'sniffing': True}}, 'listener': {'type': 'red'}, 'bypass': 'allowed'}], 'bypasses': [{'name': 'allowed', 'whitelist': True}]}
        (context / 'gost.yaml').write_text(yaml.safe_dump(config))
        files = {str(p.relative_to(context)): sha(p) for p in context.iterdir()}
        context_hash = docker_build_context_hash(context=context, dockerfile_path=context / 'Dockerfile', build_args={}, platform='linux/arm64')
        image = f'scriptact-bench:egress-gost-3.2.6-v{revision}--' + context_hash
        source = {'protocol': f'local-harbor-gost-3.2.6-v{revision}', 'gost_version': '3.2.6', 'image_name': image, 'files_sha256': files, 'context_hash': context_hash, 'harbor_files_sha256': {'gost.yaml': 'opaque-official-hash'}}
        if revision == 2:
            source['config_delta'] = {'kind': 'redirect_http_response_header_timeout', 'seconds': proof_seconds, 'original_harbor_config_sha256': 'opaque-official-hash', 'prepared_config_sha256': files['gost.yaml']}
        (directory / 'preparation.json').write_text(json.dumps(source))
        built = {'preparation_sha256': sha(directory / 'preparation.json'), 'image_name': image, 'platform': 'linux/arm64', 'image_id': 'synthetic'}
        (directory / 'build.json').write_text(json.dumps(built))
        return built

    def test_only_deadline_changes_in_official_policy(self):
        original = yaml.safe_load((EGRESS_CONTROL_SIDECAR_CONTEXT_PATH / 'gost.yaml').read_text())
        changed = prepare.response_header_timeout(copy.deepcopy(original))
        count = 0
        for service in changed['services']:
            if service.get('handler', {}).get('type') == 'red':
                self.assertEqual(service['handler']['metadata'].pop('readTimeout'), '900s')
                count += 1
        self.assertGreater(count, 0)
        self.assertEqual(changed, original)

    def test_missing_redirect_and_bad_metadata_reject(self):
        for config in ({'services': []}, {'services': [{'handler': {'type': 'red', 'metadata': None}}]}, None):
            with self.subTest(config=config), self.assertRaises(ValueError):
                prepare.response_header_timeout(config)

    def test_legacy_v1_identity_remains_readable(self):
        with tempfile.TemporaryDirectory() as temp:
            legacy = Path(temp); expected = self.fixture(legacy, timeout='15s', revision=1)
            before = {str(p): sha(p) for p in (legacy / 'preparation.json', legacy / 'build.json', legacy / 'context/gost.yaml')}
            self.assertEqual(helper_evidence(legacy), expected)
            self.assertEqual(before, {p: sha(p) for p in before})

    def test_v2_metadata_and_actual_deadline_both_bind(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for i, (timeout, seconds, valid) in enumerate([('900s', 900, True), ('15s', 900, False), ('900s', 15, False), ('0s', 900, False)]):
                directory = root / str(i); directory.mkdir()
                expected = self.fixture(directory, timeout, seconds)
                if valid:
                    self.assertEqual(helper_evidence(directory), expected)
                else:
                    with self.assertRaisesRegex(ValueError, 'deadline proof'):
                        helper_evidence(directory)

    def test_v2_context_tamper_rejects_before_use(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); self.fixture(directory)
            (directory / 'context/gost.yaml').write_text('services: []\n')
            with self.assertRaisesRegex(ValueError, 'context changed'):
                helper_evidence(directory)

    def test_asset_corruption_does_not_create_preparation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); assets = root / 'assets'; assets.mkdir()
            (assets / 'gost_3.2.6_linux_arm64.tar.gz').write_bytes(b'corrupt')
            (assets / 'checksums.txt').write_text('corrupt\n')
            output = root / 'new'
            with self.assertRaises(ValueError):
                prepare.prepare(output, assets)
            self.assertFalse(output.exists())

    def test_default_prepare_constructs_bound_v2_from_verified_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); assets = root / 'assets'; assets.mkdir()
            archive = assets / 'gost_3.2.6_linux_arm64.tar.gz'
            data = b'synthetic-offline-binary'
            with tarfile.open(archive, 'w:gz') as bundle:
                member = tarfile.TarInfo('gost'); member.size = len(data)
                bundle.addfile(member, io.BytesIO(data))
            checksums = assets / 'checksums.txt'; checksums.write_text(sha(archive) + '  ' + archive.name + '\n')
            with patch.dict(prepare.RELEASES, {'3.2.6': (sha(archive), sha(checksums))}):
                source = prepare.prepare(root / 'new', assets)
            self.assertEqual(source['protocol'], 'local-harbor-gost-3.2.6-v2')
            self.assertEqual(source['config_delta']['seconds'], 900)
            self.assertEqual(source['config_delta']['prepared_config_sha256'], sha(root / 'new/context/gost.yaml'))
            self.assertEqual(yaml.safe_load((root / 'new/context/gost.yaml').read_text())['services'][0]['handler']['metadata']['readTimeout'], '900s')
            self.assertEqual(source['image_name'], 'scriptact-bench:egress-gost-3.2.6-v2--' + source['context_hash'])

if __name__ == '__main__':
    unittest.main()
