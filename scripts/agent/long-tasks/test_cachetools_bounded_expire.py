"""Independent bounded-expiration acceptance through exported cache APIs."""

import ast
import copy
import inspect
import pickle
import random
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from cachetools import Cache, TLRUCache, TTLCache


class Clock:
    def __init__(self, now=0):
        self.now = now
        self.calls = 0
        self.reject = False

    def __call__(self):
        self.calls += 1
        assert not self.reject, "expiration must validate/no-op before timer access"
        return self.now


class IntLimit(int):
    pass


class IndexOnly:
    def __index__(self):
        return 2


def deadline(_key, value, _time):
    return value[0]


def cache(kind, clock=None, maxsize=1000, weighted=False):
    clock = clock or Clock()
    options = {"timer": clock}
    if weighted:
        options["getsizeof"] = lambda value: len(value[1])
    if kind == "ttl":
        return TTLCache(maxsize, 7, **options), clock
    return TLRUCache(maxsize, deadline, **options), clock


def require_feature(kind):
    cls = TTLCache if kind == "ttl" else TLRUCache
    parameters = inspect.signature(cls.expire).parameters
    assert "limit" in parameters, "exports bounded expire(time=None, *, limit=None)"
    assert parameters["limit"].kind == inspect.Parameter.KEYWORD_ONLY
    assert parameters["limit"].default is None


@pytest.fixture(params=["ttl", "tlru"])
def kind(request):
    require_feature(request.param)
    return request.param


@pytest.mark.parametrize("name", ["ttl", "tlru"])
def test_exports_bounded_expire(name):
    require_feature(name)


def physical(cache):
    # Base Cache is public. Its operations inspect retained storage without
    # triggering the timed subclass's implicit, unlimited expiration.
    return Cache.__len__(cache), Cache.currsize.fget(cache)


def populate(kind, count=6, weighted=False):
    c, clock = cache(kind, weighted=weighted)
    values = {}
    for i in range(count):
        clock.now = i
        value = (20 - i if kind == "tlru" else i + 7, "v" * (i + 1))
        c[i] = value
        values[i] = value
    return c, clock, values


def test_batches_remove_only_the_selected_entries_and_keep_value_identity(kind):
    c, clock, values = populate(kind)
    clock.now = 30
    order = list(reversed(range(6))) if kind == "tlru" else list(range(6))
    for offset in range(0, 6, 2):
        removed = c.expire(limit=2)
        assert isinstance(removed, list)
        assert [key for key, _ in removed] == order[offset:offset + 2]
        assert all(value is values[key] for key, value in removed)
        assert physical(c) == (4 - offset, 4 - offset)
    assert c.expire(limit=2) == []


def test_default_and_none_still_remove_every_expired_entry(kind):
    for explicit in (False, True):
        c, clock, values = populate(kind)
        clock.now = 30
        result = c.expire(limit=None) if explicit else c.expire()
        assert dict(result) == values
        assert physical(c) == (0, 0)


def test_zero_is_a_noop_before_timer_access_and_retains_eviction_order(kind):
    c, clock, values = populate(kind, count=3)
    assert c[0] is values[0]
    before = physical(c)
    clock.calls = 0
    clock.reject = True
    assert c.expire(limit=0) == []
    assert c.expire(object(), limit=0) == []
    assert clock.calls == 0
    assert physical(c) == before
    clock.reject = False
    assert c.popitem()[0] == 1


@pytest.mark.parametrize("value,error", [
    (True, TypeError), (False, TypeError), (1.0, TypeError),
    ("2", TypeError), (IndexOnly(), TypeError), (-1, ValueError),
])
def test_invalid_limits_are_rejected_atomically_before_timer_access(kind, value, error):
    for populated in (False, True):
        c, clock = cache(kind)
        if populated:
            c["keep"] = (10, "data")
        before = physical(c)
        clock.reject = True
        clock.calls = 0
        with pytest.raises(error):
            c.expire(limit=value)
        assert clock.calls == 0
        assert physical(c) == before
        if populated:
            assert Cache.__getitem__(c, "keep") == (10, "data")


def test_limit_is_keyword_only_but_time_remains_positional(kind):
    c, clock, _ = populate(kind)
    with pytest.raises(TypeError):
        c.expire(30, 2)
    clock.calls = 0
    assert len(c.expire(30, limit=IntLimit(2))) == 2
    assert clock.calls == 0


def test_each_sweep_uses_one_timer_snapshot_or_the_explicit_time(kind):
    c, clock, _ = populate(kind)
    clock.now = 30
    clock.calls = 0
    assert len(c.expire(limit=2)) == 2
    assert clock.calls == 1
    clock.reject = True
    assert len(c.expire(30, limit=1)) == 1
    assert clock.calls == 1


