import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.agent.harbor.agent import ScriptActAgent
from scripts.agent.harbor.pricing_test import pricing
from harbor.models.agent.context import AgentContext


def candidate(root):
    (root / 'run.mjs').write_text('fixture run')
    files = {'run.mjs': hashlib.sha256(b'fixture run').hexdigest()}
    digest = hashlib.sha256(b'run.mjs\0' + files['run.mjs'].encode() + b'\n').hexdigest()
    identity = {'sourceCommit': 'fixture', 'bundleFingerprint': 'fingerprint', 'modelName': 'gpt-5.6-sol',
                'reasoningEffort': 'high', 'bundleSeal': {'schemaVersion': 1, 'sha256': digest, 'filesSha256': files}}
    (root / 'identity.json').write_text(json.dumps(identity))
    return identity


class PrepareTests(unittest.TestCase):
    def test_adapter_cost_uses_frozen_model_pricing_and_retains_unknown_rates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'trajectory.json').write_text(json.dumps({'schema_version': 'ATIF-v1.8',
                'session_id': 'fixture', 'agent': {'name': 'fixture', 'version': '1'},
                'steps': [{'step_id': 1, 'source': 'user', 'message': 'fixture'}]}))
            (root / 'status.json').write_text('{}')
            usage = {'inputTokens': 1000, 'outputTokens': 100, 'cacheReadTokens': 400, 'cacheWriteTokens': 300}
            (root / 'traces.json').write_text(json.dumps({'traces': [{'decision': {'body': json.dumps({'usage': usage})}}], 'branches': []}))
            agent = object.__new__(ScriptActAgent)
            agent.logs_dir = root
            agent.identity = {'modelName': 'fixture-model', 'reasoningEffort': 'high', 'pricing': pricing()}
            context = AgentContext()
            agent.populate_context_post_run(context)
            self.assertAlmostEqual(context.cost_usd, .00486)
            self.assertEqual(context.metadata['cost_estimate']['authority'], 'gateway-request-ledger')
            original = context.model_dump()
            raw = json.loads((root / 'traces.json').read_text())
            (root / 'traces.json').write_text(json.dumps({'artifactSchema': 2, 'data': raw}))
            restored = AgentContext()
            agent.populate_context_post_run(restored)
            self.assertEqual(restored.model_dump(), original)
            del agent.identity['pricing']
            context = AgentContext()
            agent.populate_context_post_run(context)
            self.assertIsNone(context.cost_usd)
            self.assertEqual(context.n_input_tokens, 1000)

    def test_adapter_matches_the_frozen_model_and_rejects_old_or_unsealed_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = candidate(root)
            for model in ('gpt-5.6-sol', 'openai/gpt-5.6-sol'):
                agent = ScriptActAgent(root / 'logs', bundle=str(root), model_name=model, reasoning_effort='high')
                self.assertEqual(agent.identity['modelName'], 'gpt-5.6-sol')
            with self.assertRaisesRegex(ValueError, 'Requested model differs'):
                ScriptActAgent(root / 'logs', bundle=str(root), model_name='openai/gpt-6-sol', reasoning_effort='high')
            with self.assertRaisesRegex(ValueError, 'Requested reasoning effort differs'):
                ScriptActAgent(root / 'logs', bundle=str(root), model_name='openai/gpt-5.6-sol', reasoning_effort='medium')
            with self.assertRaises(TypeError):
                ScriptActAgent(root / 'logs', bundle=str(root), model_name='openai/gpt-5.6-sol')
            (root / 'run.mjs').write_text('stale runner')
            with self.assertRaisesRegex(ValueError, 'Bundle files differ'):
                ScriptActAgent(root / 'logs', bundle=str(root), model_name='openai/gpt-5.6-sol', reasoning_effort='high')

    def test_cached_portable_archive_does_not_bypass_bundle_seal(self):
        spec = importlib.util.spec_from_file_location('prepare_linux_fixture', Path(__file__).with_name('prepare-linux.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'bundle'
            root.mkdir()
            identity = candidate(root)
            archive = module.portable_path(root, 'x64', 'glibc')
            archive.write_bytes(b'fixture archive')
            archive.with_suffix('.json').write_text(json.dumps({'bundleFingerprint': 'fingerprint',
                'bundleSealSha256': identity['bundleSeal']['sha256'], 'arch': 'x64', 'libc': 'glibc',
                'sha256': hashlib.sha256(b'fixture archive').hexdigest()}))
            with patch.object(sys, 'argv', ['prepare-linux.py', '--bundle', str(root)]), patch.object(module, 'node_artifact', side_effect=AssertionError('Network must not be used')):
                module.main()
                (root / 'run.mjs').write_text('stale runner')
                with self.assertRaisesRegex(ValueError, 'Bundle files differ'):
                    module.main()


if __name__ == '__main__':
    unittest.main()
