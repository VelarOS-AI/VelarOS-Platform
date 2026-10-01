"""Offline worker epoch contracts; probes, task metadata and subprocesses are synthetic."""
import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from resource_leases import DispatchError, ResourceLeases
from worker_admission import admission_session, canonical_hash, maintenance_session, member_identity, scope_for


def passed_probe(manifest_path, manifest_hash, tasks_root, host_path, **kwargs):
    manifest = json.loads(Path(manifest_path).read_text())
    return {"status": "passed", "manifest_sha256": manifest_hash,
        "environment_paths": {"socket": str(Path(kwargs["colima_home"]) / kwargs["profile"] / "docker.sock")},
        "plan": {"max_active_attempts": manifest["resource_pool"]["max_active_attempts"]}}


class WorkerAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.capacity = {"max_active_attempts": 2, "cpus": 2, "memory_mb": 8192}
        self.manifest = {"resource_pool": self.capacity, "vm": {"profile": "fixture-worker"},
            "participants": {"a": {"model": "fixture"}, "b": {"model": "fixture"}},
            "attempts": [{"participant": name, "task": "synthetic", "source_job": name + "-source", "replay_job": name + "-replay"} for name in ("a", "b")]}
        self.path = self.root / "manifest.json"
        self.path.write_text(json.dumps(self.manifest))
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.pool = ResourceLeases(self.root / "resources", self.capacity)
        self.scope = scope_for(self.manifest, self.digest, {1: ["source", "replay"], 2: ["source", "replay"]},
                               owner=str(self.root), batch_id="synthetic", kind="batch")
        self.demand = {"cpus": 1, "memory_mb": 4096}

    def session(self, probe=passed_probe):
        return admission_session(self.pool, self.scope, manifest_path=self.path, bench=self.root,
                                 tasks_root=self.root, probe_fn=probe)

    def identity(self, index=1, phase="source"):
        return member_identity(self.manifest, self.digest, index, phase)

    def state(self):
        return json.loads(self.pool.path.read_text())

    def test_01_fresh_pair_one_probe_two_members(self):
        with patch(__name__ + ".passed_probe", wraps=passed_probe) as probe:
            with self.session(probe) as handle:
                leases = [self.pool.acquire(self.identity(i), self.demand, admission_id=handle.admission_id) for i in (1, 2)]
                self.assertEqual(len(self.state()["leases"]), 2)
                for lease in leases:
                    self.pool.finish(lease, settled=True)
            self.assertEqual(probe.call_count, 1)
        self.assertIsNone(self.state()["admission"])

    def test_02_other_owner_and_same_owner_cannot_begin_second_epoch(self):
        with self.session():
            for scope in (self.scope, {**self.scope, "owner": "other"}):
                with self.assertRaises(DispatchError):
                    self.pool.begin_admission(scope)

    def test_03_legacy_acquirer_and_epoch_exclude_both_orders(self):
        lease = self.pool.acquire(self.identity(), self.demand)
        with self.assertRaises(DispatchError):
            self.pool.begin_admission(self.scope)
        self.pool.finish(lease, settled=True)
        with self.session():
            with self.assertRaises(DispatchError):
                self.pool.acquire(self.identity(), self.demand)

    def test_04_capacity_cannot_change_during_phase_gap(self):
        with self.session():
            other = ResourceLeases(self.pool.directory, {**self.capacity, "cpus": 3})
            with self.assertRaises(DispatchError), other.state():
                pass

    def test_05_probe_outside_lock_but_fences_acquire(self):
        def probe(*args, **kwargs):
            with self.pool.state() as state:
                self.assertEqual(state["admission"]["status"], "probing")
            with self.assertRaises(DispatchError):
                self.pool.acquire(self.identity(), self.demand)
            return passed_probe(*args, **kwargs)
        with self.session(probe):
            pass

    def test_06_shortfall_rejection_can_retry_without_dispatch_artifacts(self):
        with self.assertRaises(DispatchError):
            with self.session(lambda *_a, **_k: {"status": "blocked"}):
                self.fail("rejected snapshot dispatched")
        self.assertIsNone(self.state()["admission"])
        self.assertFalse((self.root / "jobs").exists())
        with self.session():
            pass
        self.assertEqual(len(list((self.root / "worker-admissions").glob("*/result.json"))), 2)

    def test_07_passed_snapshot_wrong_worker_or_manifest_is_rejected(self):
        for key, value in (("manifest_sha256", "b" * 64), ("environment_paths", {"socket": "/wrong"}), ("plan", {"max_active_attempts": 1})):
            def probe(*args, **kwargs):
                return {**passed_probe(*args, **kwargs), key: value}
            with self.assertRaises(DispatchError):
                with self.session(probe):
                    self.fail("wrong binding")

    def test_08_full_member_identity_and_phase_are_bound(self):
        with self.session() as handle:
            for key in self.identity():
                bad = {**self.identity(), key: "replay" if key == "phase" else "wrong"}
                with self.assertRaises((ValueError, DispatchError)):
                    self.pool.acquire(bad, self.demand, admission_id=handle.admission_id)
            with self.assertRaises(DispatchError):
                self.pool.acquire(self.identity(), self.demand, admission_id="stale")

    def test_09_source_replay_gap_keeps_epoch(self):
        with self.session() as handle:
            for phase in ("source", "replay"):
                lease = self.pool.acquire(self.identity(phase=phase), self.demand, admission_id=handle.admission_id)
                self.pool.finish(lease, settled=True)
                self.assertEqual(self.state()["admission"]["status"], "admitted")

    def test_10_replay_only_scope_never_authorizes_source(self):
        self.scope = scope_for(self.manifest, self.digest, {1: ["replay"]}, owner="recovery", batch_id="replay")
        with self.session() as handle:
            with self.assertRaises(DispatchError):
                self.pool.acquire(self.identity(), self.demand, admission_id=handle.admission_id)
            lease = self.pool.acquire(self.identity(phase="replay"), self.demand, admission_id=handle.admission_id)
            self.pool.finish(lease, settled=True)

    def test_11_probe_crash_retains_claim_and_pid_does_not_reclaim(self):
        with self.assertRaises(RuntimeError):
            with self.session(lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("synthetic"))):
                pass
        with self.pool.state() as state:
            state["admission"]["owner_pid"] = 999999999
        with self.assertRaises(DispatchError):
            self.pool.begin_admission(self.scope)

    def test_12_draining_denies_new_members_but_allows_late_finish(self):
        with self.session() as handle:
            lease = self.pool.acquire(self.identity(), self.demand, admission_id=handle.admission_id)
            handle.drain()
            with self.assertRaises(DispatchError):
                self.pool.acquire(self.identity(2), self.demand, admission_id=handle.admission_id)
            self.pool.finish(lease, settled=True)
        self.assertIsNone(self.state()["admission"])

    def test_13_unsettled_member_blocks_retirement(self):
        with self.session() as handle:
            lease = self.pool.acquire(self.identity(), self.demand, admission_id=handle.admission_id)
            self.pool.finish(lease, settled=False, reason="pending physical cleanup")
        self.assertEqual(self.state()["admission"]["status"], "blocked")
        self.pool.finish(lease, settled=True)
        self.assertEqual(self.state()["admission"]["status"], "blocked")

    def test_14_unknown_cost_is_not_physical_work(self):
        with self.session() as handle:
            lease = self.pool.acquire(self.identity(), self.demand, admission_id=handle.admission_id)
            self.pool.finish(lease, settled=True, reason="transport finished; usage unknown")
        self.assertIsNone(self.state()["admission"])

    def test_15_maintenance_fences_entire_operation_and_vice_versa(self):
        kwargs = dict(owner="image", manifest_sha256=self.digest, worker=self.scope["worker"])
        with maintenance_session(self.pool, **kwargs):
            with self.assertRaises(DispatchError):
                self.pool.begin_admission(self.scope)
            with self.assertRaises(DispatchError):
                self.pool.acquire(self.identity(), self.demand)
        with self.session():
            with self.assertRaises(DispatchError):
                with maintenance_session(self.pool, **kwargs):
                    pass

    def test_16_maintenance_unknown_import_is_persistent(self):
        with maintenance_session(self.pool, owner="image", manifest_sha256=self.digest, worker=self.scope["worker"]) as handle:
            handle.block("docker import unknown")
        self.assertEqual(self.state()["admission"]["status"], "blocked")

    def test_17_fsync_failure_is_not_acknowledged_and_keeps_fence(self):
        original = os.fsync
        def fsync(fd):
            import stat
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError("synthetic directory sync failure")
            original(fd)
        with patch("resource_leases.os.fsync", side_effect=fsync), self.assertRaises(OSError):
            self.pool.begin_admission(self.scope)
        with self.assertRaises(DispatchError):
            self.pool.begin_admission(self.scope)

    def test_18_corrupt_state_cannot_erase_an_epoch(self):
        for value in ({}, {"status": "probing"}, False):
            self.pool.path.write_text(json.dumps({"schema": 1, "capacity": self.capacity, "leases": {}, "history": [], "admission": value}))
            with self.assertRaises(DispatchError):
                self.pool.begin_admission(self.scope)

    def test_19_old_empty_schema_is_compatible(self):
        self.pool.path.write_text(json.dumps({"schema": 1, "capacity": self.capacity, "leases": {}, "history": []}))
        with self.session():
            pass

    def test_20_owner_nonce_prevents_foreign_retirement(self):
        with self.session() as handle:
            with self.assertRaises(DispatchError):
                self.pool.finish_admission({**handle.claim, "owner_nonce": "wrong"}, settled=True)

    def test_member_consumption_prevents_same_phase_reexecution(self):
        with self.session() as handle:
            lease = self.pool.acquire(self.identity(), self.demand, admission_id=handle.admission_id)
            self.pool.finish(lease, settled=True)
            with self.assertRaises(DispatchError) as error:
                self.pool.acquire(self.identity(), self.demand, admission_id=handle.admission_id)
            self.assertEqual(error.exception.code, "ADMISSION_MEMBER_CONSUMED")
