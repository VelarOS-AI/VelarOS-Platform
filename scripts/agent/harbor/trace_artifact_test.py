"""Reader parity, explicit integrity errors and legacy trace compatibility."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from trace_artifact import decode_trace_artifact, read_invocation_blobs, read_trace_artifact


class TraceArtifactTests(unittest.TestCase):
    def test_legacy_and_versioned_content_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows, references, expected = [], [], []
            for status in ('pending', 'succeeded'):
                value = {'id': 'same', 'body': '原始证据\n' * 100,
                         'summary': {'status': status, 'output': '{"artifactSchema":2}'}}
                text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
                reference = {'sessionId': 'root', 'id': 'same', 'sha256': hashlib.sha256(text.encode()).hexdigest()}
                references.append(reference)
                expected.append({'sessionId': 'root', 'invocations': [value]})
                rows.append(json.dumps({'schema': 1, **reference, 'json': text}, ensure_ascii=False) + '\n')
            (root / 'trace-invocations.jsonl').write_text(''.join(rows))
            encoded = {'artifactSchema': 2, 'data': {'traces': [
                {'sessionId': 'root', 'invocations': [reference]} for reference in references]}}
            (root / 'traces.json').write_text(json.dumps(encoded))
            self.assertEqual(read_trace_artifact(root / 'traces.json'), {'traces': expected})
            self.assertEqual(decode_trace_artifact({'traces': expected}), {'traces': expected})
            with self.assertRaisesRegex(ValueError, 'Missing'):
                decode_trace_artifact(encoded)
            encoded['data']['traces'][0]['sessionId'] = 'other'
            with self.assertRaisesRegex(ValueError, 'crosses sessions'):
                decode_trace_artifact(encoded, read_invocation_blobs(root))
            (root / 'trace-invocations.jsonl').write_text(''.join(rows) + '{')
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                read_invocation_blobs(root)
            self.assertEqual(len(read_invocation_blobs(root, allow_incomplete_tail=True)), 2)
            (root / 'trace-invocations.jsonl').write_text(''.join(rows).replace('原始', '篡改'))
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                read_invocation_blobs(root)

    def test_unknown_schema_and_complete_malformed_blob_do_not_disappear(self):
        with self.assertRaisesRegex(ValueError, 'schema'):
            decode_trace_artifact({'artifactSchema': 3})
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'trace-invocations.jsonl').write_text('{}\n')
            with self.assertRaisesRegex(ValueError, 'reference'):
                read_invocation_blobs(directory, allow_incomplete_tail=True)


if __name__ == '__main__':
    unittest.main()
