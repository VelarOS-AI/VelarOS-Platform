"""Frozen acceptance for transactional strict dotenv parsing."""

import inspect
import io
import os
from pathlib import Path
import subprocess
import sys

import pytest
import dotenv
from dotenv.main import DotEnv


def require_feature():
    assert "strict" in inspect.signature(dotenv.dotenv_values).parameters
    error = getattr(dotenv, "DuplicateKeyError", None)
    assert isinstance(error, type) and issubclass(error, ValueError)
    return error


def parse(text, **kwargs):
    require_feature()
    return dotenv.dotenv_values(stream=io.StringIO(text), **kwargs)


def test_exports_strict_option_and_error():
    require_feature()
    for function in [dotenv.dotenv_values, dotenv.load_dotenv, DotEnv]:
        param = inspect.signature(function).parameters.get("strict")
        assert param is not None
        assert param.kind is inspect.Parameter.KEYWORD_ONLY and param.default is False


@pytest.mark.parametrize("api", ["values", "load", "constructor"])
@pytest.mark.parametrize("value", [1, 0, None, "true", [], object()])
def test_strict_validation_precedes_read_and_path_conversion(api, value, monkeypatch):
    require_feature()
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "true")

    class BombPath:
        def __fspath__(self):
            pytest.fail("invalid strict must not convert paths")

    class BombStream:
        def read(self, *args):
            pytest.fail("invalid strict must not read streams")

    function = {"values": dotenv.dotenv_values, "load": dotenv.load_dotenv, "constructor": DotEnv}[api]
    with pytest.raises(TypeError):
        function(dotenv_path=BombPath(), stream=BombStream(), strict=value)


@pytest.mark.parametrize("text,key,first,second", [
    ("A=first\nA=second\n", "A", 1, 2),
    ("# comment\n\nexport A=one\n'A'=two\n", "A", 3, 4),
    ("A\nA=value\n", "A", 1, 2),
    ("A=value\nA\n", "A", 1, 2),
    ("A=same\nA=same\n", "A", 1, 2),
    ("A=1\nB=2\nB=3\nA=4\n", "B", 2, 3),
    ("A=1\nA=2\nA=3\n", "A", 1, 2),
    ("# header\nA='line one\nline two'\nB=ok\nA=again\n", "A", 2, 5),
    ("A=1\r\nB=2\r\nA=3\r\n", "A", 1, 3),
    ("'=literal'=1\n'=literal'=2\n", "=literal", 1, 2),
])
def test_duplicate_identity_and_physical_line_numbers(text, key, first, second):
    error = require_feature()
    with pytest.raises(error) as raised:
        parse(text, strict=True)
    failure = raised.value
    assert (failure.key, failure.first_line, failure.second_line) == (key, first, second)
    assert key in str(failure) and str(first) in str(failure) and str(second) in str(failure)


def test_error_message_does_not_expose_values():
    error = require_feature()
    with pytest.raises(error) as raised:
        parse("SECRET=private-value-431\nSECRET=private-value-842\n", strict=True)
    assert "private-value-431" not in str(raised.value)
    assert "private-value-842" not in str(raised.value)


@pytest.mark.parametrize("override", [False, True])
@pytest.mark.parametrize("interpolate", [False, True])
def test_duplicate_load_does_not_partially_modify_environment(monkeypatch, override, interpolate):
    error = require_feature()
    monkeypatch.delenv("PYTHON_DOTENV_DISABLED", raising=False)
    monkeypatch.setenv("STRICT_EVAL_EXISTING", "old")
    monkeypatch.delenv("STRICT_EVAL_NEW", raising=False)
    before = dict(os.environ)
    text = "STRICT_EVAL_EXISTING=replaced\nSTRICT_EVAL_NEW=created\nSTRICT_EVAL_EXISTING=duplicate\n"
    with pytest.raises(error):
        dotenv.load_dotenv(stream=io.StringIO(text), strict=True, override=override, interpolate=interpolate)
    assert dict(os.environ) == before


