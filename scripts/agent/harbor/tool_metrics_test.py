import json
import tempfile
import unittest
from pathlib import Path
from metrics import agent_metrics
from tool_metrics import aggregate_tool_usage


class ToolStatisticsTests(unittest.TestCase):
    def test_session_scoping_dedup_terminal_status_and_kernel_timings(self):
        def item(status, lifecycle=None):
            raw = {'prepared': {'sessionId': 'root'}, 'receipt': {'lifecycle': lifecycle or {}}}
            return {'id': 'same', 'executionId': 'execute', 'body': json.dumps(raw), 'summary': {
                'moduleId': 'velaros:files', 'operation': 'read', 'status': status,
                'effect': 'none', 'input': 'SENSITIVE_ARGUMENT', 'output': 'SENSITIVE_OUTPUT'}}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'agent').mkdir()
            finished = item('succeeded', {'reservedAt': '2030-01-01T00:00:00Z',
                'startedAt': '2030-01-01T00:00:01Z', 'settledAt': '2030-01-01T00:00:03Z'})
            (directory / 'agent/traces.json').write_text(json.dumps({
                'traces': [{'sessionId': 'root', 'invocations': [item('pending')]},
                           {'sessionId': 'root', 'invocations': [finished]},
                           {'sessionId': 'root', 'invocations': [item('pending')]}],
                'branches': [{'kind': 'child', 'turns': [{'sessionId': 'child', 'invocations': [item('cancelled')]}]}]}))
            measured = agent_metrics(directory)
            self.assertEqual(measured['tool_calls'], 2)
            usage = measured['tool_usage']
            row = usage['operations'][0]
            self.assertEqual(row['calls'], 2)
            self.assertEqual(row['statuses']['succeeded'], 1)
            self.assertEqual(row['statuses']['cancelled'], 1)
            self.assertEqual(row['started'], 1)
            self.assertEqual(row['started_unknown'], 1)
            self.assertEqual(row['duration_seconds']['p95'], 2)
            self.assertEqual(row['duration_unknown'], 1)
            self.assertNotIn('SENSITIVE_', json.dumps(usage))
            aggregation = aggregate_tool_usage([{'task': 'a', 'agent_metrics': measured},
                                               {'task': 'b', 'agent_metrics': None}])
            self.assertEqual(aggregation['unknown_attempts'], 1)
            self.assertEqual(aggregation['operations'][0]['task_coverage'], 1)

    def test_discovery_and_actual_operations_are_distinct(self):
        from tool_metrics import scriptact_operations
        result = scriptact_operations({
            'discovery': {'summary': {'moduleId': 'velaros:modules', 'operation': 'list', 'status': 'succeeded'}},
            'read': {'summary': {'moduleId': 'velaros:files', 'operation': 'read', 'status': 'failed'}},
        })
        self.assertEqual(result['calls'], 2)
        self.assertEqual(sum(row['discovery'] for row in result['operations']), 1)
        self.assertTrue(all(row['started_unknown'] == 1 for row in result['operations']))

if __name__ == '__main__':
    unittest.main()
