"""Synthetic Oracle lifecycle tests: no Docker, task bodies, reference patch or model calls."""
import contextlib
import asyncio
import contextvars
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import copy
import hashlib
import io
import json
import signal
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import repository_oracle as subject
from request_identity import prepare_attempt_environment, attempt_credential, authenticate_attempt
from resource_leases import DispatchError, ResourceLeases
from worker_admission import admission_session
from worker_admission_test import passed_probe


class OracleTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self, **changes):
        with tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as stack:
            bench = Path(temporary)
            task = bench / "tasks/synthetic"
            task.mkdir(parents=True)
            (task / "task.toml").write_text('[environment]\ncpus=1\nmemory_mb=4096\nstorage_mb=10240\n')
            gateway = bench / "gateway"
            gateway.mkdir()
            (gateway / "gateway-token").write_text("synthetic-controller-key")
            old = {"id": "old-finished-unknown", "status": "unknown", "finishedAt": "synthetic", "usage": None}
            (gateway / "budget.json").write_text(json.dumps({"requests": [old]}))
            participant = {"agent": "synthetic", "model": "openai/fixture", "kwargs": {"reasoning_effort": "high"}}
            manifest = {"model": "fixture", "reasoning_effort": "high",
                "gateway": {"directory": str(gateway), "url": "http://127.0.0.1:12345", "budget_mode": "unlimited"},
                "vm": {"profile": "scriptact-bench", "cpus": 2, "memory_bytes": 8192 * 1024 ** 2},
                "resource_pool": {"max_active_attempts": 2, "cpus": 2, "memory_mb": 8192},
                "participants": {"fixture": participant}, "execution_env": {"COMPAT_MODE": "synthetic"},
                "tasks": {"synthetic": {"files_sha256": {"task.toml": subject.digest(task / "task.toml")}}},
                "files_sha256": {"scripts/agent/harbor/repository_oracle.py": subject.digest(subject.__file__)},
                "attempts": [{"task": "synthetic", "participant": "fixture", "source_job": "source", "replay_job": "replay"}]}
            manifest_path = bench / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            official_source = bench / "official-agent.py"
            official_source.write_text('# synthetic installed agent identity only\n')
            output = bench / "evidence/oracle.json"
            argv = ["repository_oracle.py", "--manifest", str(manifest_path), "--job-name", "synthetic-oracle", "--output", str(output)]
            env = {"OPENAI_API_KEY": "synthetic-controller-key", "ANTHROPIC_API_KEY": "synthetic-controller-key",
                "SCRIPTACT_BENCH_TOKEN_FILE": str(gateway / "gateway-token"), "OPENAI_BASE_URL": "http://127.0.0.1:12345/v1",
                "SCRIPTACT_GATEWAY_HEALTH_URL": "http://127.0.0.1:12345/health",
                "DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
                "DOCKER_CONFIG": str(bench / "docker-config"), "PATH": "/usr/bin", "HOME": str(bench), "PYTHONPATH": "synthetic"}
            ready = {"attribution": "signed-attempt-v1", "model": "fixture", "reasoningEffort": "high", "budgetMode": "unlimited",
                "limitUsd": None, "authenticationBlocker": None, "activeUpstreamRequests": 0, "scheduler": {"active": 0, "queued": 0},
                "requests": 0, "rejectedRequests": 0, "unknownUsage": 0}
            state = {"reward": 1, "exit": 0, "exception": None, "raise": None, "cleanup_error": None, "after_requests": 0,
                     "after_rejected": 0, "ledger_change": None, "before_run": None, "job_result": True, "trial_result": True,
                     "identity_mutation": None, **changes}
            def health(environment):
                if environment.get("OPENAI_API_KEY") == "synthetic-controller-key":
                    return copy.deepcopy(ready)
                value = copy.deepcopy(ready)
                if runner.call_count:
                    value.update(requests=state["after_requests"], rejectedRequests=state["after_rejected"])
                return value
            def run(command, **kwargs):
                self.assertIsInstance(kwargs["cancelled"], threading.Event)
                child_env = kwargs["environment"]
                self.assertFalse(set(child_env) & {"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL"})
                self.assertEqual(child_env["SCRIPTACT_GATEWAY_HEALTH_URL"], "http://127.0.0.1:12345/health")
                self.assertEqual(Path(child_env["SCRIPTACT_BENCH_TOKEN_FILE"]).parent, bench / "campaign/attempt-credentials")
                self.assertNotIn("synthetic-controller-key", json.dumps(child_env) + json.dumps(command))
                self.assertEqual(command[command.index("-a") + 1], "oracle")
                self.assertEqual(command[command.index("--max-retries") + 1], "0")
                job = bench / "jobs/synthetic-oracle"
                trial = job / "trial"
                trial.mkdir(parents=True)
                job_id = str(uuid.uuid4())
                config = {"task": {"path": str(task.resolve())}, "trial_name": trial.name, "trials_dir": str(job.resolve()),
                    "job_id": job_id, "agent": {"name": "oracle"}}
                result = {"id": str(uuid.uuid4()), "task_name": "synthetic", "task_id": {"path": str(task.resolve())},
                    "trial_name": trial.name, "trial_uri": trial.resolve().as_uri(), "config": copy.deepcopy(config),
                    "finished_at": "synthetic", "exception_info": state["exception"],
                    "verifier_result": {"rewards": {"reward": state["reward"]}}}
                if state["identity_mutation"]:
                    state["identity_mutation"](result, config)
                if state["job_result"]:
                    (job / "result.json").write_text(json.dumps({"id": job_id, "finished_at": "synthetic"}))
                (trial / "config.json").write_text(json.dumps(config))
                if state["trial_result"]:
                    (trial / "result.json").write_text(json.dumps(result))
                if state["ledger_change"]:
                    (gateway / "budget.json").write_text(json.dumps({"requests": [old, state["ledger_change"]]}))
                if state["before_run"]:
                    state["before_run"](kwargs)
                if state["raise"]:
                    raise state["raise"]
                return state["exit"]
            def cleanup(*_args):
                if state["cleanup_error"]:
                    raise state["cleanup_error"]
            stack.enter_context(patch("sys.argv", argv))
            stack.enter_context(patch.object(subject, "BENCH", bench))
            stack.enter_context(patch.object(subject, "DATASET", bench / "dataset"))
            stack.enter_context(patch.object(subject, "environment", return_value=env))
            stack.enter_context(patch.object(subject, "validate", return_value=(task, participant)))
            stack.enter_context(patch.object(subject.importlib.util, "find_spec", return_value=SimpleNamespace(origin=str(official_source))))
            probe = stack.enter_context(patch("worker_admission.disk_admission.probe", side_effect=passed_probe))
            credentials = stack.enter_context(patch.object(subject, "prepare_attempt_environment", wraps=prepare_attempt_environment))
            runner = stack.enter_context(patch.object(subject, "run_attempt_process", side_effect=run))
            stack.enter_context(patch.object(subject, "health", side_effect=health))
            checked = stack.enter_context(patch.object(subject, "verify_job_containers_stopped", side_effect=cleanup))
            stdout = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield {"bench": bench, "manifest": manifest, "manifest_path": manifest_path, "output": output, "argv": argv,
                   "gateway": gateway, "probe": probe, "runner": runner, "credentials": credentials, "cleanup": checked,
                   "state": state, "stdout": stdout}

    def resources(self, fixture):
        return json.loads((fixture["bench"] / "campaign/resource-leases/resources.json").read_text())

    def receipt(self, fixture):
        return json.loads(fixture["output"].read_text())

    def freeze(self, fixture):
        fixture["manifest_path"].write_text(json.dumps(fixture["manifest"]))

    def test_healthy_oracle_has_zero_models_and_released_bound_admission(self):
        with self.fixture() as f:
            before = (f["gateway"] / "budget.json").read_bytes()
            subject.main()
            data, resources = self.receipt(f), self.resources(f)
            self.assertEqual(data["status"], "healthy")
            self.assertEqual(data["reward"], 1)
            self.assertEqual(data["request_identity"]["phase"], "install")
            self.assertEqual(data["request_identity"]["participantId"], "official-oracle-preflight")
            self.assertTrue(data["ledger_request_set_unchanged"])
            self.assertTrue(data["containers_stopped"])
            self.assertTrue(data["physical_settlement_confirmed"])
            self.assertIsNone(resources["admission"])
            self.assertEqual(resources["leases"], {})
            self.assertEqual(resources["admission_history"][-1]["admission_id"], data["admission_id"])
            self.assertEqual(resources["history"][-1]["identity"], data["request_identity"])
            self.assertEqual((f["gateway"] / "budget.json").read_bytes(), before)
            self.assertEqual(f["runner"].call_count, 1)
            self.assertEqual(f["probe"].call_count, 1)
            self.assertNotIn("synthetic-controller-key", f["output"].read_text() + f["stdout"].getvalue())

    def test_disk_rejection_is_before_receipt_log_credentials_and_can_retry(self):
        with self.fixture() as f:
            f["probe"].side_effect = lambda *_a, **_k: {"status": "blocked"}
            with self.assertRaises(DispatchError):
                subject.main()
            self.assertFalse(f["output"].exists())
            self.assertFalse(f["output"].with_suffix(".log").exists())
            f["credentials"].assert_not_called()
            f["runner"].assert_not_called()
            self.assertIsNone(self.resources(f)["admission"])
            f["probe"].side_effect = passed_probe
            subject.main()
            self.assertEqual(self.receipt(f)["status"], "healthy")

    def test_parent_exact_join_does_not_probe_or_retire_parent(self):
        with self.fixture() as f:
            manifest_hash = subject.digest(f["manifest_path"])
            scope = subject.oracle_scope(f["manifest"], manifest_hash, "synthetic", "synthetic-oracle", "parent")
            scope["kind"] = "batch"
            scope["batch_id"] = "oracle-and-install"
            pool = ResourceLeases(f["bench"] / "campaign/resource-leases", f["manifest"]["resource_pool"])
            with admission_session(pool, scope, manifest_path=f["manifest_path"], bench=f["bench"], tasks_root=f["bench"], probe_fn=passed_probe) as handle:
                with patch("sys.argv", f["argv"] + ["--admission-id", handle.admission_id]):
                    subject.main()
                self.assertEqual(self.resources(f)["admission"]["status"], "admitted")
                self.assertEqual(self.receipt(f)["admission_scope"], scope)
                self.assertEqual(self.receipt(f)["admission_id"], handle.admission_id)
            f["probe"].assert_not_called()

    def test_parent_wrong_identity_refuses_before_all_attempt_artifacts(self):
        with self.fixture() as f:
            h = subject.digest(f["manifest_path"])
            scope = subject.oracle_scope(f["manifest"], h, "synthetic", "different-job", "parent")
            pool = ResourceLeases(f["bench"] / "campaign/resource-leases", f["manifest"]["resource_pool"])
            with admission_session(pool, scope, manifest_path=f["manifest_path"], bench=f["bench"], tasks_root=f["bench"], probe_fn=passed_probe) as handle:
                with patch("sys.argv", f["argv"] + ["--admission-id", handle.admission_id]), self.assertRaises(DispatchError):
                    subject.main()
            self.assertFalse(f["output"].exists())
            f["runner"].assert_not_called()
            f["credentials"].assert_not_called()

    def test_known_reward_failure_releases_resources_but_stays_failed(self):
        for reward in (0, True, "1", None):
            with self.subTest(reward=reward), self.fixture(reward=reward) as f:
                with self.assertRaises(DispatchError):
                    subject.main()
                data = self.receipt(f)
                self.assertEqual(data["status"], "failed")
                self.assertEqual(data["error_code"], "ORACLE_NOT_HEALTHY")
                self.assertTrue(data["physical_settlement_confirmed"])
                self.assertIsNone(self.resources(f)["admission"])
                self.assertEqual(self.resources(f)["leases"], {})

    def test_known_process_failure_and_exception_preserve_failed_receipt_release(self):
        for change in ({"exit": 2}, {"exception": {"exception_type": "Synthetic"}}):
            with self.subTest(change=change), self.fixture(**change) as f:
                with self.assertRaises(DispatchError):
                    subject.main()
                self.assertEqual(self.receipt(f)["status"], "failed")
                self.assertTrue(self.receipt(f)["resource_lease_released"])
                self.assertIsNone(self.resources(f)["admission"])

    def test_unknown_container_cleanup_keeps_lease_and_epoch(self):
        with self.fixture(cleanup_error=DispatchError("ATTEMPT_CONTAINERS_ACTIVE", "synthetic")) as f:
            with self.assertRaises(DispatchError):
                subject.main()
            data, state = self.receipt(f), self.resources(f)
            self.assertEqual(data["status"], "blocked")
            self.assertFalse(data["physical_settlement_confirmed"])
            self.assertEqual(state["admission"]["status"], "blocked")
            self.assertEqual(next(iter(state["leases"].values()))["status"], "blocked")

    def test_unknown_provider_settlement_keeps_lease_even_if_container_stopped(self):
        with self.fixture() as f, patch.object(subject, "wait_for_settlement", side_effect=DispatchError("ATTEMPT_UNSETTLED", "synthetic")):
            with self.assertRaises(DispatchError):
                subject.main()
            self.assertEqual(self.receipt(f)["status"], "blocked")
            f["cleanup"].assert_called_once()
            self.assertEqual(self.resources(f)["admission"]["status"], "blocked")

    def test_cancel_settled_releases_but_unknown_cleanup_preserves(self):
        for unknown in (False, True):
            with self.subTest(unknown=unknown), self.fixture(**{"raise": KeyboardInterrupt(),
                    "before_run": lambda kwargs: kwargs["cancelled"].set(),
                    "cleanup_error": DispatchError("ATTEMPT_CLEANUP_UNKNOWN", "synthetic") if unknown else None}) as f:
                with self.assertRaises(KeyboardInterrupt):
                    subject.main()
                data = self.receipt(f)
                self.assertEqual(data["error_code"], "ORACLE_CANCELLED")
                self.assertEqual(data["status"], "blocked" if unknown else "failed")
                self.assertEqual(data["physical_settlement_confirmed"], not unknown)
                self.assertEqual(self.resources(f)["admission"] is None, not unknown)

    def test_scoped_or_ledger_model_request_fails_preflight_even_with_reward_one(self):
        for change in ({"after_requests": 1}, {"after_rejected": 1},
                       {"ledger_change": {"id": "new-actual-request", "usage": None, "finishedAt": "synthetic"}}):
            with self.subTest(change=change), self.fixture(**change) as f:
                with self.assertRaises(DispatchError):
                    subject.main()
                data = self.receipt(f)
                self.assertEqual(data["status"], "failed")
                self.assertEqual(data["validation_error_code"], "ORACLE_MODEL_REQUEST")
                self.assertTrue(data["physical_settlement_confirmed"])
                self.assertIsNone(self.resources(f)["admission"])

    def test_existing_receipt_or_log_cannot_be_overwritten(self):
        for kind in ("receipt", "log"):
            with self.subTest(kind=kind), self.fixture() as f:
                path = f["output"] if kind == "receipt" else f["output"].with_suffix(".log")
                path.parent.mkdir()
                path.write_text("preserve")
                with self.assertRaises(FileExistsError):
                    subject.main()
                self.assertEqual(path.read_text(), "preserve")
                f["probe"].assert_not_called()
                f["runner"].assert_not_called()

    def test_multitask_needs_explicit_attempt_and_job_alias_is_supported(self):
        with self.fixture() as f:
            f["manifest"]["attempts"].append({"task": "another", "participant": "fixture", "source_job": "other-source", "replay_job": "other-replay"})
            self.freeze(f)
            with self.assertRaises(ValueError):
                subject.main()
            argv = f["argv"].copy()
            argv[argv.index("--job-name")] = "--job"
            with patch("sys.argv", argv + ["--attempt", "1"]):
                subject.main()
            self.assertEqual(self.receipt(f)["task"], "synthetic")

    def test_missing_frozen_entrypoint_or_invalid_options_stop_without_probe(self):
        for option in ("unfrozen", "timeout", "job"):
            with self.subTest(option=option), self.fixture() as f:
                argv = f["argv"].copy()
                if option == "unfrozen":
                    f["manifest"]["files_sha256"] = {}
                    self.freeze(f)
                elif option == "timeout":
                    argv.extend(["--timeout", "nan"])
                else:
                    argv[argv.index("--job-name") + 1] = "../escape"
                with patch("sys.argv", argv), self.assertRaises(ValueError):
                    subject.main()
                f["probe"].assert_not_called()
                f["runner"].assert_not_called()

    def test_execution_environment_cannot_reintroduce_model_credentials(self):
        for key in ("OPENAI_API_KEY", "SCRIPTACT_BENCH_TOKEN_FILE", "OTHER_API_KEY", "ANTHROPIC_BASE_URL"):
            with self.subTest(key=key), self.fixture() as f:
                f["manifest"]["execution_env"][key] = "synthetic-secret"
                self.freeze(f)
                with self.assertRaises(ValueError):
                    subject.main()
                f["probe"].assert_not_called()
                self.assertNotIn("synthetic-secret", f["stdout"].getvalue())

    def test_signal_handlers_are_restored_and_no_auto_retry_of_failed_job(self):
        previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
        with self.fixture(reward=0) as f:
            with self.assertRaises(DispatchError):
                subject.main()
            with self.assertRaises(FileExistsError):
                subject.main()
            self.assertEqual(f["runner"].call_count, 1)
        self.assertEqual({number: signal.getsignal(number) for number in previous}, previous)

    def test_timeout_uses_event_and_settles_before_releasing(self):
        def wait_for_timeout(kwargs):
            self.assertTrue(kwargs["cancelled"].wait(.5), "wall deadline never reached the cancellation event")
            raise KeyboardInterrupt
        with self.fixture(before_run=wait_for_timeout) as f:
            with patch("sys.argv", f["argv"] + ["--timeout", "0.01"]), self.assertRaises(KeyboardInterrupt):
                subject.main()
            data = self.receipt(f)
            self.assertEqual(data["error_code"], "ORACLE_TIMEOUT")
            self.assertEqual(data["status"], "failed")
            self.assertTrue(data["containers_stopped"])
            self.assertTrue(data["resource_lease_released"])

    def test_stop_during_probe_never_creates_attempt_artifacts(self):
        with self.fixture() as f:
            def probe(*args, **kwargs):
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                return passed_probe(*args, **kwargs)
            f["probe"].side_effect = probe
            with self.assertRaises(DispatchError):
                subject.main()
            self.assertFalse(f["output"].exists())
            f["runner"].assert_not_called()
            f["credentials"].assert_not_called()
            self.assertIsNone(self.resources(f)["admission"])

    def test_frozen_manifest_mutation_is_failed_after_confirmed_cleanup(self):
        with self.fixture() as f:
            f["state"]["before_run"] = lambda _kwargs: f["manifest_path"].write_text(f["manifest_path"].read_text() + "\n")
            with self.assertRaises(DispatchError):
                subject.main()
            data = self.receipt(f)
            self.assertEqual(data["status"], "failed")
            self.assertEqual(data["validation_error_code"], "MANIFEST_CHANGED")
            self.assertTrue(data["physical_settlement_confirmed"])
            self.assertIsNone(self.resources(f)["admission"])

    def test_duplicate_or_conflicting_ledger_identity_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "budget.json"
            identity = subject.oracle_identity("a" * 64, "synthetic", "job")
            for rows in ([{"id": "same"}, {"id": "same"}], [{"id": "call", "identity": {**identity, "phase": "source"}}]):
                path.write_text(json.dumps({"requests": rows}))
                with self.assertRaises(DispatchError):
                    subject.ledger_snapshot(path, identity)

    def test_missing_result_or_incomplete_trial_cannot_be_healthy(self):
        for change in ({"job_result": False}, {"trial_result": False}):
            with self.subTest(change=change), self.fixture(**change) as f:
                with self.assertRaises(DispatchError):
                    subject.main()
                self.assertEqual(self.receipt(f)["status"], "failed")
                self.assertIsNone(self.resources(f)["admission"])

    def test_mismatched_task_trial_job_or_agent_cannot_borrow_reward_one(self):
        mutations = [lambda r, c: r["task_id"].update(path="/wrong-task"),
                     lambda r, c: r.update(task_name="wrong-task"),
                     lambda r, c: r.update(trial_name="wrong-trial"),
                     lambda r, c: r.update(trial_uri="file:///wrong-job/trial"),
                     lambda r, c: r["config"].update(job_id=str(uuid.uuid4())),
                     lambda r, c: c["task"].update(path="/wrong-task"),
                     lambda r, c: c["agent"].update(name="another-agent"),
                     lambda r, c: c.update(trials_dir="/wrong-job"),
                     lambda r, c: r["config"].update(install_only=True)]
        for index, mutate in enumerate(mutations):
            with self.subTest(shape=index), self.fixture(identity_mutation=mutate) as f:
                with self.assertRaises(DispatchError) as caught:
                    subject.main()
                self.assertEqual(caught.exception.code, "ORACLE_RESULT_IDENTITY")
                self.assertEqual(self.receipt(f)["status"], "failed")
                self.assertIsNone(self.resources(f)["admission"])

    def test_unexpected_runner_error_does_not_infer_host_process_exit_from_empty_containers(self):
        with self.fixture(**{"raise": OSError("synthetic unreaped runner")}) as f:
            with self.assertRaises(OSError):
                subject.main()
            data = self.receipt(f)
            self.assertTrue(data["containers_stopped"])
            self.assertFalse(data["harbor_process_settled"])
            self.assertFalse(data["physical_settlement_confirmed"])
            self.assertEqual(data["status"], "blocked")
            self.assertEqual(data["cleanup_error_code"], "ORACLE_PROCESS_SETTLEMENT_UNKNOWN")
            self.assertEqual(self.resources(f)["admission"]["status"], "blocked")

    def test_every_zero_model_counter_requires_explicit_integer_zero(self):
        healthy = {"requests": 0, "rejectedRequests": 0, "unknownUsage": 0,
                   "activeUpstreamRequests": 0, "scheduler": {"active": 0, "queued": 0}}
        subject.zero_requests(healthy)
        for path in (("requests",), ("rejectedRequests",), ("unknownUsage",),
                     ("activeUpstreamRequests",), ("scheduler", "active"), ("scheduler", "queued")):
            for bad in ("absent", False, 1, None, "0", 0.0):
                with self.subTest(path=path, value=bad):
                    state = copy.deepcopy(healthy)
                    target = state if len(path) == 1 else state["scheduler"]
                    if bad == "absent":
                        del target[path[-1]]
                    else:
                        target[path[-1]] = bad
                    with self.assertRaises(DispatchError):
                        subject.zero_requests(state)
        for malformed in (None, {}, {"scheduler": False}):
            with self.assertRaises(DispatchError):
                subject.zero_requests(malformed)

    def test_malformed_activity_cannot_release_physical_resources(self):
        with self.fixture() as f:
            invalid = {"requests": 0, "rejectedRequests": 0, "unknownUsage": 0,
                       "activeUpstreamRequests": False, "scheduler": {"active": 0, "queued": 0}}
            with patch.object(subject, "wait_for_settlement", return_value=invalid), self.assertRaises(DispatchError):
                subject.main()
            self.assertEqual(self.receipt(f)["status"], "blocked")
            self.assertFalse(self.receipt(f)["physical_settlement_confirmed"])
            self.assertEqual(self.resources(f)["admission"]["status"], "blocked")

    def test_actual_host_barrier_keeps_only_scoped_health_access_and_no_container_credentials(self):
        from scripts.agent.harbor.cancellable_environment import gateway_health
        from harbor.environments.base import BaseEnvironment
        from harbor.environments.docker.docker import DockerEnvironment
        observed = []
        identity = subject.oracle_identity("a" * 64, "synthetic", "local-oracle")
        signing_secret = "synthetic-local-signing-secret"
        credential = attempt_credential(identity, signing_secret)
        expected = {"requests": 0, "rejectedRequests": 0, "unknownUsage": 0,
                    "activeUpstreamRequests": 0, "scheduler": {"active": 0, "queued": 0}}
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                authorization = self.headers.get("Authorization", "")
                verified = authenticate_attempt(authorization.removeprefix("Bearer "), signing_secret)
                observed.append({"method": "GET", "path": self.path, "identity": verified})
                self.send_response(200 if verified == identity and self.path == "/health" else 403)
                self.end_headers()
                self.wfile.write(json.dumps(expected).encode())
            def log_message(self, *_args):
                pass
        with tempfile.TemporaryDirectory() as temporary, ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            token = Path(temporary) / "oracle-install.token"
            token.write_text(credential)
            token.chmod(0o600)
            host = {"SCRIPTACT_BENCH_TOKEN_FILE": str(token),
                "SCRIPTACT_GATEWAY_HEALTH_URL": f"http://127.0.0.1:{server.server_port}/health",
                "OPENAI_API_KEY": "synthetic-raw-upstream-key", "ANTHROPIC_API_KEY": "synthetic-raw-other-key",
                "OPENAI_BASE_URL": "https://provider.invalid/v1", "SCRIPTACT_BENCH_BASE_URL": "https://provider.invalid/v1",
                "PATH": "/usr/bin"}
            environment = subject.oracle_environment(host)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(os.environ, environment, clear=True):
                    result = gateway_health()
                    subject.zero_requests(result)
                    # The real Harbor exec merger considers explicit container
                    # overlays, not host os.environ. Capture its generated
                    # Docker argv without starting a Docker process.
                    docker = object.__new__(DockerEnvironment)
                    docker._persistent_env = {}
                    docker._exec_env_overlays = contextvars.ContextVar("oracle-container-test", default=())
                    docker._output_callback = lambda: None
                    docker._run_docker_compose_command = AsyncMock(return_value=SimpleNamespace(return_code=0))
                    command = subject.oracle_command(Path(temporary), "local-oracle", {"COMPAT_MODE": "synthetic"})
                    for flag in ("--ae", "--ve"):
                        values = [command[i + 1] for i, entry in enumerate(command) if entry == flag]
                        overlay = dict(value.split("=", 1) for value in values)
                        with BaseEnvironment.scoped_exec_env(docker, overlay):
                            container_env = BaseEnvironment._merge_env(docker, {"DEBIAN_FRONTEND": "noninteractive"})
                            asyncio.run(DockerEnvironment._compose_exec(docker, "true", service="synthetic", cwd=None,
                                env=container_env, timeout_sec=1, user=None))
                        argv = docker._run_docker_compose_command.call_args.args[0]
                        self.assertNotIn("SCRIPTACT_", json.dumps(argv))
                        self.assertNotIn("OPENAI_", json.dumps(argv))
                        self.assertNotIn("ANTHROPIC_", json.dumps(argv))
                        self.assertNotIn(str(token), json.dumps(argv))
                        self.assertNotIn(credential, json.dumps(argv))
                self.assertEqual(result, expected)
                self.assertEqual(observed, [{"method": "GET", "path": "/health", "identity": identity}])
                self.assertEqual(identity["phase"], "install")
                self.assertEqual(environment["SCRIPTACT_BENCH_TOKEN_FILE"], str(token))
                self.assertEqual(environment["SCRIPTACT_GATEWAY_HEALTH_URL"], host["SCRIPTACT_GATEWAY_HEALTH_URL"])
                for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "SCRIPTACT_BENCH_BASE_URL"):
                    self.assertNotIn(key, environment)
            finally:
                server.shutdown()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
