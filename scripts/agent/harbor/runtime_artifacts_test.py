import asyncio
import base64
import io
import hashlib
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.agent.harbor import runtime_artifacts as artifacts


def shell_elf(interpreter, arch='x64', *, static=False):
    raw = interpreter.encode('ascii') + b'\0'
    data = bytearray(120 + len(raw))
    data[:7] = b'\x7fELF\x02\x01\x01'
    machine = {'x64': 62, 'arm64': 183}[arch]
    struct.pack_into('<HHIQQQIHHHHHH', data, 16, 3, machine, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    struct.pack_into('<IIQQQQQQ', data, 64, 1 if static else 3, 0, 120, 0, 0, len(raw), len(raw), 1)
    data[120:] = raw
    return bytes(data)


def profile_output(data, arch='x64'):
    return {'x64': 'x86_64', 'arm64': 'aarch64'}[arch] + '\nshell-elf-base64\n' + base64.b64encode(data).decode() + '\n'


class Environment:
    def __init__(self, output, code=0):
        self.output, self.code = output, code
        self.calls = []

    async def exec(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(stdout=self.output, return_code=self.code)


class RuntimeArtifactTests(unittest.TestCase):
    def test_task_profile_uses_actual_shell_with_both_libcs_installed(self):
        for arch in ('x64', 'arm64'):
            for libc in ('glibc', 'musl'):
                interpreter = artifacts.ELF_RUNTIME_INTERPRETERS[arch][libc][0]
                environment = Environment(profile_output(shell_elf(interpreter, arch), arch))
                self.assertEqual(asyncio.run(artifacts.runtime_profile(environment)), {'arch': arch, 'libc': libc})
                self.assertEqual(len(environment.calls), 1)
                self.assertEqual(environment.calls[0]['timeout_sec'], 30)
                self.assertIn('dd if=/bin/sh bs=65536 count=1', environment.calls[0]['command'])
                self.assertNotIn('getconf', environment.calls[0]['command'])
                self.assertNotIn('for loader', environment.calls[0]['command'])

    def test_profile_probe_rejects_failed_corrupt_unbounded_or_mismatched_evidence(self):
        data = shell_elf('/lib64/ld-linux-x86-64.so.2')
        for output in ('x86_64\n', 'x86_64\nmusl', 'riscv64\nshell-elf-base64\nAAAA',
                       'x86_64\nshell-elf-base64\nINVALID!', profile_output(data, 'arm64'),
                       profile_output(data + b'\0' * artifacts.SHELL_PREFIX_BYTES)):
            with self.assertRaises(ValueError):
                asyncio.run(artifacts.runtime_profile(Environment(output)))
        with self.assertRaises(ValueError):
            asyncio.run(artifacts.runtime_profile(Environment(profile_output(data), 2)))

    def test_static_unknown_and_cross_arch_interpreters_do_not_fall_back_to_loader_presence(self):
        cases = [shell_elf('/lib64/ld-linux-x86-64.so.2', static=True),
                 shell_elf('/vendor/unknown-loader'), shell_elf('/lib/ld-musl-aarch64.so.1'),
                 shell_elf('/lib/../lib64/ld-linux-x86-64.so.2')]
        for data in cases:
            with self.assertRaises(ValueError):
                artifacts.elf_interpreter(data, 'x64')

    def test_elf_parser_rejects_header_segment_bounds_and_ambiguous_interp(self):
        original = shell_elf('/lib64/ld-linux-x86-64.so.2')
        cases = [original[:63], original[:-1]]
        for offset, replacement in ((4, b'\x01'), (5, b'\x02'), (6, b'\x02'),
                                    (18, struct.pack('<H', 183)), (52, struct.pack('<H', 63)),
                                    (54, struct.pack('<H', 55)), (56, struct.pack('<H', 0)),
                                    (56, struct.pack('<H', 65535)), (96, struct.pack('<Q', 4097))):
            changed = bytearray(original)
            changed[offset:offset + len(replacement)] = replacement
            cases.append(bytes(changed))
        # Two fully readable PT_INTERP records must not silently pick the first.
        duplicate = bytearray(240)
        duplicate[:64] = original[:64]
        struct.pack_into('<H', duplicate, 56, 2)
        raw = b'/lib64/ld-linux-x86-64.so.2\0'
        for offset in (64, 120):
            struct.pack_into('<IIQQQQQQ', duplicate, offset, 3, 0, 192, 0, 0, len(raw), len(raw), 1)
        duplicate[192:192 + len(raw)] = raw
        cases.append(bytes(duplicate))
        malformed_null = bytearray(original)
        malformed_null[125] = 0
        cases.append(bytes(malformed_null))
        for data in cases:
            with self.assertRaises(ValueError):
                artifacts.elf_interpreter(data, 'x64')

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
