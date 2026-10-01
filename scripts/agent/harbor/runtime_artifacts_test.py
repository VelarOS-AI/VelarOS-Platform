import asyncio
import io
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.agent.harbor import runtime_artifacts as artifacts


class RuntimeArtifactTests(unittest.TestCase):
    def test_task_profile_selects_libc_without_guessing_from_cpu(self):
        class Environment:
            def __init__(self, output, code=0):
                self.output, self.code = output, code
            async def exec(self, **kwargs):
                return SimpleNamespace(stdout=self.output, return_code=self.code)
        for libc in ('glibc', 'musl'):
            self.assertEqual(asyncio.run(artifacts.runtime_profile(Environment('x86_64\n'+libc))), {'arch':'x64','libc':libc})
        for output in ('x86_64\n', 'x86_64\nunknown', 'riscv64\nglibc'):
            with self.assertRaises(ValueError):
                asyncio.run(artifacts.runtime_profile(Environment(output)))
        with self.assertRaises(ValueError):
            asyncio.run(artifacts.runtime_profile(Environment('x86_64\nmusl', 2)))

    def test_frozen_gnu_artifact_cannot_fall_back_on_musl(self):
        artifacts.verify_profile({'arch':'x64'}, {'arch':'x64','libc':'glibc'})
        with self.assertRaisesRegex(ValueError, 'differs'):
            artifacts.verify_profile({'arch':'x64'}, {'arch':'x64','libc':'musl'})
        with self.assertRaisesRegex(ValueError, 'differs'):
            artifacts.verify_profile({'arch':'x64','libc':'musl'}, {'arch':'arm64','libc':'musl'})
        self.assertNotEqual(artifacts.portable_path(Path('/tmp/bundle'), 'x64', 'glibc'), artifacts.portable_path(Path('/tmp/bundle'), 'x64', 'musl'))

    def test_download_checks_published_digest_and_preserves_tampered_cache(self):
        data = b'fixture-runtime'
        checksum = hashlib.sha256(data).hexdigest()
        name = f'node-v{artifacts.NODE_VERSION}-linux-x64-musl.tar.xz'
        urls = []
        def fetch(url, **kwargs):
            urls.append(url)
            return io.BytesIO((checksum+'  '+name+'\n').encode() if url.endswith('SHASUMS256.txt') else data)
        with tempfile.TemporaryDirectory() as temporary, patch.object(artifacts, 'DOWNLOADS', Path(temporary)), patch.object(artifacts.urllib.request, 'urlopen', fetch):
            path, metadata = artifacts.node_artifact('x64','musl')
            self.assertEqual(metadata['nodeSha256'], checksum)
            self.assertEqual(metadata['libc'], 'musl')
            self.assertEqual(path.read_bytes(), data)
            self.assertTrue(all(url.startswith('https://unofficial-builds.nodejs.org/') for url in urls))
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'preserve'):
                artifacts.node_artifact('x64','musl')
            self.assertEqual(path.read_bytes(), b'changed')


if __name__ == '__main__':
    unittest.main()
