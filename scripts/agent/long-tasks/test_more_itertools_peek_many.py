"""Frozen external acceptance for batch lookahead through public iterator APIs."""

import ast
import inspect
import os
from pathlib import Path
import random
import subprocess
import sys

import pytest
import more_itertools as mi


class IntCount(int):
    pass


class IndexOnly:
    def __index__(self):
        raise AssertionError("count must not coerce __index__")


class Probe:
    def __init__(self, iterable):
        self.source = iter(iterable)
        self.calls = 0
        self.reject = False

    def __iter__(self):
        return self

    def __next__(self):
        self.calls += 1
        assert not self.reject, "unexpected source read"
        return next(self.source)


class ScriptedSource:
    """A resumable iterator, including after an explicit StopIteration."""

    def __init__(self, actions):
        self.actions = iter(actions)
        self.calls = 0

    def __iter__(self):
        return self

    def __next__(self):
        self.calls += 1
        value = next(self.actions)
        if isinstance(value, BaseException):
            raise value
        return value


def require_feature():
    assert callable(getattr(mi.peekable, "peek_many", None)), "public peek_many is required"


def make(items):
    require_feature()
    source = Probe(items)
    return mi.peekable(source), source


def test_exports_peek_many():
    require_feature()
    signature = inspect.signature(mi.peekable.peek_many)
    assert list(signature.parameters) == ["self", "n", "default"]
    assert signature.parameters["n"].kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
    assert signature.parameters["default"].kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
    p = mi.peekable([1, 2])
    assert p.peek_many(n=3, default=None) == [1, 2, None]
    assert p.peek_many(3, None) == [1, 2, None]


@pytest.mark.parametrize("count", [True, False, 1.0, -1.0, "2", None, [], {}, IndexOnly()])
@pytest.mark.parametrize("cached", [False, True])
def test_invalid_type_before_any_state_change(count, cached):
    p, source = make([11, 12])
    if cached:
        p.prepend(8, 9)
    source.reject = True
    with pytest.raises(TypeError):
        p.peek_many(count)
    assert source.calls == 0
    source.reject = False
    assert list(p) == ([8, 9] if cached else []) + [11, 12]


@pytest.mark.parametrize("count", [-1, -10**50, IntCount(-2)])
def test_negative_before_any_source_read(count):
    p, source = make([])
    source.reject = True
    with pytest.raises(ValueError):
        p.peek_many(count, default="padding")
    assert source.calls == 0


def test_zero_is_fresh_empty_without_source_access():
    p, source = make([1])
    source.reject = True
    a = p.peek_many(0)
    b = p.peek_many(IntCount(0), object())
    assert a == b == [] and a is not b
    assert source.calls == 0
    source.reject = False
    assert next(p) == 1


def test_exact_pulls_repeated_windows_and_fresh_lists():
    p, source = make(range(8))
    first = p.peek_many(IntCount(3))
    assert first == [0, 1, 2] and source.calls == 3
    again = p.peek_many(3)
    assert again == first and again is not first and source.calls == 3
    first.clear()
    assert next(p) == 0
    assert p.peek_many(2) == [1, 2] and source.calls == 3
    assert p.peek_many(4) == [1, 2, 3, 4] and source.calls == 5
    assert list(p) == list(range(1, 8))


def test_infinite_source_is_bounded_and_no_extra_exhaustion_probe():
    def source():
        for item in range(4):
            yield item
        raise AssertionError("lookahead over-read")

    p, probe = make(source())
    assert p.peek_many(4) == [0, 1, 2, 3]
    assert probe.calls == 4
    assert [next(p) for _ in range(4)] == [0, 1, 2, 3]


def test_short_without_default_preserves_pulled_prefix():
    p, source = make([10, 11])
    with pytest.raises(StopIteration):
        p.peek_many(4)
    assert source.calls == 3
    assert p.peek_many(2) == [10, 11] and source.calls == 3
    assert list(p) == [10, 11]


def test_empty_without_default_raises_stop_iteration():
    p, source = make([])
    with pytest.raises(StopIteration):
        p.peek_many(1)
    assert source.calls == 1


