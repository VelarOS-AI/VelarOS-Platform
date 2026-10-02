"""Evidence accounting: unknown usage, weighted caching, and failed-attempt costs."""

import unittest
import json
import tempfile
from pathlib import Path

from metrics import aggregate_trials, agent_metrics, compare_jobs, distribution, environment_evidence, history_cache_metrics, prompt_layout_metrics, request_metrics, tool_environment_diagnostics, trial_infrastructure_issue, verifier_infrastructure_issue
from report import markdown, settlement_tail, summarize, summarize_cohort


def call(inputs, cached, cost, written=0):
    return {"status": "http-200", "estimatedUsd": cost,
            "usage": {"input_tokens": inputs, "output_tokens": 20,
                      "input_tokens_details": {"cached_tokens": cached, "cache_write_tokens": written}}}


class MetricsTests(unittest.TestCase):
    def test_structured_stream_and_transport_failures_remain_distinct_from_http_status_and_usage(self):
        rows = [call(100, 50, .1),
                {"status": "http-200-interrupted", "estimatedUsd": None, "usage": None,
                 "failure": {"causeCode": "ECONNRESET", "message": "PRIVATE_BODY"}},
                {"status": "unknown", "estimatedUsd": None,
                 "failure": {"name": "TimeoutError", "message": "PRIVATE_BODY"}},
                {"status": "http-503", "estimatedUsd": None},
                {"status": "reserved", "estimatedUsd": None}]
        result = request_metrics(rows)
        self.assertEqual(result["request_status_counts"],
                         {"http-200": 1, "http-200-interrupted": 1, "unknown": 1, "http-503": 1, "reserved": 1})
        self.assertEqual(result["request_failure_counts"],
                         {"model_transport_failed": 2, "model_service_unavailable": 1})
        self.assertEqual(result["transport_failure_code_counts"], {"ECONNRESET": 1, "TimeoutError": 1})
        self.assertEqual(result["unknown_cost_requests"], 4)
        self.assertEqual(result["known_cost_usd"], .1)
        self.assertIsNone(result["input_tokens"])
        self.assertNotIn("PRIVATE_BODY", json.dumps(result))

    def test_reference_price_is_an_estimate_without_changing_usage_or_legacy_fields(self):
        original = call(100, 50, .2)
        reference = {**original, "pricingBasis": {"kind": "reference_only", "source": "official reference rates",
                                                "upstreamBaseURL": "https://provider.example/v1"}}
        legacy, measured = request_metrics([original]), request_metrics([reference])
        self.assertNotIn("pricing_basis", legacy)
        self.assertNotIn("actual_provider_cost_usd", legacy)
        self.assertEqual({key: measured[key] for key in legacy}, legacy)
        self.assertIsNone(measured["actual_provider_cost_usd"])
        self.assertEqual(measured["pricing_basis"]["kind"], "reference_only")
        self.assertEqual(measured["pricing_basis"]["interpretation"], "参考价格估算，实际扣费未知")
        group = measured["pricing_basis"]["groups"][0]
        self.assertEqual(group["known_estimated_cost_usd"], .2)
        self.assertEqual(group["upstream_base_url"], "https://provider.example/v1")

    def test_mixed_reference_provider_and_legacy_prices_stay_separate_through_aggregation(self):
        reference = {**call(100, 50, .2), "pricingBasis": {"kind": "reference_only", "source": "reference"}}
        provider = {**call(200, 0, .3), "pricingBasis": {"kind": "provider_rates", "source": "provider rates"}}
        unknown = {"status": "reserved", "estimatedUsd": None, "pricingBasis": reference["pricingBasis"]}
        legacy = call(50, 0, .4)
        metrics = request_metrics([reference, provider, unknown, legacy])
        self.assertEqual(metrics["pricing_basis"]["kind"], "mixed")
        groups = {group["kind"]: group for group in metrics["pricing_basis"]["groups"]}
        self.assertEqual(groups["reference_only"]["requests"], 2)
        self.assertEqual(groups["reference_only"]["unknown_estimate_requests"], 1)
        self.assertEqual(groups["reference_only"]["known_estimated_cost_usd"], .2)
        self.assertEqual(groups["provider_rates"]["known_estimated_cost_usd"], .3)
        self.assertEqual(groups["legacy_unspecified"]["known_estimated_cost_usd"], .4)
        trials = [{"score": 1, "exception": None, "agent_seconds": 1,
                   "metrics": request_metrics(rows)} for rows in ([reference, unknown], [provider], [legacy])]
        combined = aggregate_trials(trials)
        self.assertEqual(combined["pricing_basis"], metrics["pricing_basis"])
        self.assertIsNone(combined["actual_provider_cost_usd"])
        self.assertAlmostEqual(combined["known_cost_usd"], .9)
        self.assertEqual(request_metrics([provider])["pricing_basis"]["kind"], "provider_rates")
        self.assertIsNone(request_metrics([provider])["actual_provider_cost_usd"], "rate cards do not prove paid charges")

    def test_comparison_discloses_estimate_basis_and_keeps_failed_attempt_groups(self):
        def job(name, kind, cost):
            measured = request_metrics([{**call(100, 50, cost), "pricingBasis": {"kind": kind, "source": name}}])
            trial = {"task": "same", "score": 1, "exception": None, "agent_seconds": 1, "metrics": measured}
            return {"job": name, "planned": 1, "completed": 1, "trials": [trial]}
        reference = job("reference", "reference_only", .2)
        candidate = job("provider", "provider_rates", .1)
        candidate["completed_source_usage"] = [candidate["trials"][0], {"agent_seconds": 3,
            "metrics": request_metrics([{**call(50, 0, .5), "pricingBasis": {
                "kind": "provider_rates", "source": "provider"}}])}]
        result = compare_jobs(reference, candidate)
        self.assertEqual(result["efficiency_cost_basis"], "estimated_costs_not_actual_provider_charges")
        self.assertEqual(result["pricing_basis"]["kind"], "mixed")
        self.assertIsNone(result["actual_provider_cost_usd"])
        self.assertAlmostEqual(result["candidate_over_reference"]["cost_usd"], .5)
        total = result["completed_attempt_totals"]["candidate"]
        self.assertEqual(total["pricing_basis"]["groups"][0]["requests"], 2)
        self.assertAlmostEqual(total["known_cost_usd"], .6)
        self.assertIsNone(total["actual_provider_cost_usd"])

    def test_report_marks_reference_and_mixed_dollars_as_estimates(self):
        measured = request_metrics([{**call(100, 50, .2), "pricingBasis": {
            "kind": "reference_only", "source": "official reference", "upstreamBaseURL": "https://proxy.example"}},
            {**call(100, 0, .1), "pricingBasis": {"kind": "provider_rates", "source": "provider price sheet"}}])
        trial = {"task": "synthetic", "score": 1, "exception": None, "agent_seconds": 1, "metrics": measured,
                 "environment": {}, "infrastructure_issue": None, "post_agent_requests": 0, "agent_metrics": None}
        job = {"job": "synthetic", "models": ["fixture"], "trials": [trial], "completed": 1, "planned": 1,
               "aggregate": aggregate_trials([trial]), "configurations": []}
        text = markdown({"jobs": [job]})
        self.assertIn("参考价格估算，实际扣费未知", text)
        self.assertIn("混合依据的总值不代表实际供应商扣费", text)
        self.assertIn("official reference", text)
        self.assertIn("provider price sheet", text)
        self.assertIn("https://proxy.example", text)
        self.assertIn("已知估算", text)
        self.assertIn("缓存净节省估算美元", text)

    def test_invalid_explicit_pricing_basis_does_not_silently_become_legacy(self):
        for basis in (None, {}, {"kind": "actual", "source": "unverified"},
                      {"kind": "reference_only", "source": ""},
                      {"kind": "provider_rates", "source": "rates", "upstreamBaseURL": False}):
            with self.subTest(basis=basis), self.assertRaisesRegex(ValueError, "pricingBasis"):
                request_metrics([{**call(100, 0, .1), "pricingBasis": basis}])

    def test_program_failures_are_counted_separately_from_successful_kernel_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'agent').mkdir()
            execution = {'executionId': 'same', 'status': 'failed',
                         'failure': {'code': 'PROGRAM_ERROR', 'message': 'private diagnostic'}, 'durationMs': 50}
            invocation = {'id': 'call', 'summary': {'status': 'succeeded'}}
            (root / 'agent/traces.json').write_text(json.dumps({'traces': [
                {'executions': [execution], 'invocations': [invocation]},
                {'executions': [execution], 'invocations': [invocation]},
            ], 'branches': [{'kind': 'child', 'turns': [{'executions': [
                {'executionId': 'same', 'status': 'succeeded', 'durationMs': 25},
                {'executionId': 'cancelled', 'status': 'cancelled'},
                {'executionId': 'unknown'},
            ]}]}]}))
            result = agent_metrics(root)
            self.assertEqual(result['failed_tool_calls'], 0)
            self.assertEqual(result['script_executions'], 4)
            self.assertEqual(result['failed_script_executions'], 1)
            self.assertEqual(result['script_execution_status_counts'],
                             {'failed': 1, 'succeeded': 1, 'cancelled': 1, 'unknown': 1})
            self.assertEqual(result['script_failure_codes'], {'PROGRAM_ERROR': 1})
            self.assertIsNone(result['script_seconds_sum'], 'unknown/cancelled execution durations do not prove zero')
            self.assertNotIn('private diagnostic', json.dumps(result))

    def test_native_tool_layers_keep_nested_operations_separate_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'agent').mkdir()
            (root / 'agent/trajectory.json').write_text(json.dumps({'steps': [
                {'tool_calls': [{'tool_call_id': 'outer', 'function_name': 'exec'}]},
            ]}))
            commands = [
                {'type': 'item.started', 'item': {'id': 'a', 'type': 'command_execution'}},
                {'type': 'item.completed', 'item': {'id': 'a', 'type': 'command_execution', 'exit_code': 0}},
                {'type': 'item.completed', 'item': {'id': 'a', 'type': 'command_execution', 'exit_code': 0}},
                {'type': 'item.completed', 'item': {'id': 'b', 'type': 'command_execution', 'exit_code': 127, 'command': 'PRIVATE_COMMAND', 'aggregated_output': 'PRIVATE_OUTPUT'}},
                {'type': 'item.completed', 'item': {'id': 'c', 'type': 'file_change', 'status': 'completed'}},
                {'type': 'item.started', 'item': {'id': 'pending', 'type': 'command_execution'}},
                {'type': 'item.completed', 'item': {'id': 'message', 'type': 'agent_message', 'text': 'command_execution failed'}},
            ]
            (root / 'agent/codex.txt').write_text('setup banner\n' + '\n'.join(map(json.dumps, commands)))
            result = agent_metrics(root)
            self.assertEqual(result['tool_calls'], 1)
            self.assertEqual(result['tool_call_scope'], 'atif_model_tool_calls')
            native = result['native_operations']
            self.assertEqual(native['completed_by_type'], {'command_execution': 2, 'file_change': 1})
            self.assertEqual(native['pending_items'], 1)
            self.assertEqual(native['failed_command_executions'], 1)
            self.assertEqual(native['unknown_command_exit_codes'], 0)
            self.assertNotIn('PRIVATE_COMMAND', json.dumps(native))
            self.assertNotIn('PRIVATE_OUTPUT', json.dumps(native))

    def test_native_item_ids_are_scoped_to_thread_and_unknown_exit_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'agent').mkdir()
            (root / 'agent/trajectory.json').write_text(json.dumps({'steps': []}))
            events = []
            for thread, code in [('first', 0), ('second', None)]:
                events += [{'type': 'thread.started', 'thread_id': thread},
                           {'type': 'item.completed', 'item': {'id': 'same', 'type': 'command_execution', 'exit_code': code}}]
            (root / 'agent/codex.txt').write_text('\n'.join(map(json.dumps, events)))
            native = agent_metrics(root)['native_operations']
            self.assertEqual(native['completed_by_type']['command_execution'], 2)
            self.assertEqual(native['unknown_command_exit_codes'], 1)
            self.assertEqual(native['failed_command_executions'], 0)

    def test_absent_native_operation_evidence_stays_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'agent').mkdir()
            (root / 'agent/trajectory.json').write_text(json.dumps({'steps': []}))
            self.assertIsNone(agent_metrics(root)['native_operations'])
            (root / 'agent/codex.txt').write_text('not JSON\n' + json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message'}}))
            self.assertIsNone(agent_metrics(root)['native_operations'])

    def test_stderr_is_counted_separately_from_command_failure_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            invocations = []
            for index, (success, stderr, truncated) in enumerate([
                (True, "", False), (True, "missing: not found", False),
                (True, "normal progress", False), (False, "failure", False),
                (True, "incomplete", True),
            ]):
                invocations.append({"id": str(index), "summary": {
                    "moduleId": "velaros:shell", "operation": "run", "status": "succeeded",
                    "output": json.dumps({"success": success, "stderr": stderr}), "outputTruncated": truncated,
                }})
            (root / "agent/traces.json").write_text(json.dumps({"traces": [
                {"invocations": invocations}, {"invocations": invocations},
            ]}))
            result = agent_metrics(root)
            self.assertEqual(result["tool_calls"], 5)
            self.assertEqual(result['tool_call_scope'], 'scriptact_host_operations')
            self.assertEqual(result["shell_outputs_measured"], 4)
            self.assertEqual(result["failed_shell_commands"], 1)
            self.assertEqual(result["shell_commands_with_stderr"], 3)
            self.assertEqual(result["successful_shell_commands_with_stderr"], 2)

    def test_first_byte_latency_separates_streaming_nonstreaming_and_unknown_transport(self):
        rows = [call(100, 50, .01) for _ in range(3)]
        for row, latency in zip(rows, (100, 20000, 500)):
            row["firstByteMs"] = latency
        rows[0]["metadata"] = {"stream": True, "endpoint": "/v1/responses"}
        rows[1]["metadata"] = {"stream": False, "endpoint": "/v1/chat/completions"}
        result = request_metrics(rows)["transport"]
        self.assertEqual(result["request_counts"], {"streaming": 1, "nonstreaming": 1, "unknown": 1})
        self.assertEqual(result["first_byte_seconds"]["streaming"]["mean"], .1)
        self.assertEqual(result["first_byte_seconds"]["nonstreaming"]["mean"], 20)
        self.assertEqual(result["first_byte_seconds"]["unknown"]["mean"], .5)
        self.assertEqual(request_metrics([])["transport"]["first_byte_seconds"]["streaming"], None)

    def test_provider_settlement_tail_keeps_inflight_requests_unknown(self):
        cleanup = "2026-09-28T13:30:10Z"
        self.assertEqual(settlement_tail([], cleanup), 0)
        self.assertEqual(settlement_tail([{"finishedAt": "2026-09-28T13:30:08Z"}], cleanup), 0)
        self.assertEqual(settlement_tail([{"finishedAt": "2026-09-28T13:30:20Z"}], cleanup), 10)
        self.assertIsNone(settlement_tail([{"finishedAt": None}], cleanup))
        self.assertIsNone(settlement_tail([], None))

    def test_cancelled_request_is_not_a_script_protocol_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            decisions = [
                {"status": "rejected", "error": {"code": "SCRIPT_PROTOCOL"}, "timing": {"modelMs": 1000}, "usage": {"outputTokens": 20}},
                {"status": "rejected", "error": {"code": 20, "message": "This operation was aborted"}, "timing": {"modelMs": 5000}},
                {"status": "rejected", "error": {"message": "unclassified"}},
            ]
            (root / "agent/traces.json").write_text(json.dumps({"traces": [
                {"decision": {"body": json.dumps(item)}} for item in decisions]}))
            result = agent_metrics(root)
            self.assertEqual(result["protocol_rejections"], 1)
            self.assertEqual(result["protocol_rejection_model_seconds"], 1)
            self.assertEqual(result["protocol_rejection_output_tokens"], 20)
            self.assertEqual(result["response_rejections"]["total"], 3)
            self.assertEqual(result["response_rejections"]["cancelled"], 1)
            self.assertEqual(result["response_rejections"]["other"], 1)
            self.assertIsNone(result["response_rejections"]["model_seconds"])

    def test_prompt_layout_distinguishes_rendered_text_raw_json_and_missing_requests(self):
        frame_text = "Runtime 本帧工作内存（origin=runtime-view）；状态"
        raw_frame = {"partitions": {"task": {"goal": "修复"}, "runtime": {"pending": 1}}}
        turn = {"request": {"body": json.dumps({"providerRequest": {
            "system": "instructions", "messages": [
                {"role": "user", "content": "history"},
                {"role": "user", "content": [{"type": "text", "text": frame_text}, {"type": "image", "data": "not-counted"}]}]},
            "request": {"materials": [{"origin": "runtime-view", "text": json.dumps(raw_frame)}]}})}}
        result = prompt_layout_metrics([turn, {"request": None}])
        self.assertEqual(result["measured_requests"], 1)
        self.assertEqual(result["unmeasured_requests"], 1)
        self.assertEqual(result["provider_text_chars"]["max"], len("instructionshistory") + len(frame_text))
        self.assertIsNone(result["working_frame_text_chars"], "A similar prefix without current frame identity is not verified SDK delivery")
        self.assertEqual(result["current_frame"]["unverified_requests"], 1)
        self.assertEqual(result["non_text_blocks"]["max"], 1)
        self.assertEqual(result["raw_partition_json_chars"]["task"]["max"], len('{"goal":"修复"}'))
        self.assertIsNone(prompt_layout_metrics([{"request": None}])["working_frame_text_chars"])
        augmented = json.loads(turn["request"]["body"])
        state = {"model": "openai/gpt-6-sol", "format": "openai-responses-v1",
                 "data": json.dumps({"reasoningContext": "all_turns", "encrypted": "x" * 10000}), "tokens": 40}
        augmented["providerRequest"]["messages"].insert(0, {"role": "assistant", "content": "ok", "continuation": state})
        augmented["estimate"] = {"opaqueTokens": 40}
        with_state = prompt_layout_metrics([{"request": {"body": json.dumps(augmented)}}])
        self.assertEqual(with_state["provider_text_chars"]["max"], result["provider_text_chars"]["max"] + 2)
        self.assertEqual(with_state["continuation"]["serialized_chars"]["max"], len(state["data"]))
        self.assertEqual(with_state["continuation"]["reserved_input_tokens"]["max"], 40)
        self.assertEqual(with_state["continuation"]["history_items"]["max"], 1)
        self.assertEqual(with_state["continuation"]["prior_response_reasoning_contexts"], ["all_turns"])
        self.assertEqual(result["continuation"]["history_items"]["max"], 0)

    def test_compatibility_diagnostics_use_tool_outputs_and_deduplicate_observations(self):
        symptom = 'rosetta error: Unimplemented syscall number 282'
        measured = tool_environment_diagnostics([('a', symptom), ('a', symptom), ('b', 'ok')])
        self.assertEqual(measured['measured_tool_outputs'], 2)
        self.assertEqual(measured['issues'][0]['tool_observations'], 1)
        self.assertEqual(measured['issues'][0]['syscall_numbers'], [282])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'agent').mkdir()
            trajectory = root / 'agent/trajectory.json'
            trajectory.write_text(json.dumps({'steps': [{'step_id': 1, 'source': 'agent', 'message': symptom}]}))
            self.assertEqual(agent_metrics(root)['environment_diagnostics']['issues'], [])
            trajectory.write_text(json.dumps({'steps': [{'step_id': 1, 'source': 'agent', 'message': 'inspect',
                'observation': {'results': [{'source_call_id': 'tool-1', 'content': symptom}]}}]}))
            self.assertEqual(agent_metrics(root)['environment_diagnostics']['issues'][0]['references'], ['tool-1'])
            (root / 'config.json').write_text('{}')
            (root / 'lock.json').write_text(json.dumps({'trials': [{'task': {'path': 'a'}}]}))
            trial = root / 'a'
            trial.mkdir()
            (trial / 'config.json').write_text(json.dumps({'task': {'path': 'a'}}))
            (trial / 'result.json').write_text(json.dumps({'task_name': 'a', 'trial_name': 'a',
                'verifier_result': {'rewards': {'reward': 0}}, 'exception_info': {'exception_type': 'AgentTimeoutError'}}))
            (trial / 'agent').mkdir()
            (trial / 'agent/trajectory.json').write_text(trajectory.read_text())
            row = summarize(root, [])['trials'][0]
            self.assertEqual(row['score'], 0)
            self.assertEqual(row['exception'], 'AgentTimeoutError')
            self.assertEqual(row['agent_metrics']['environment_diagnostics']['issues'][0]['kind'], 'rosetta_unimplemented_syscall')

    def test_requests_after_agent_timeout_remain_in_trial_cost_and_are_flagged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_text('{}')
            (root / 'lock.json').write_text(json.dumps({'trials': [{'task': {'path': 'a'}}]}))
            trial = root / 'a'
            trial.mkdir()
            (trial / 'config.json').write_text(json.dumps({'task': {'path': 'a'}}))
            (trial / 'result.json').write_text(json.dumps({'task_name': 'a', 'trial_name': 'a',
                'finished_at': '2026-09-28T00:00:03Z',
                'agent_execution': {'started_at': '2026-09-28T00:00:00Z', 'finished_at': '2026-09-28T00:00:01Z'},
                'verifier_result': {'rewards': {'reward': 0}},
                'exception_info': {'exception_type': 'AgentTimeoutError'}}))
            requests = [{**call(100, 50, cost), 'id': str(n), 'startedAt': f'2026-09-28T00:00:0{n}Z'}
                        for n, cost in [(0, 0.1), (2, 0.2), (4, 0.3)]]
            row = summarize(root, requests)['trials'][0]
            self.assertEqual(row['gateway_requests'], 2)
            self.assertAlmostEqual(row['metrics']['known_cost_usd'], 0.3)
            self.assertEqual(row['post_agent_requests'], 1)
            self.assertEqual(row['post_agent_request_ids'], ['2'])
            self.assertAlmostEqual(row['post_agent_metrics']['known_cost_usd'], 0.2)
            self.assertEqual(row['agent_seconds'], 1)

    def test_official_reward_is_preserved_alongside_a_runtime_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_text('{}')
            (root / 'lock.json').write_text(json.dumps({'trials': [{'task': {'path': 'a'}}]}))
            trial = root / 'a'
            trial.mkdir()
            (trial / 'config.json').write_text(json.dumps({'task': {'path': 'a'}}))
            (trial / 'result.json').write_text(json.dumps({'task_name': 'a', 'trial_name': 'a',
                'verifier_result': {'rewards': {'reward': 1}},
                'exception_info': {'exception_type': 'AgentTimeoutError'}}))
            data = summarize(root, [])
            self.assertEqual(data['mean_score'], 1)
            self.assertEqual(data['errors'], 1)
            self.assertEqual(data['aggregate']['successes'], 1)
            self.assertEqual(data['aggregate']['clean_successes'], 0)
            self.assertEqual(compare_jobs(data, data)['jointly_solved_tasks'], 0)

    def test_cost_components_use_frozen_long_context_rates_and_sum_to_the_estimate(self):
        request = call(1000, 100, 0.00474, written=800)
        request['pricing'] = {'input': 2, 'cached': 0.2, 'write': 2.5, 'output': 10,
                              'longThreshold': 500, 'longInputMultiplier': 2, 'longOutputMultiplier': 1.5}
        metrics = request_metrics([request])
        self.assertAlmostEqual(sum(metrics['cost_components_usd'].values()), metrics['known_cost_usd'])
        self.assertAlmostEqual(metrics['cost_components_usd']['cache_write'], 0.004)
        self.assertAlmostEqual(metrics['cost_components_usd']['output'], 0.0003)
        combined = request_metrics([request, {'status': 'http-200', 'usage': None, 'estimatedUsd': None}])
        self.assertTrue(all(v is None for v in combined['cost_components_usd'].values()))
        self.assertEqual(sum(request_metrics([])['cost_components_usd'].values()), 0)

    def test_frozen_cohort_keeps_pending_sources_and_unsuccessful_recovery_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def job(name, outcomes):
                path = root / name
                path.mkdir()
                (path / 'config.json').write_text(json.dumps({'agents': [{'name': 'test', 'model_name': 'openai/gpt-6-sol'}]}))
                (path / 'lock.json').write_text(json.dumps({'trials': [{'task': {'path': task}} for task in outcomes]}))
                for task, score in outcomes.items():
                    trial = path / task
                    trial.mkdir()
                    (trial / 'config.json').write_text(json.dumps({'task': {'path': task}}))
                    (trial / 'result.json').write_text(json.dumps({'task_name': task, 'trial_name': task,
                        'task_id': {'git_commit_id': 'fixed'}, 'verifier_result': {'rewards': {'reward': score}}}))
            job('original', {'a': 1, 'b': 0})
            manifest = {'model': 'gpt-6-sol', 'dataset_commit': 'fixed', 'tasks': ['a', 'b'],
                        'participants': [{'name': 'fixed-comparison', 'sources': [
                            {'job': 'original', 'tasks': ['a']}, {'job': 'recovery', 'tasks': ['b']}]}]}
            waiting = summarize_cohort(manifest, root, [])[0]
            self.assertEqual(waiting['planned'], 2)
            self.assertEqual(waiting['completed'], 1)
            self.assertEqual(waiting['unstarted'], 1)
            self.assertIsNone(waiting['mean_score'])
            job('recovery', {'b': 0})
            completed = summarize_cohort(manifest, root, [])[0]
            self.assertEqual(completed['mean_score'], 0.5)
            self.assertEqual(completed['trials'][1]['source_job'], 'recovery')
            self.assertEqual(summarize(root / 'original', [])['completed'], 2)
            manifest['dataset_commit'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'dataset revision'):
                summarize_cohort(manifest, root, [])

    def test_cohort_rejects_duplicate_task_sources_instead_of_picking_an_attempt(self):
        manifest = {'tasks': ['a', 'b'], 'participants': [{'name': 'duplicate', 'sources': [
            {'job': 'first', 'tasks': ['a', 'b']}, {'job': 'second', 'tasks': ['b']}]}]}
        with self.assertRaisesRegex(ValueError, 'exactly one source'):
            summarize_cohort(manifest, Path('/unused'), [])

    def test_zero_calls_do_not_erase_known_batch_usage(self):
        empty = request_metrics([])
        self.assertEqual(empty['input_tokens'], 0)
        self.assertEqual(empty['cache_write_tokens'], 0)
        self.assertIsNone(empty['cache_token_hit_rate'])
        self.assertIsNone(empty['peak_input_tokens'])
        trials = [
            {'score': 0, 'exception': 'EnvironmentStartTimeoutError', 'agent_seconds': None, 'metrics': empty},
            {'score': 1, 'exception': None, 'agent_seconds': 10, 'metrics': request_metrics([call(100, 80, 0.1, 20)])},
        ]
        combined = aggregate_trials(trials)
        self.assertEqual(combined['input_tokens'], 100)
        self.assertEqual(combined['cache_token_hit_rate'], 0.8)
        self.assertEqual(combined['successes'], 1)
        self.assertIsNone(request_metrics([{'status': 'http-200', 'usage': None}])['input_tokens'])

    def test_predeclared_group_preserves_its_pending_trials_and_raw_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config.json").write_text('{}')
            (root / "lock.json").write_text(json.dumps({"trials": [{"task": {"path": name}} for name in ['a', 'b', 'c']]}))
            for name, reward in [('a', 1), ('b', None), ('c', 0)]:
                trial = root / name
                trial.mkdir()
                (trial / "config.json").write_text(json.dumps({"task": {"path": name}}))
                if reward is not None:
                    (trial / "result.json").write_text(json.dumps({"task_name": name, "trial_name": name,
                                                                  "verifier_result": {"rewards": {"reward": reward}}}))
            scoped = summarize(root, [], {'a', 'b'})
            self.assertEqual(scoped['planned'], 2)
            self.assertEqual(scoped['pending'], ['b'])
            self.assertIsNone(scoped['mean_score'])
            self.assertEqual(summarize(root, [], {'a'})['mean_score'], 1)
            self.assertEqual(summarize(root, [])['completed'], 2)
            self.assertEqual(json.loads((root / 'c/result.json').read_text())['verifier_result']['rewards']['reward'], 0)

    def test_rejected_response_overhead_preserves_missing_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            (root / "agent/traces.json").write_text(json.dumps({"traces": [
                {"decision": {"body": json.dumps({"status": "rejected", "error": {"code": "SCRIPT_PROTOCOL"}, "timing": {"modelMs": 2500}, "usage": {"outputTokens": 42}})}},
                {"decision": {"body": json.dumps({"status": "accepted", "timing": {"modelMs": 9000}, "usage": {"outputTokens": 100}})}}
            ], "branches": []}))
            result = agent_metrics(root)
            self.assertEqual(result["protocol_rejection_model_seconds"], 2.5)
            self.assertEqual(result["protocol_rejection_output_tokens"], 42)
            self.assertIsNone(result["protocol_rejection_input_tokens"])

    def test_image_failure_before_agent_execution_is_separate_from_agent_failure(self):
        result = {"exception_info": {"exception_message": "Docker compose command failed: Image Pulling; lookup host: no such host"}}
        self.assertEqual(trial_infrastructure_issue(result, ""), "environment_image_unavailable")
        self.assertIsNone(trial_infrastructure_issue({**result, "agent_execution": {"started_at": "now"}}, ""))
        self.assertEqual(trial_infrastructure_issue({"agent_setup": {"started_at": "now"},
                         "exception_info": {"exception_type": "AgentSetupTimeoutError"}}, ""), "agent_installation_failed")
        self.assertEqual(trial_infrastructure_issue({"environment_setup": {"started_at": "now"},
                         "exception_info": {"exception_type": "EnvironmentStartTimeoutError"}}, ""), "environment_setup_failed")

    def test_cache_annotations_do_not_count_as_historical_body_rewrites(self):
        full = json.dumps({"ref": {"id": "receipt"}, "bodyIncluded": True}) + "\nresult"
        retired = json.dumps({"ref": {"id": "receipt"}, "bodyIncluded": False,
                              "reason": "lease-expired-or-released"})
        def turn(content, breakpoint):
            return {"request": {"body": json.dumps({"providerRequest": {"system": "stable", "messages": [
                {"role": "user", "content": content, "cacheBreakpoint": breakpoint}
            ]}})}}
        result = history_cache_metrics([turn(full, True), turn(full, False), turn(retired, True)])
        self.assertEqual(result["measured_transitions"], 2)
        self.assertEqual(result["historical_body_rewrites"], 1)
        self.assertEqual(result["lease_retirements"], 1)
        self.assertEqual(result["unchanged_prefix_chars"]["max"], len("stable") + len(full))

    def test_environment_uses_historical_log_and_leaves_missing_hashes_unknown(self):
        old = environment_evidence({"environment": {"type": "docker"}}, "")
        self.assertIsNone(old["setup_sha256"])
        self.assertEqual(old["type"], "docker")
        new = environment_evidence({"environment": {"import_path": "campaign:Environment"}},
                                   "Campaign environment setup SHA-256: " + "a" * 64)
        self.assertEqual(new["setup_sha256"], "a" * 64)
        self.assertIsNone(new["uv_sha256"])

    def test_narration_measurement_distinguishes_missing_and_truncated_control(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            (root / "agent/traces.json").write_text(json.dumps({"traces": [
                {"response": {"body": "准备执行\n@@s" + "a" * 32 + " execute()\n"}},
                {"response": {"body": "只有说明"}},
                {"response": {"body": "不完整", "truncated": True}},
            ], "branches": []}))
            result = agent_metrics(root)["response_control"]
            self.assertEqual(result["measured_responses"], 2)
            self.assertEqual(result["unmeasured_responses"], 1)
            self.assertEqual(result["responses_without_marker"], 1)
            self.assertEqual(result["leading_narration_chars"]["mean"], 5)

    def test_verifier_bootstrap_failure_is_separate_from_an_executed_test_failure(self):
        self.assertEqual(verifier_infrastructure_issue('E: Failed to fetch curl\n/tests/test.sh: line 23: uv: command not found'), 'verifier_dependency_unavailable')
        self.assertEqual(verifier_infrastructure_issue('error: Failed to spawn: `pytest`'), 'verifier_dependency_unavailable')
        self.assertIsNone(verifier_infrastructure_issue('test session starts\nFAILED test_example - AssertionError'))

    def test_weighted_hit_rate_and_unknown_reasoning(self):
        metrics = request_metrics([call(100, 100, 0.1), call(900, 0, 0.2, 900)])
        self.assertEqual(metrics["cache_token_hit_rate"], 0.1)
        self.assertEqual(metrics["cache_write_tokens"], 900)
        self.assertIsNone(metrics["reasoning_tokens"])
        self.assertIsNone(metrics["model_request_seconds_sum"])

    def test_unknown_usage_is_not_zero(self):
        metrics = request_metrics([call(100, 50, 0.1), {"status": "reserved", "usage": None, "estimatedUsd": None}])
        self.assertIsNone(metrics["input_tokens"])
        self.assertIsNone(metrics["cache_token_hit_rate"])
        self.assertEqual(metrics["unknown_cost_requests"], 1)
        self.assertEqual(metrics["unsettled_requests"], 1)

    def test_failed_attempt_cost_is_in_success_denominator(self):
        trials = [
            {"score": 1, "exception": None, "agent_seconds": 10, "metrics": request_metrics([call(100, 50, 1)])},
            {"score": 0, "exception": "Timeout", "agent_seconds": 90, "metrics": request_metrics([call(100, 50, 3)])},
        ]
        metrics = aggregate_trials(trials)
        self.assertEqual(metrics["spend_per_success_usd"], 4)
        self.assertEqual(metrics["agent_seconds_all_attempts"]["mean"], 50)
        self.assertEqual(metrics["agent_seconds_successful"]["mean"], 10)

    def test_small_sample_percentiles(self):
        self.assertIsNone(distribution([]))
        self.assertEqual(distribution([10, 1, 3])["p90"], 10)

    def test_comparison_does_not_reward_fast_failures_or_repeat_weight(self):
        def trial(task, seconds, cost, score=1):
            return {"task": task, "score": score, "exception": None, "agent_seconds": seconds,
                    "metrics": request_metrics([call(100, 0, cost)])}
        left = {"job": "left", "planned": 3, "completed": 3,
                "trials": [trial("a", 10, 1), trial("b", 100, 10), trial("c", 100, 10)]}
        right = {"job": "right", "planned": 5, "completed": 4,
                 "trials": [trial("a", 20, 2), trial("b", 40, 4), trial("b", 60, 6), trial("c", 1, 0.01, 0)]}
        result = compare_jobs(left, right)
        self.assertEqual(result["jointly_solved_tasks"], 2)
        self.assertEqual(result["successful_task_means"]["candidate"]["agent_seconds"], 35)
        self.assertAlmostEqual(result["candidate_over_reference"]["cost_usd"], 3.5 / 5.5)
        self.assertFalse(result["complete"])

    def test_comparison_preserves_unknown_cost_and_empty_intersection(self):
        trial = {"task": "a", "score": 1, "exception": None, "agent_seconds": 10,
                 "metrics": request_metrics([{"status": "reserved", "estimatedUsd": None}])}
        job = {"job": "left", "planned": 1, "completed": 1, "trials": [trial]}
        self.assertIsNone(compare_jobs(job, job)["candidate_over_reference"]["cost_usd"])
        other = {**job, "trials": [{**trial, "task": "b"}]}
        result = compare_jobs(job, other)
        self.assertEqual(result["jointly_solved_tasks"], 0)
        self.assertIsNone(result["candidate_over_reference"]["agent_seconds"])

    def test_objectives_require_complete_wall_time_and_cost_and_keep_failed_sources(self):
        def job(name, count, seconds, cost, wall):
            trial = {"task": "same", "score": 1, "exception": None, "agent_seconds": seconds,
                     "attempt_wall_seconds": wall,
                     "metrics": {"requests": count, "known_cost_usd": cost, "unknown_cost_requests": 0}}
            return {"job": name, "planned": 1, "completed": 1, "trials": [trial]}
        reference = job('reference', 10, 100, 1, 120)
        tradeoff = job('candidate', 5, 80, .8, 121)
        self.assertEqual(compare_jobs(reference, tradeoff)['efficiency_dominance'], 'tradeoff')
        better = job('candidate', 50, 80, .8, 100)
        result = compare_jobs(reference, better)
        self.assertEqual(result['efficiency_dominance'], 'candidate')
        self.assertEqual(result['comparison_schema'], 2)
        self.assertIn('not_actual_complete_task_costs', result['efficiency_dominance_basis'])
        self.assertEqual(result['actual_complete_task_cost_dominance'], 'unknown')
        self.assertNotIn('model_requests', result['candidate_over_reference'])
        self.assertFalse(result['supports_general_superiority'])
        better['trials'][0]['attempt_wall_seconds'] = None
        unavailable = compare_jobs(reference, better)
        self.assertIsNone(unavailable['candidate_over_reference']['attempt_wall_seconds'])
        self.assertEqual(unavailable['efficiency_dominance'], 'unknown')
        failed = {"agent_seconds": 50, "metrics": {"requests": 4, "known_cost_usd": .4, "unknown_cost_requests": 1}}
        better['completed_source_usage'] = [better['trials'][0], failed]
        totals = compare_jobs(reference, better)['completed_attempt_totals']['candidate']
        self.assertEqual(totals['model_requests'], 54)
        self.assertEqual(totals['agent_seconds'], 130)
        self.assertAlmostEqual(totals['known_cost_usd'], 1.2)
        self.assertIsNone(totals['cost_usd'])

    def test_comparison_weights_tasks_retains_raw_counts_and_excludes_infrastructure_faults(self):
        def trial(task, count, score=1):
            return {"task": task, "score": score, "exception": None, "agent_seconds": 10,
                    "attempt_wall_seconds": 20,
                    "metrics": request_metrics([call(100, 50, .01) for _ in range(count)])}
        left = {"job": "left", "planned": 4, "completed": 4,
                "trials": [trial("a", 8), trial("a", 12), trial("b", 2), trial("c", 20)]}
        right = {"job": "right", "planned": 3, "completed": 3,
                 "trials": [trial("a", 6), trial("b", 4), trial("c", 1, 0)]}
        result = compare_jobs(left, right)
        self.assertNotIn("model_requests", result["successful_task_means"]["reference"])
        self.assertNotIn("model_requests", result["successful_task_means"]["candidate"])
        self.assertNotIn("model_requests", result["candidate_over_reference"])
        self.assertEqual(result["candidate_over_reference"]["attempt_wall_seconds"], 1)
        self.assertAlmostEqual(result["candidate_over_reference"]["cost_usd"], 5 / 6)
        self.assertEqual(aggregate_trials(right["trials"])["model_requests"], 11)
        self.assertEqual(result["completed_attempt_totals"]["candidate"]["model_requests"], 11)
        before = result["candidate_over_reference"]
        right["trials"][0]["metrics"]["requests"] = None
        self.assertEqual(compare_jobs(left, right)["candidate_over_reference"], before)
        right["trials"][0]["infrastructure_issue"] = "cleanup_unconfirmed"
        filtered = compare_jobs(left, right)
        self.assertEqual(filtered["jointly_solved_tasks"], 1)
        self.assertEqual(filtered["tasks"][0]["task"], "b")
        right["trials"][0]["metrics"]["requests"] = 6
        full = aggregate_trials(right["trials"])
        self.assertEqual(full["successes"], 2)
        self.assertEqual(full["clean_successes"], 1)
        self.assertIsNone(compare_jobs(left, {**right, "trials": []})["candidate_over_reference"]["attempt_wall_seconds"])

    def test_cache_writes_can_cost_more_than_the_reads_save(self):
        request = call(1000, 100, 1, written=900)
        request["pricing"] = {"input": 2, "cached": 0.2, "write": 2.5,
                              "longThreshold": 272000, "longInputMultiplier": 2}
        self.assertAlmostEqual(request_metrics([request])["cache_net_savings_usd"], -0.00027)

    def test_repair_turn_without_preparation_timing_remains_reportable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            (root / "agent/traces.json").write_text(json.dumps({"traces": [
                {"timing": {"observationMs": None, "contextMs": None}, "request": None, "repair": 1}
            ], "branches": []}))
            metrics = agent_metrics(root)
            self.assertEqual(metrics["repair_turns"], 1)
            self.assertEqual(metrics["context"]["preparation_measurements_missing"], 1)
            self.assertIsNone(metrics["model_await_seconds_sum"])
            self.assertIsNone(metrics["observed_observation_seconds"])

    def test_outer_body_visibility_does_not_hide_omitted_result_fields(self):
        frame = {"partitions": {"recent": {"results": [
            {"ref": "large-result", "bodyIncluded": True, "representation": "excerpt",
             "omitted": ["/result/value/default"], "size": {"chars": 24000}}
        ]}, "runtime": {"materialStatus": {"footprint": {"leasedResults": 800}}}}}
        turn = {"request": {"body": json.dumps({"request": {
            "materials": [{"origin": "runtime-view", "text": json.dumps(frame)}]}})}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            (root / "agent/traces.json").write_text(json.dumps({"traces": [turn, turn], "branches": []}))
            result = agent_metrics(root)["context"]["result_visibility"]
            self.assertEqual(result["partial_exposures"], 2)
            self.assertEqual(result["unique_results_with_omissions"], 1)
            self.assertEqual(result["reference_only_exposures"], 0)
            self.assertEqual(result["peak_visible_leased_chars"], 800)
            self.assertEqual(result["peak_source_leased_chars"], 24000)

            # 新帧把已在历史中的结果压成状态卡，大小仍按压缩前的精确汇总计量。
            frame["partitions"]["recent"]["results"][0].pop("size")
            frame["partitions"]["runtime"]["materialStatus"]["footprint"]["leasedResultSources"] = 24000
            turn["request"]["body"] = json.dumps({"request": {
                "materials": [{"origin": "runtime-view", "text": json.dumps(frame)}]}})
            (root / "agent/traces.json").write_text(json.dumps({"traces": [turn, turn], "branches": []}))
            compact = agent_metrics(root)["context"]["result_visibility"]
            self.assertEqual(compact, result)

    def test_context_child_calls_are_counted_even_when_their_model_mode_is_work(self):
        turn = {"request": {"body": json.dumps({"request": {"mode": "work"}})}}
        def timed(milliseconds):
            return {**turn, "decision": {"body": json.dumps({"status": "accepted", "timing": {"modelMs": milliseconds}})}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            path = root / "agent/traces.json"
            path.write_text(json.dumps({"traces": [timed(1000)],
                "branches": [{"kind": "context", "turns": [timed(2000), timed(3000)]}]}))
            measured = agent_metrics(root)
            self.assertEqual(measured["context"]["maintenance_model_calls"], 2)
            self.assertEqual(measured["model_await_seconds_sum"], 6)
            path.write_text(json.dumps({"traces": [timed(1000)],
                "branches": [{"kind": "context", "turns": [timed(2000), turn]}]}))
            self.assertIsNone(agent_metrics(root)["model_await_seconds_sum"])


class CurrentFrameLayoutTests(unittest.TestCase):
    def fixture(self, delta=False, frame_id="current", history=None):
        display = ("Runtime 本帧工作内存（origin=runtime-view，增量）；\n变化：{\"list\":[2,1,2]}"
                   if delta else "Runtime 本帧工作内存（origin=runtime-view）；\n分区 task：{\"goal\":\"修复🧪\"}")
        protocol = "\n\n本帧协议（宿主生成；控制标记以最后出现的这一段为准）：\n@@synthetic contract"
        status = {"frameId": frame_id, "phase": "work", "inputTokens": 300}
        status_text = "\nRuntime ContextStatus:\n" + json.dumps(status, ensure_ascii=False, separators=(",", ":"))
        frame = {"schemaVersion": 2, "id": frame_id, "frameId": "host-snapshot-" + frame_id,
                 "partitions": {"task": {}, "runtime": {}}}
        envelope = {"request": {"compiledPrompt": display + protocol, "contextStatus": status,
                                 "materials": [{"ref": frame_id, "origin": "runtime-view", "text": json.dumps(frame)}]},
                    "providerRequest": {"system": "system", "messages": list(history or []) + [
                        {"role": "user", "content": display + protocol + status_text}]}}
        return envelope, display, protocol, status_text

    def measure(self, envelope):
        return prompt_layout_metrics([{"turnId": "synthetic-turn", "request": {"body": json.dumps(envelope)}}])

    def test_full_and_delta_current_delivery_excludes_multiple_historical_full_frames(self):
        historical, _, _, _ = self.fixture(frame_id="previous")
        history = historical["providerRequest"]["messages"] * 2 + [{"role": "assistant", "content": "old response"}]
        for delta in (False, True):
            with self.subTest(delta=delta):
                envelope, display, protocol, status = self.fixture(delta=delta, history=history)
                measured = self.measure(envelope)
                current = measured["current_frame"]
                self.assertEqual(measured["working_frame_text_chars"]["max"], len(display))
                self.assertEqual(current["verified_requests"], 1)
                self.assertEqual(current["frames"][0]["frame_id"], "current")
                self.assertEqual(current["frames"][0]["host_frame_id"], "host-snapshot-current")
                self.assertEqual(current["display_modes"], {"delta" if delta else "full": 1})
                self.assertEqual(current["protocol_text_chars"]["max"], len(protocol))
                self.assertEqual(current["context_status_text_chars"]["max"], len(status))
                self.assertEqual(current["history_text_chars"]["max"], sum(len(row["content"]) for row in history))
                self.assertEqual(measured["provider_text_chars"]["max"],
                                 len("system") + current["history_text_chars"]["max"] + len(display + protocol + status))

    def test_reset_uses_the_new_last_frame_without_requiring_old_history_or_accepted_baseline(self):
        envelope, display, _, _ = self.fixture(frame_id="new-authorization", history=[])
        measured = self.measure(envelope)
        self.assertEqual(measured["current_frame"]["frames"][0]["frame_id"], "new-authorization")
        self.assertEqual(measured["working_frame_text_chars"]["max"], len(display))
        self.assertEqual(measured["current_frame"]["history_text_chars"]["max"], 0)

    def test_character_units_preserve_non_bmp_and_unpaired_surrogate_text(self):
        envelope, display, protocol, status = self.fixture()
        unusual = "🧪\ud800"
        envelope["request"]["compiledPrompt"] = display + unusual + protocol
        envelope["providerRequest"]["messages"][-1]["content"] = display + unusual + protocol + status
        measured = self.measure(envelope)
        self.assertEqual(measured["character_unit"], "unicode_codepoints")
        self.assertEqual(measured["working_frame_text_chars"]["max"], len(display) + 2)
        utf16_units = len((display + unusual).encode("utf-16-le", "surrogatepass")) // 2
        self.assertGreater(utf16_units, measured["working_frame_text_chars"]["max"])

    def test_missing_or_mismatched_identity_payload_and_protocol_remain_unknown(self):
        for mode in ("material", "frame_id", "material_ref", "status", "compiled", "sdk", "role", "protocol", "duplicate"):
            envelope, _, _, _ = self.fixture()
            if mode == "material": envelope["request"]["materials"] = []
            if mode == "frame_id": envelope["request"]["contextStatus"]["frameId"] = "older"
            if mode == "material_ref": envelope["request"]["materials"][0]["ref"] = "older"
            if mode == "status": envelope["request"].pop("contextStatus")
            if mode == "compiled": envelope["request"].pop("compiledPrompt")
            if mode == "sdk": envelope["providerRequest"]["messages"][-1]["content"] += " changed"
            if mode == "role": envelope["providerRequest"]["messages"][-1]["role"] = "assistant"
            if mode == "protocol": envelope["request"]["compiledPrompt"] = "unframed text"
            if mode == "duplicate":
                content = envelope["providerRequest"]["messages"][-1]["content"]
                envelope["providerRequest"]["messages"][-1]["content"] = [{"text": content}, {"text": content}]
            with self.subTest(mode=mode):
                measured = self.measure(envelope)
                self.assertIsNone(measured["working_frame_text_chars"])
                self.assertEqual(measured["current_frame"]["unverified_requests"], 1)
                self.assertIsNone(measured["current_frame"]["frames"][0]["display_chars"])

    def test_task_text_resembling_runtime_and_old_full_messages_cannot_establish_current_frame(self):
        envelope, _, _, _ = self.fixture()
        old = envelope["providerRequest"]["messages"][-1]
        envelope["providerRequest"]["messages"] = [old, {"role": "user", "content": "Task quotes Runtime 本帧工作内存（origin=runtime-view）"}]
        measured = self.measure(envelope)
        self.assertIsNone(measured["working_frame_text_chars"])
        self.assertEqual(measured["current_frame"]["verified_requests"], 0)

    def test_current_text_blocks_preserve_images_and_other_text_without_inflating_display(self):
        envelope, display, _, _ = self.fixture(delta=True)
        actual = envelope["providerRequest"]["messages"][-1]["content"]
        envelope["providerRequest"]["messages"][-1]["content"] = [
            {"type": "text", "text": "extra task material"}, {"type": "text", "text": actual},
            {"type": "image", "data": "not-a-text-character-count"}]
        measured = self.measure(envelope)
        self.assertEqual(measured["working_frame_text_chars"]["max"], len(display))
        self.assertEqual(measured["non_text_blocks"]["max"], 1)
        self.assertEqual(measured["current_frame"]["other_current_text_chars"]["max"], len("extra task material"))

    def test_malformed_raw_materials_remain_unknown_without_breaking_report_measurement(self):
        for body in ("not json", "[]", "null", '"text"', '42', '{"partitions": []}', '{"partitions": null}'):
            envelope, _, _, _ = self.fixture()
            envelope["request"]["materials"][0]["text"] = body
            with self.subTest(body=body):
                measured = self.measure(envelope)
                self.assertIsNone(measured["working_frame_text_chars"])
                self.assertEqual(measured["current_frame"]["unverified_requests"], 1)
                self.assertEqual(measured["raw_partition_json_chars"], {})
                self.assertEqual(measured["raw_partition_measurement"]["unverified_requests"], 1)
                self.assertIsNotNone(measured["raw_partition_measurement"]["frames"][0]["reason"])
                self.assertIsNotNone(measured["provider_text_chars"])
        valid, _, _, _ = self.fixture()
        measured = self.measure(valid)
        self.assertEqual(measured["raw_partition_measurement"]["verified_requests"], 1)
        self.assertEqual(measured["raw_partition_json_chars"]["task"]["max"], 2)

    def test_ambiguous_and_wrongly_typed_materials_do_not_create_partition_sizes(self):
        for mode in ("duplicate", "non_dictionary", "wrong_material_list", "wrong_host"):
            envelope, _, _, _ = self.fixture()
            if mode == "duplicate": envelope["request"]["materials"] *= 2
            if mode == "non_dictionary": envelope["request"]["materials"] = ["runtime-view"]
            if mode == "wrong_material_list": envelope["request"]["materials"] = {"origin": "runtime-view"}
            if mode == "wrong_host": envelope["request"] = "not a request"
            with self.subTest(mode=mode):
                measured = self.measure(envelope)
                self.assertIsNone(measured["working_frame_text_chars"])
                self.assertEqual(measured["raw_partition_json_chars"], {})
                self.assertEqual(measured["raw_partition_measurement"]["unverified_requests"], 1)


if __name__ == "__main__":
    unittest.main()
