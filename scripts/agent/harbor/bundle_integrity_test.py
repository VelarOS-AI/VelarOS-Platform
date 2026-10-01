import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.agent.harbor.bundle_integrity import verify_bundle


class BundleIntegrityTests(unittest.TestCase):
    def seal(self, root):
        helper = Path(__file__).with_name('bundle-integrity.mjs').resolve().as_uri()
        script = f'import {{ createBundleSeal }} from {json.dumps(helper)}; console.log(JSON.stringify(await createBundleSeal(process.argv[1])))'
        seal = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, str(root)], text=True))
        identity = {'bundleFingerprint': 'fixture', 'bundleSeal': seal}
        (root / 'identity.json').write_text(json.dumps(identity))
        return identity

    def test_seal_cross_language_and_dependency_cache_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '你好.mjs').write_text('export const current = true')
            (root / 'packages').mkdir()
            (root / 'packages' / 'module.mjs').write_text('export default 1')
            (root / 'node_modules').mkdir()
            (root / 'node_modules' / 'cache').write_text('ignored')
            identity = self.seal(root)
            self.assertEqual(verify_bundle(root), identity)
            (root / 'node_modules' / 'cache').write_text('changed cache')
            self.assertEqual(verify_bundle(root), identity)

    def test_changed_missing_and_added_files_are_rejected(self):
        for mutation in ('changed', 'missing', 'added'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'run.mjs').write_text('current')
                self.seal(root)
                if mutation == 'changed':
                    (root / 'run.mjs').write_text('stale')
                elif mutation == 'missing':
                    (root / 'run.mjs').unlink()
                else:
                    (root / 'old-tool-schema.mjs').write_text('stale')
                with self.assertRaisesRegex(ValueError, 'Bundle'):
                    verify_bundle(root)

    def test_unsealed_and_symlink_bundles_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'identity.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'Bundle'):
                verify_bundle(root)
            self.seal(root)
            (root / 'unexpected-link').symlink_to('/tmp')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                verify_bundle(root)

    def test_seal_digest_itself_is_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = self.seal(root)
            identity['bundleSeal']['sha256'] = hashlib.sha256(b'wrong').hexdigest()
            (root / 'identity.json').write_text(json.dumps(identity))
            with self.assertRaisesRegex(ValueError, 'Bundle seal'):
                verify_bundle(root)


if __name__ == '__main__':
    unittest.main()