def test_duplicate_check_precedes_interpolation(monkeypatch):
    from dotenv.variables import Variable
    error = require_feature()

    def forbidden(*args, **kwargs):
        pytest.fail("interpolation must not run before duplicate detection")

    # A resolver may enter before consuming an iterator that validates all bindings.
    # Observe actual variable substitution, not entry into that lazy consumer.
    monkeypatch.setattr(Variable, "resolve", forbidden)
    with pytest.raises(error):
        parse("A=${OUTSIDE}\nA=again\n", strict=True)


def test_invalid_bindings_and_comments_do_not_define_keys(caplog):
    require_feature()
    result = parse("# A=comment\nnot valid = broken\nA=real\n\n", strict=True)
    assert result == {"A": "real"}
    assert "line 2" in caplog.text


def test_default_duplicate_and_interpolation_semantics_remain_compatible(monkeypatch):
    monkeypatch.setenv("STRICT_EVAL_ENV", "outer")
    text = "A=first\nB=${A}\nA=second\nC=${A}\nD=${STRICT_EVAL_ENV}\nBARE\n"
    expected = {"A": "second", "B": "first", "C": "second", "D": "outer", "BARE": None}
    assert parse(text) == expected
    assert parse(text, strict=False) == expected


@pytest.mark.parametrize("override", [False, True])
def test_unique_strict_load_preserves_environment_precedence(monkeypatch, override):
    require_feature()
    monkeypatch.delenv("PYTHON_DOTENV_DISABLED", raising=False)
    monkeypatch.setenv("STRICT_EVAL_A", "old")
    monkeypatch.delenv("STRICT_EVAL_B", raising=False)
    assert dotenv.load_dotenv(stream=io.StringIO("STRICT_EVAL_A=new\nSTRICT_EVAL_B=${STRICT_EVAL_A}\n"), strict=True, override=override)
    assert os.environ["STRICT_EVAL_A"] == ("new" if override else "old")
    assert os.environ["STRICT_EVAL_B"] == ("new" if override else "old")


def test_nonseekable_stream_remains_open_after_success_and_failure():
    error = require_feature()

    class ReadOnlyStream:
        def __init__(self, text):
            self.source = io.StringIO(text)

        def read(self, *args):
            return self.source.read(*args)

        def close(self):
            pytest.fail("caller owns the stream")

        def seek(self, *args):
            pytest.fail("readable streams need not be seekable")

    assert dotenv.dotenv_values(stream=ReadOnlyStream("A=ok\n"), strict=True) == {"A": "ok"}
    with pytest.raises(error):
        dotenv.dotenv_values(stream=ReadOnlyStream("A=1\nA=2\n"), strict=True)


def test_constructor_does_not_cache_partial_dictionary_after_failure():
    error = require_feature()
    stream = io.StringIO("A=first\nA=second\n")
    parser = DotEnv(None, stream=stream, strict=True)
    with pytest.raises(error):
        parser.dict()
    stream.seek(0)
    with pytest.raises(error):
        parser.dict()


def test_disabled_loading_performs_no_reads_but_values_still_parse(monkeypatch):
    require_feature()
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "true")

    class Bomb:
        def read(self, *args):
            pytest.fail("disabled loading must not read the stream")

    assert dotenv.load_dotenv(stream=Bomb(), strict=True) is False
    assert parse("A=ok\n", strict=True) == {"A": "ok"}


def test_real_file_encoding_and_line_numbers(tmp_path):
    error = require_feature()
    path = tmp_path / "config.env"
    path.write_text("NAME=é\nNAME=à\n", encoding="latin-1")
    with pytest.raises(error) as raised:
        dotenv.dotenv_values(path, encoding="latin-1", strict=True)
    assert (raised.value.key, raised.value.first_line, raised.value.second_line) == ("NAME", 1, 2)


def test_actual_offline_example_runs_without_arguments():
    root = Path(dotenv.__file__).resolve().parents[2]
    example = root / "examples/strict_duplicates.py"
    assert example.is_file()
    result = subprocess.run([sys.executable, str(example)], cwd=root, env=os.environ.copy(), capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
