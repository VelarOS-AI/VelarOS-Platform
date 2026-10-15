"""Identity, provenance and incomplete-evidence boundaries; no API/Docker calls."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from evidence_index import BENCH, _cli_events, collect_campaign_evidence
from parallel_campaign import phase_identity

PRIVATE = "secret-payload-never-exported"


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class EvidenceIndexTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve() / "bench"
        self.root.mkdir()
        self.state = self.root / "controller"
        self.state.mkdir()
        self.path = self.root / "manifest.json"
        self.manifest = {"model": "fixture-model", "reasoning_effort": "high",
            "participants": {"scriptact": {"agent": "adapter:RepositoryScriptAct"},
                             "codex": {"agent": "adapter:RepositoryCodex"}},
            "attempts": [{"participant": name, "task": "fixture-task", "source_job": name + "-source", "replay_job": name + "-replay"}
                         for name in ("scriptact", "codex")]}
        write(self.path, self.manifest)
        self.manifest_hash = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.trials, self.receipts = {}, {}
        self.calls = []
        for number, attempt in enumerate(self.manifest["attempts"], 1):
            for phase in ("source", "replay"):
                identity = phase_identity(self.manifest, self.manifest_hash, number, phase)
                job = self.root / "jobs" / identity["jobId"]
                trial = job / (attempt["task"] + "__unique")
                self.trials[number, phase] = trial
                write(job / "request-identity.json", identity)
                write(job / "config.json", {"agents": [{"model_name": "openai/fixture-model"}]})
                write(job / "result.json", {"completed_trials": 1})
                write(trial / "config.json", {"task": {"path": "/dataset/fixture-task"}})
                write(trial / "result.json", {"task_name": "dataset/fixture-task", "trial_name": trial.name,
                    "finished_at": "2026-01-01T00:01:00Z"})
                receipt = self.root / "campaign" / (identity["jobId"] + "-dispatch.json")
                self.receipts[number, phase] = receipt
                write(receipt, {"manifest_sha256": self.manifest_hash, "request_identity": identity, "phase": phase,
                    "status": "finished", "finished_at": "2026-01-01T00:01:01Z", "trial_result": str(trial / "result.json")})
                write(trial / "agent/trajectory.json", {"session_id": "fixture", "steps": []})
                if phase != "source":
                    continue
                self.calls.append({"id": "request-" + str(number), "identity": identity, "finishedAt": "2026-01-01T00:01:00Z",
                                   "estimatedUsd": None if number == 2 else .1,
                                   "model": "fixture-model", "metadata": {"reasoningEffort": "high"}})
                if number == 1:
                    write(trial / "agent/status.json", {"status": "completed", "traceProgress": {"provisional": False}})
                    self.set_trace({"traces": [{"sessionId": "fixture", "turnId": "turn-1", "request": {"body": json.dumps({
                        "providerRequest": {"messages": [{"role": "user", "content": PRIVATE}]}})}}]})
                else:
                    (trial / "agent/codex.txt").write_text('Reading additional input from stdin...\n' +
                        json.dumps({"type": "thread.started", "thread_id": "bound-thread"}) + '\n' +
                        json.dumps({"type": "turn.started"}) + '\n' +
                        json.dumps({"type": "turn.completed"}) + '\n')
                    native = trial / "agent/sessions/2026/01/01/native.jsonl"
                    native.parent.mkdir(parents=True)
                    native.write_text(json.dumps({"type": "session_meta", "payload": {"id": "bound-thread"}}) + '\n' +
                        json.dumps({"type": "response_item", "payload": {"content": PRIVATE}}) + '\n')
        self.ledger = self.root / "gateway/budget.json"
        write(self.ledger, {"requests": self.calls})

    def tearDown(self):
        self.temporary.cleanup()

    def set_trace(self, value):
        write(self.trials[1, "source"] / "agent/traces.json", value)

    def collect(self, **kwargs):
        return collect_campaign_evidence(self.manifest, self.state, manifest_path=self.path,
                                        bench_directory=self.root, ledger_path=self.ledger, **kwargs)

    def test_complete_metadata_index_has_stable_fingerprint_and_no_payload(self):
        first, second = self.collect(), self.collect()
        self.assertEqual(first["status"], "complete")
        self.assertEqual(first["input_fingerprint"], second["input_fingerprint"])
        self.assertNotIn(PRIVATE, json.dumps(first))
        self.assertEqual(first["ledger"]["unknown_cost_requests"], 1)
        self.assertEqual(len(first["attempts"][1]["phases"]["source"]["native_sources"]), 1)
        self.assertEqual(first["attempts"][1]["phases"]["source"]["native_cli_format"]["prefix_text_lines"], 1)
        self.assertTrue(all(row["sha256"] and row["size_bytes"] is not None for row in first["artifacts"] if row["state"] == "verified"))

    def test_unstarted_and_active_are_not_terminal_or_reusable(self):
        receipt = self.receipts[1, "source"]
        value = json.loads(receipt.read_text()); value.update(status="running", finished_at=None); write(receipt, value)
        self.assertEqual(self.collect()["status"], "partial")
        receipt.unlink(); shutil.rmtree(self.trials[1, "source"].parent)
        self.assertEqual(self.collect()["status"], "unknown")  # A paid ledger row forbids guessing unstarted.
        write(self.ledger, {"requests": self.calls[1:]})
        index = self.collect()
        self.assertEqual(index["status"], "partial")
        self.assertEqual(index["attempts"][0]["phases"]["source"]["state"], "unstarted")

    def test_identity_conflicts_never_import_another_attempts_trace(self):
        value = json.loads(self.receipts[1, "source"].read_text())
        value["request_identity"]["attemptId"] = "other-attempt"
        write(self.receipts[1, "source"], value)
        index = self.collect()
        self.assertEqual(index["status"], "unknown")
        self.assertNotIn("sdk_records", index["attempts"][0]["phases"]["source"])

    def test_duplicate_trial_and_external_receipt_paths_block_discovery(self):
        extra = self.trials[1, "source"].parent / "foreign-trial"
        write(extra / "config.json", {"task": {"path": "/dataset/fixture-task"}})
        self.assertEqual(self.collect()["status"], "unknown")
        shutil.rmtree(extra)
        value = json.loads(self.receipts[1, "source"].read_text()); value["trial_result"] = str(self.root.parent / "private.json")
        write(self.receipts[1, "source"], value)
        self.assertEqual(self.collect()["status"], "unknown")

    def test_file_directory_and_ancestor_symlinks_are_not_read(self):
        private = self.root.parent / "private.json"; private.write_text(PRIVATE)
        trace = self.trials[1, "source"] / "agent/traces.json"; trace.unlink(); trace.symlink_to(private)
        index = self.collect()
        row = next(row for row in index["artifacts"] if row["role"] == "scriptact_trace")
        self.assertIsNone(row["sha256"])
        self.assertEqual(index["status"], "unknown")
        alias = self.root.parent / "alias"; alias.symlink_to(self.root, target_is_directory=True)
        index = collect_campaign_evidence(self.manifest, alias / "controller", manifest_path=alias / "manifest.json",
                                          bench_directory=alias, ledger_path=alias / "gateway/budget.json")
        self.assertEqual(index["status"], "unknown")
        self.assertFalse(any(row["state"] == "verified" for row in index["artifacts"]))

    def test_formal_decoder_verifies_blob_hash_and_session_identity(self):
        invocation = json.dumps({"id": "call-1", "body": PRIVATE})
        digest = hashlib.sha256(invocation.encode()).hexdigest()
        blob = self.trials[1, "source"] / "agent/trace-invocations.jsonl"
        row = {"schema": 1, "sessionId": "fixture", "id": "call-1", "sha256": digest, "json": invocation}
        blob.write_text(json.dumps(row) + '\n')
        self.set_trace({"artifactSchema": 2, "data": {"traces": [{"sessionId": "fixture", "request": {"body": json.dumps({"providerRequest": {"messages": []}})},
            "invocations": [{"sessionId": "fixture", "id": "call-1", "sha256": digest}]}]}})
        self.assertEqual(self.collect()["status"], "complete")
        row["sha256"] = "0" * 64; blob.write_text(json.dumps(row) + '\n')
        self.assertEqual(self.collect()["status"], "unknown")
        row["sha256"] = digest; row["sessionId"] = "other"; blob.write_text(json.dumps(row) + '\n')
        self.assertEqual(self.collect()["status"], "unknown")

    def test_final_turn_files_are_bound_to_the_evidence_index(self):
        agent = self.trials[1, "source"] / "agent"
        (agent / "trace-invocations.jsonl").write_text('')
        turn = {"sessionId": "fixture", "turnId": "turn-1", "invocations": [],
                "request": {"body": json.dumps({"providerRequest": {"messages": []}})}}
        raw = json.dumps(turn).encode()
        digest = hashlib.sha256(raw).hexdigest()
        body = agent / "trace-turns" / (digest + ".json")
        body.parent.mkdir()
        body.write_bytes(raw)
        self.set_trace({"artifactSchema": 3, "data": {"traces": [
            {"sessionId": "fixture", "id": "turn-1", "sha256": digest}]}})
        index = self.collect()
        self.assertEqual(index["status"], "complete")
        self.assertTrue(any(item["role"] == "scriptact_turn" and item["sha256"] == digest for item in index["artifacts"]))
        body.write_text('{}')
        self.assertEqual(self.collect()["status"], "unknown")
        body.unlink()
        self.assertEqual(self.collect()["status"], "unknown")

    def test_missing_sdk_body_and_partial_trace_are_unknown(self):
        self.set_trace({"traces": [{"request": {}}]})
        self.assertEqual(self.collect()["status"], "partial")
        (self.trials[1, "source"] / "agent/traces.json").write_text('{"traces":')
        self.assertEqual(self.collect()["status"], "unknown")

    def test_native_foreign_session_and_truncated_jsonl_are_not_reused(self):
        native = self.trials[2, "source"] / "agent/sessions/2026/01/01/native.jsonl"
        native.write_text(json.dumps({"type": "session_meta", "payload": {"id": "foreign"}}) + '\n')
        index = self.collect()
        self.assertEqual(index["status"], "partial")
        self.assertEqual(index["attempts"][1]["phases"]["source"]["native_sources"], [])
        self.assertEqual(next(row for row in index["artifacts"] if row["role"] == "codex_native_session_jsonl")["state"], "excluded")
        native.write_text('{"type":"session_meta"')
        self.assertEqual(self.collect()["status"], "partial")

    def test_cli_bad_json_or_missing_tail_is_unknown_without_leaking_text(self):
        cli = self.trials[2, "source"] / "agent/codex.txt"
        for tail in ('{"type":\n', '{"type":"turn.completed"}'):
            cli.write_text(json.dumps({"type": "thread.started", "thread_id": "bound-thread"}) + '\n' + tail)
            self.assertEqual(self.collect()["status"], "partial")

    def test_interleaved_diagnostics_and_continuations_keep_locations_without_payload(self):
        cli = self.trials[2, "source"] / "agent/codex.txt"
        lines = ['startup notice ' + PRIVATE,
                 json.dumps({"type": "thread.started", "thread_id": "bound-thread"}),
                 json.dumps({"type": "turn.started"}),
                 '\x1b[31m arbitrary diagnostic ' + PRIVATE,
                 '    continuation ' + PRIVATE,
                 json.dumps({"type": "item.completed", "item": {"id": "failed-tool", "type": "command_execution", "exit_code": 7, "status": "failed"}}),
                 json.dumps({"type": "turn.completed"}), 'late stderr ' + PRIVATE]
        cli.write_text('\n'.join(lines) + '\n')
        index = self.collect()
        self.assertEqual(index["status"], "complete")
        phase = index["attempts"][1]["phases"]["source"]
        metadata = phase["native_cli_format"]
        self.assertEqual(metadata["diagnostic_text_lines"], 4)
        self.assertEqual(metadata["interleaved_text_lines"], 3)
        self.assertEqual([row["line"] for row in metadata["diagnostic_records"]], [1, 4, 5, 8])
        self.assertEqual(metadata["diagnostic_records"][1]["sha256"], hashlib.sha256(lines[3].encode()).hexdigest())
        self.assertEqual(metadata["error_event_count"], 1)
        self.assertEqual(metadata["error_event_records"][0]["line"], 6)
        self.assertEqual(len(phase["native_sources"]), 1)
        self.assertNotIn(PRIVATE, json.dumps(index))

    def test_damaged_json_candidates_and_non_event_objects_remain_unknown(self):
        cli = self.trials[2, "source"] / "agent/codex.txt"
        prefix = cli.read_text()
        for candidate in ('{"type":', '[{"type":"error"}', '[1,2]', '{"level":"error"}', '{"type":7}'):
            with self.subTest(candidate=candidate):
                cli.write_text(prefix + 'diagnostic ' + PRIVATE + '\n' + candidate + '\n')
                index = self.collect()
                self.assertEqual(index["status"], "partial")
                metadata = index["attempts"][1]["phases"]["source"]["native_cli_format"]
                self.assertEqual(metadata["state"], "unknown")
                self.assertEqual(metadata["diagnostic_text_lines"], 2)
                self.assertEqual(len(metadata["invalid_records"]), 1)
                self.assertNotIn(PRIVATE, json.dumps(index))

    def test_cli_turn_identity_shape_and_terminal_are_not_guessed(self):
        cli = self.trials[2, "source"] / "agent/codex.txt"
        good = [{'type': 'thread.started', 'thread_id': 'bound-thread'}, {'type': 'turn.started'}]
        cases = [good, good + [{'type': 'turn.completed', 'thread_id': 'foreign'}],
                 good + [{'type': 'item.completed', 'item': []}, {'type': 'turn.completed'}],
                 good + [{'type': 'turn.completed'}, {'type': 'thread.started', 'thread_id': 'other'}],
                 good + [{'type': 'item.started', 'item': {'id': 'unfinished', 'type': 'command_execution'}}, {'type': 'turn.completed'}],
                 [good[0], {'type': 'turn.completed'}], good + [{'type': 'future.unknown'}, {'type': 'turn.completed'}]]
        for events in cases:
            with self.subTest(events=events):
                cli.write_text('\n'.join(json.dumps(event) for event in events) + '\n')
                self.assertEqual(self.collect()["status"], "partial")

    def test_structured_cli_errors_are_retained_even_when_later_turn_recovers(self):
        cli = self.trials[2, "source"] / "agent/codex.txt"
        events = [{'type': 'thread.started', 'thread_id': 'bound-thread'}, {'type': 'turn.started'},
                  {'type': 'error', 'message': PRIVATE}, {'type': 'turn.failed', 'error': {'message': PRIVATE}},
                  {'type': 'turn.started'}, {'type': 'turn.completed'}]
        cli.write_text('\n'.join(json.dumps(event) for event in events) + '\n')
        index = self.collect()
        self.assertEqual(index["status"], "complete")
        lifecycle = index["attempts"][1]["phases"]["source"]["native_cli_lifecycle"]
        self.assertEqual(len(lifecycle["error_events"]), 1)
        self.assertEqual(len(lifecycle["failed_turns"]), 1)
        self.assertEqual(lifecycle["threads"]["bound-thread"]["terminal_turns"], 2)
        self.assertNotIn(PRIVATE, json.dumps(index))

    def test_missing_and_cross_thread_native_exports_cannot_be_complete(self):
        native = self.trials[2, "source"] / "agent/sessions/2026/01/01/native.jsonl"
        original = native.read_text()
        native.unlink()
        self.assertEqual(self.collect()["status"], "partial")
        for row in ({'type': 'event_msg', 'payload': {'thread_id': 'foreign'}},
                    {'type': 'session_meta', 'payload': {'id': 'bound-thread'}}):
            with self.subTest(row=row):
                native.write_text(original + json.dumps(row) + '\n')
                self.assertEqual(self.collect()["status"], "partial")

    def test_native_header_explicit_thread_identity_must_agree_with_session(self):
        native = self.trials[2, "source"] / "agent/sessions/2026/01/01/native.jsonl"
        original = [json.loads(line) for line in native.read_text().splitlines()]
        for position in ('row', 'payload'):
            for value in ('foreign', None, 7, ['bound-thread']):
                with self.subTest(position=position, value=value):
                    rows = json.loads(json.dumps(original))
                    owner = rows[0] if position == 'row' else rows[0]['payload']
                    owner['thread_id'] = value
                    native.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
                    index = self.collect()
                    self.assertEqual(index['status'], 'partial')
                    self.assertEqual(index['attempts'][1]['phases']['source']['native_sources'], [])
                    artifact = next(row for row in index['artifacts'] if row['role'] == 'codex_native_session_jsonl')
                    self.assertEqual(artifact['state'], 'unknown')
                    self.assertEqual(artifact['reason'], 'native_session_integrity_or_identity_invalid')
        original[0]['thread_id'] = 'bound-thread'
        original[0]['payload']['thread_id'] = 'bound-thread'
        native.write_text('\n'.join(json.dumps(row) for row in original) + '\n')
        valid = self.collect()
        self.assertEqual(valid['status'], 'complete')
        self.assertEqual(len(valid['attempts'][1]['phases']['source']['native_sources']), 1)

    def test_cli_reader_reports_all_diagnostics_when_a_later_candidate_is_damaged(self):
        lines = ['before', '{"type":"thread.started","thread_id":"bound-thread"}',
                 'middle', '{"type":', 'continuation', '{"type":"turn.completed"}',
                 json.dumps({'type': 'error', 'message': PRIVATE})]
        events, metadata = _cli_events(('\n'.join(lines) + '\n').encode())
        self.assertEqual(metadata["state"], "unknown")
        self.assertEqual([row["line"] for row in metadata["diagnostic_records"]], [1, 3, 5])
        self.assertEqual(metadata["invalid_records"][0]["line"], 4)
        self.assertEqual(len(events), 3)
        self.assertEqual(metadata["error_event_count"], 1)
        self.assertEqual(metadata["error_event_records"][0]["line"], 7)
        self.assertNotIn(PRIVATE, json.dumps(metadata))

    def test_ledger_replay_duplicate_and_wrong_model_are_blockers(self):
        for mode in ("replay", "duplicate", "model"):
            rows = json.loads(json.dumps(self.calls))
            if mode == "replay": rows[0]["identity"] = phase_identity(self.manifest, self.manifest_hash, 1, "replay")
            if mode == "duplicate": rows.append(rows[0])
            if mode == "model": rows[0]["model"] = "other-model"
            write(self.ledger, {"requests": rows})
            self.assertEqual(self.collect()["status"], "unknown")

    def test_live_ledger_changes_fingerprint_and_keeps_unknown_cost(self):
        first = self.collect()
        rows = json.loads(json.dumps(self.calls)); rows[0]["finishedAt"] = None
        write(self.ledger, {"requests": rows})
        second = self.collect()
        self.assertEqual(second["status"], "partial")
        self.assertEqual(second["ledger"]["active_requests"], 1)
        self.assertEqual(second["ledger"]["unknown_cost_requests"], 1)
        self.assertNotEqual(first["input_fingerprint"], second["input_fingerprint"])

    def test_manifest_binding_and_partial_resources_are_explicit(self):
        index = collect_campaign_evidence(self.manifest, self.state, bench_directory=self.root)
        self.assertEqual(index["status"], "unknown")
        resource = self.state / "resources.jsonl"; resource.write_text('{"containers":[]')
        index = self.collect(resource_paths=(resource,))
        self.assertEqual(index["status"], "partial")
        self.assertTrue(any(row["code"] == "resource_jsonl_incomplete_or_invalid" for row in index["issues"]))


class ArchivedCanaryTest(unittest.TestCase):
    def test_finalized_r_q_and_old_n_archives_use_exact_jobs_and_native_paths(self):
        base = BENCH / "parallel-54"
        for suffix, expected_frames in (("r", 7), ("q", 8), ("n-v2", 19)):
            with self.subTest(campaign=suffix):
                path = base / f"parallel-54{suffix}-manifest.json"
                if not path.exists():
                    self.skipTest("Workspace finalized canary archives unavailable")
                raw = path.read_bytes(); manifest = json.loads(raw)
                index = collect_campaign_evidence(manifest, base / f"controller-{suffix}", manifest_path=path)
                self.assertEqual(index["status"], "complete")
                self.assertEqual(index["manifest_sha256"], hashlib.sha256(raw).hexdigest())
                phases = [attempt["phases"]["source"] for attempt in index["attempts"]]
                self.assertEqual(sum(len(phase.get("sdk_records", [])) for phase in phases), expected_frames)
                self.assertEqual(sum(len(phase.get("native_sources", [])) for phase in phases), 1)
                self.assertTrue(all(phase["state"] == "terminal" for attempt in index["attempts"] for phase in attempt["phases"].values()))
                self.assertEqual(path.read_bytes(), raw)


if __name__ == "__main__":
    unittest.main()