def test_exact_expiry_boundary_and_future_entries(kind):
    c, clock = cache(kind)
    c["first"] = (7, "first")
    clock.now = 1
    c["second"] = (8, "second")
    assert c.expire(6, limit=100) == []
    assert c.expire(7, limit=100) == [("first", (7, "first"))]
    assert Cache.__getitem__(c, "second") == (8, "second")
    assert c.expire(8, limit=1) == [("second", (8, "second"))]


def test_weighted_accounting_tracks_removed_values_not_number_of_entries(kind):
    c, clock, values = populate(kind, weighted=True)
    clock.now = 30
    total = sum(len(value[1]) for value in values.values())
    remaining = len(values)
    for limit in (1, 3, 1, 100):
        result = c.expire(limit=limit)
        total -= sum(len(value[1]) for _, value in result)
        remaining -= len(result)
        assert physical(c) == (remaining, total)
    assert total == remaining == 0


def test_leftover_expired_entries_are_logically_inaccessible(kind):
    c, clock, values = populate(kind)
    clock.now = 30
    removed = dict(c.expire(limit=1))
    assert physical(c) == (5, 5)
    for key in values.keys() - removed.keys():
        assert key not in c
        with pytest.raises(KeyError):
            c[key]
    assert [key for key in iter(c)] == []
    assert physical(c) == (5, 5)


@pytest.mark.parametrize("operation", ["len", "currsize", "repr", "insert", "popitem"])
def test_existing_implicit_cleanup_is_still_unlimited(kind, operation):
    c, clock, _ = populate(kind)
    clock.now = 30
    assert len(c.expire(limit=1)) == 1
    assert physical(c) == (5, 5)
    if operation == "len":
        assert len(c) == 0
    elif operation == "currsize":
        assert c.currsize == 0
    elif operation == "repr":
        assert "currsize=0" in repr(c)
    elif operation == "insert":
        c["new"] = (100, "new")
        assert physical(c) == (1, 1)
        assert c["new"] == (100, "new")
        return
    else:
        with pytest.raises(KeyError):
            c.popitem()
    assert physical(c) == (0, 0)


def test_remaining_live_entries_keep_lru_order(kind):
    c, clock = cache(kind)
    c["expired"] = (7, "old")
    clock.now = 1
    for key in ["a", "b", "c"]:
        c[key] = (100, key)
    assert c["a"] == (100, "a")
    assert c.expire(7, limit=1) == [("expired", (7, "old"))]
    assert c.popitem()[0] == "b"
    assert c.popitem()[0] == "c"
    assert c.popitem()[0] == "a"


def test_clear_and_reuse_after_partial_cleanup(kind):
    c, clock, _ = populate(kind)
    clock.now = 30
    c.expire(limit=2)
    c.clear()
    assert physical(c) == (0, 0)
    c["new"] = (100, "new")
    assert c["new"] == (100, "new")
    assert c.expire(200, limit=1) == [("new", (100, "new"))]
    assert c.expire(200, limit=1) == []


def test_arbitrary_unordered_keys_with_equal_expiry(kind):
    c, clock = cache(kind)
    keys = [object(), "text", 5, (1, 2)]
    for key in keys:
        c[key] = (7, key)
    clock.now = 7
    batches = [c.expire(limit=1) for _ in keys]
    assert all(len(batch) == 1 for batch in batches)
    assert {batch[0][0] for batch in batches} == set(keys)


def test_datetime_time_domain(kind):
    start = datetime(2025, 1, 2)
    clock = Clock(start)
    c = TTLCache(10, timedelta(minutes=1), timer=clock) if kind == "ttl" else TLRUCache(10, deadline, timer=clock)
    for key in range(4):
        clock.now = start + timedelta(seconds=key)
        c[key] = (clock.now + timedelta(minutes=1), key)
    cutoff = start + timedelta(seconds=62)
    assert [key for key, _ in c.expire(cutoff, limit=2)] == [0, 1]
    assert [key for key, _ in c.expire(cutoff, limit=2)] == [2]
    assert physical(c) == (1, 1)


def test_legacy_subclass_expire_overrides_keep_internal_compatibility(kind):
    cls = TTLCache if kind == "ttl" else TLRUCache

    class Legacy(cls):
        def expire(self, time=None):
            return super().expire(time)

    clock = Clock()
    c = Legacy(2, 7 if kind == "ttl" else deadline, timer=clock)
    for key in range(4):
        c[key] = (10, key)
    assert len(c) == c.currsize == 2
    assert repr(c)
    assert c.popitem()[0] == 2
    c.clear()
    assert len(c) == 0