@pytest.mark.parametrize("default", [None, False, 0, [], object()])
def test_padding_is_return_only_and_identity_is_preserved(default):
    real = object()
    p, source = make([real])
    result = p.peek_many(4, default)
    assert result[0] is real and all(item is default for item in result[1:])
    assert source.calls == 2
    assert next(p) is real
    with pytest.raises(StopIteration):
        next(p)
    assert not p


def test_padding_is_not_reused_when_source_resumes():
    require_feature()
    pad = object()
    source = ScriptedSource([10, StopIteration(), 11, 12])
    p = mi.peekable(source)
    assert p.peek_many(3, pad) == [10, pad, pad]
    assert source.calls == 2
    assert p.peek_many(3, pad) == [10, 11, 12]
    assert source.calls == 4
    assert list(p) == [10, 11, 12]


def test_non_stop_error_keeps_prefix_and_propagates_identity():
    require_feature()
    failure = RuntimeError("temporary upstream failure")
    source = ScriptedSource([1, 2, failure, 3, 4])
    p = mi.peekable(source)
    with pytest.raises(RuntimeError) as raised:
        p.peek_many(4, default="must not swallow errors")
    assert raised.value is failure
    assert source.calls == 3
    assert p.peek_many(2) == [1, 2] and source.calls == 3
    assert p.peek_many(4) == [1, 2, 3, 4] and source.calls == 5
    assert list(p) == [1, 2, 3, 4]


def test_prepend_and_resurrection_precede_cached_items():
    p, source = make([2, 3])
    assert p.peek() == 2
    p.prepend(-1, 0, 1)
    assert p.peek_many(4) == [-1, 0, 1, 2] and source.calls == 1
    assert list(p) == [-1, 0, 1, 2, 3]
    assert not p
    p.prepend("reborn", "again")
    assert p.peek_many(3, None) == ["reborn", "again", None]
    assert list(p) == ["reborn", "again"]


def test_existing_indexing_slicing_truth_value_and_peek():
    p, source = make(range(9))
    assert p.peek_many(3) == [0, 1, 2]
    assert bool(p) and p.peek() == 0 and p[2] == 2
    assert source.calls == 3
    assert p[1:5:2] == [1, 3]
    assert p.peek_many(6) == [0, 1, 2, 3, 4, 5]
    assert p[-1] == 8
    assert p[::-1] == list(reversed(range(9)))
    assert list(p) == list(range(9))
    assert p.peek("done") == "done" and not p


def test_randomized_public_state_transitions():
    p, _ = make(range(31))
    expected = list(range(31))
    rng = random.Random(731927)
    for _ in range(200):
        action = rng.randrange(5)
        if action == 0:
            value = ("prepend", rng.randrange(100))
            p.prepend(value)
            expected.insert(0, value)
        elif action == 1:
            n = rng.randrange(7)
            assert p.peek_many(n, None) == expected[:n] + [None] * max(0, n - len(expected))
        elif action == 2:
            n = rng.randrange(7)
            if n > len(expected):
                with pytest.raises(StopIteration):
                    p.peek_many(n)
            else:
                assert p.peek_many(n) == expected[:n]
        elif action == 3:
            if expected:
                assert next(p) == expected.pop(0)
            else:
                with pytest.raises(StopIteration):
                    next(p)
        else:
            assert bool(p) == bool(expected)
            assert p.peek(None) == (expected[0] if expected else None)
    assert list(p) == expected


def test_shipped_stub_declares_batch_lookahead():
    source = Path(mi.__file__).parent / "more.pyi"
    tree = ast.parse(source.read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "peekable")
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "peek_many"]
    assert methods, "shipped generic peekable stub must expose peek_many"
    assert all(node.returns is not None for node in methods)
    assert all([arg.arg for arg in node.args.args][:2] == ["self", "n"] for node in methods)


def test_actual_offline_example_runs_without_arguments():
    root = Path(mi.__file__).resolve().parent.parent
    example = root / "examples/peek_many.py"
    assert example.is_file(), "offline example must be delivered"
    result = subprocess.run([sys.executable, str(example)], cwd=root, env=os.environ.copy(), capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