def test_copy_and_pickle_remain_usable_after_partial_expiration(kind):
    c, clock = cache(kind)
    c["old"] = (7, "old")
    clock.now = 1
    c["live"] = (100, "live")
    assert c.expire(7, limit=1) == [("old", (7, "old"))]
    for cloned in [copy.copy(c), pickle.loads(pickle.dumps(c))]:
        assert cloned["live"] == (100, "live")
        cloned["fresh"] = (100, "fresh")
        assert {key for key, _ in cloned.expire(200, limit=1)} <= {"live", "fresh"}
        assert len(cloned.expire(200)) == 1


def test_tlru_tombstones_never_consume_the_entry_budget_or_delete_new_values():
    require_feature("tlru")
    c, clock = cache("tlru")
    for key, expires in [("updated", 1), ("deleted", 2), ("first", 3), ("second", 4)]:
        c[key] = (expires, key)
    c["updated"] = (100, "replacement")
    del c["deleted"]
    clock.now = 5
    assert c.expire(limit=1) == [("first", (3, "first"))]
    assert physical(c) == (2, 2)
    assert c["updated"] == (100, "replacement")
    assert c.expire(limit=1) == [("second", (4, "second"))]
    assert c.expire(limit=1) == []
    assert c.expire(100, limit=1) == [("updated", (100, "replacement"))]


@pytest.mark.parametrize("seed", [1701, 9027])
def test_seeded_public_operation_trace_matches_independent_storage_model(kind, seed):
    rng = random.Random(seed)
    c, clock = cache(kind, weighted=True)
    expected = {}
    for _ in range(250):
        op = rng.randrange(5)
        key = rng.randrange(12)
        if op == 0:
            expected = {k: v for k, v in expected.items() if v[0] > clock.now}
            expires = clock.now + (7 if kind == "ttl" else rng.randrange(1, 12))
            value = (expires, "x" * rng.randrange(1, 8))
            c[key] = value
            expected[key] = value
        elif op == 1:
            clock.now += rng.randrange(4)
        elif op == 2:
            limit = rng.choice([0, 1, 2, 5, None])
            due = {k: v for k, v in expected.items() if v[0] <= clock.now}
            result = c.expire(limit=limit)
            count = len(due) if limit is None else min(len(due), limit)
            assert len(result) == count
            assert len({k for k, _ in result}) == count
            assert sorted(v[0] for _, v in result) == sorted(v[0] for v in due.values())[:count]
            for k, value in result:
                assert value is expected.pop(k)
        elif op == 3:
            live = key in expected and expected[key][0] > clock.now
            if live:
                del c[key]
            else:
                with pytest.raises(KeyError):
                    del c[key]
            expected.pop(key, None)
        else:
            assert (key in c) == (key in expected and expected[key][0] > clock.now)
        assert physical(c) == (len(expected), sum(len(v[1]) for v in expected.values()))
        for k, value in expected.items():
            assert Cache.__getitem__(c, k) is value


def test_public_stubs_document_keyword_only_optional_integer_limit():
    path = Path("src/cachetools/__init__.pyi")
    tree = ast.parse(path.read_text())
    for name in ["TTLCache", "TLRUCache"]:
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
        expire = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "expire")
        index = next((i for i, arg in enumerate(expire.args.kwonlyargs) if arg.arg == "limit"), None)
        assert index is not None, name + " stub lacks keyword-only limit"
        assert isinstance(expire.args.kw_defaults[index], ast.Constant)
        assert expire.args.kw_defaults[index].value is None
        annotation = ast.unparse(expire.args.kwonlyargs[index].annotation)
        assert "int" in annotation and ("None" in annotation or "Optional" in annotation)
        assert "list" in ast.unparse(expire.returns) and "tuple" in ast.unparse(expire.returns)


def test_documentation_and_offline_example_are_present_and_run():
    docs = "\n".join(path.read_text() for path in [Path("README.rst"), *Path("docs").rglob("*.rst")])
    assert "limit" in docs and "TTLCache" in docs and "TLRUCache" in docs
    example = Path("examples/bounded_expire.py")
    assert example.is_file()
    source = example.read_text()
    assert "TTLCache" in source and "TLRUCache" in source
    tree = ast.parse(source)
    assert any(isinstance(node, ast.Call) and any(kw.arg == "limit" for kw in node.keywords) for node in ast.walk(tree))
    result = subprocess.run([sys.executable, str(example)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip(), "example must show the actual batches"
