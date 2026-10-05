"""Black-box public behavior for the pre-frozen Click translation task."""

import inspect
import io
import subprocess
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import click
import pytest
from click.testing import CliRunner


class Catalog:
    def __init__(self, label):
        self.label = label
        self.singular = []
        self.plural = []

    def gettext(self, message):
        self.singular.append(message)
        return f"{self.label}::{message}"

    def ngettext(self, singular, plural, n):
        self.plural.append((singular, plural, n))
        return f"{self.label}::{singular if n == 1 else plural}"

    @property
    def settings(self):
        return {"gettext": self.gettext, "ngettext": self.ngettext}


def require_api():
    parameters = inspect.signature(click.Context).parameters
    assert (
        "gettext" in parameters and "ngettext" in parameters
    ), "context-local translation callbacks are required"
    assert callable(getattr(click.Context, "gettext", None))
    assert callable(getattr(click.Context, "ngettext", None))


def context(catalog=None, **kwargs):
    require_api()
    if catalog is not None:
        kwargs.update(catalog.settings)
    return click.Context(click.Command("sample"), info_name="sample", **kwargs)


def shown(error):
    output = io.StringIO()
    error.show(file=output)
    return output.getvalue()


def test_direct_callbacks_receive_original_templates_and_count():
    catalog = Catalog("漢字")
    ctx = context(catalog)
    assert ctx.gettext("Hello {name}") == "漢字::Hello {name}"
    assert ctx.ngettext("{n} item", "{n} items", 0) == "漢字::{n} items"
    assert ctx.ngettext("{n} item", "{n} items", 1) == "漢字::{n} item"
    assert catalog.singular[-1] == "Hello {name}"
    assert [value[2] for value in catalog.plural[-2:]] == [0, 1]
    plain = context()
    assert plain.gettext("Hello") == "Hello"
    assert plain.ngettext("item", "items", 2) == "items"


@pytest.mark.parametrize("override", ["none", "singular", "plural", "both"])
def test_parent_callbacks_inherit_independently(override):
    parent = context(Catalog("P"))
    options = {"parent": parent}
    child = Catalog("C")
    if override in ("singular", "both"):
        options["gettext"] = child.gettext
    if override in ("plural", "both"):
        options["ngettext"] = child.ngettext
    ctx = context(**options)
    assert (
        ctx.gettext("text")
        == ("C" if override in ("singular", "both") else "P") + "::text"
    )
    assert (
        ctx.ngettext("item", "items", 2)
        == ("C" if override in ("plural", "both") else "P") + "::items"
    )
    assert parent.gettext("text") == "P::text"


@pytest.mark.parametrize("field", ["gettext", "ngettext"])
@pytest.mark.parametrize("value", [False, "language", 17])
def test_invalid_callbacks_are_rejected_at_construction(field, value):
    require_api()
    with pytest.raises(TypeError, match=field):
        context(**{field: value})


@pytest.mark.parametrize("field", ["gettext", "ngettext"])
@pytest.mark.parametrize("value", [None, 3, [], b"bytes"])
def test_invalid_callback_results_are_visible(field, value):
    require_api()
    with pytest.raises(TypeError, match=field):
        ctx = context(**{field: lambda *args: value})
        if field == "gettext":
            ctx.gettext("template")
        else:
            ctx.ngettext("one", "many", 2)


def test_empty_callback_results_are_valid():
    ctx = context(gettext=lambda message: "", ngettext=lambda one, many, n: "")
    assert ctx.gettext("template") == ""
    assert ctx.ngettext("one", "many", 2) == ""


def make_help_command():
    @click.group(help="APPLICATION_HELP")
    @click.option("--amount", default=3, show_default=True, help="APPLICATION_OPTION")
    def command(amount):
        pass

    @command.command(help="APPLICATION_CHILD")
    def child():
        pass

    return command


@pytest.mark.parametrize("label", ["A", "语言"])
def test_help_uses_context_templates_and_preserves_application_text(label):
    require_api()
    catalog = Catalog(label)
    command = make_help_command()
    result = CliRunner().invoke(command, ["--help"], **catalog.settings)
    assert result.exit_code == 0, result.output
    for text in ["Usage:", "Options", "Commands", "Show this message and exit."]:
        assert f"{label}::{text}" in result.output
    assert "APPLICATION_HELP" in result.output and "APPLICATION_OPTION" in result.output
    assert "APPLICATION_HELP" not in catalog.singular
    assert "APPLICATION_OPTION" not in catalog.singular
    assert "APPLICATION_CHILD" not in catalog.singular
    assert "--amount" not in catalog.singular


def test_same_command_can_alternate_languages_without_mutation():
    require_api()
    command = make_help_command()
    runner = CliRunner()
    baseline = runner.invoke(command, ["--help"]).output
    for label in ("A", "B", "A"):
        result = runner.invoke(command, ["--help"], **Catalog(label).settings)
        assert result.exit_code == 0
        assert f"{label}::Usage:" in result.output
        assert ("B::" if label == "A" else "A::") not in result.output
    assert runner.invoke(command, ["--help"]).output == baseline


def test_context_settings_and_nested_command_inheritance():
    require_api()
    parent = Catalog("P")
    child = Catalog("C")

    @click.group(context_settings=parent.settings)
    def command():
        pass

    @command.command()
    @click.option("--size", type=int)
    def inherited(size):
        pass

    @command.command(context_settings=child.settings)
    @click.option("--size", type=int)
    def overridden(size):
        pass

    runner = CliRunner()
    for name, label in [("inherited", "P"), ("overridden", "C"), ("inherited", "P")]:
        result = runner.invoke(command, [name, "--size", "bad"])
        assert result.exit_code == 2
        assert f"{label}::Error:" in result.output
        assert f"{label}::'bad' is not a valid integer." in result.output


TYPE_CASES = [
    (click.INT, "bad", "{value!r} is not a valid {number_type}."),
    (click.FLOAT, "bad", "{value!r} is not a valid {number_type}."),
    (click.BOOL, "bad", "{value!r} is not a valid boolean."),
    (click.UUID, "bad", "{value!r} is not a valid UUID."),
    (click.IntRange(1, 3), "9", "{value} is not in the range {range}."),
    (click.FloatRange(1, 3), "9", "{value} is not in the range {range}."),
    (click.Choice(["only"]), "bad", None),
    (click.Choice(["first", "second"]), "bad", None),
    (click.DateTime(["%Y"]), "bad", None),
    (click.DateTime(["%Y", "%m"]), "bad", None),
    (click.Tuple([str, int]), ["one"], None),
]


@pytest.mark.parametrize("parameter_type,value,template", TYPE_CASES)
def test_type_errors_use_explicit_context_outside_scope(
    parameter_type, value, template
):
    catalog = Catalog("T")
    ctx = context(catalog)
    with context(Catalog("OTHER")):
        with pytest.raises(click.BadParameter) as caught:
            parameter_type.convert(value, None, ctx)
    assert caught.value.message.startswith("T::")
    assert "OTHER::" not in caught.value.message
    if template:
        assert template in catalog.singular
    else:
        assert catalog.plural
        assert isinstance(catalog.plural[-1][2], int)
    assert "T::Invalid value:" in caught.value.format_message()


@pytest.mark.parametrize("kind", ["path", "file"])
def test_file_errors_translate_before_filename_interpolation(kind, tmp_path):
    catalog = Catalog("F")
    ctx = context(catalog)
    filename = str(tmp_path / "APPLICATION_FILENAME")
    parameter_type = click.Path(exists=True) if kind == "path" else click.File("r")
    with pytest.raises(click.BadParameter) as caught:
        parameter_type.convert(filename, None, ctx)
    assert caught.value.format_message().startswith("F::Invalid value:")
    if kind == "path":
        assert caught.value.message.startswith("F::")
    assert "APPLICATION_FILENAME" in caught.value.message
    assert not any(filename in message for message in catalog.singular)


@pytest.mark.parametrize("count", [1, 2])
def test_suggestions_use_explicit_context_and_plural_count(count):
    catalog = Catalog("S")
    ctx = context(catalog)
    error = click.NoSuchOption(
        "--bad", ctx=ctx, possibilities=["--warm", "--water"][:count]
    )
    text = shown(error)
    assert "S::No such option: --bad" in text
    assert "S::Error:" in text and "S::Try 'sample --help' for help." in text
    assert any(n == count for _, _, n in catalog.plural)
    assert "--bad" not in catalog.singular


@pytest.mark.parametrize("kind", ["click", "usage", "bad", "missing", "file"])
def test_exception_wrappers_keep_creation_context_after_scope_exit(kind):
    catalog = Catalog("E")
    ctx = context(catalog)
    with ctx:
        if kind == "click":
            error = click.ClickException("APPLICATION_MESSAGE")
        elif kind == "usage":
            error = click.UsageError("APPLICATION_MESSAGE", ctx)
        elif kind == "bad":
            error = click.BadParameter("APPLICATION_MESSAGE", ctx, param_hint="--value")
        elif kind == "missing":
            error = click.MissingParameter(
                ctx=ctx, param_type="option", param_hint="--value"
            )
        else:
            error = click.FileError("APPLICATION_FILENAME", hint="APPLICATION_MESSAGE")
    with context(Catalog("OTHER")):
        text = shown(error)
    assert "E::Error:" in text
    assert "OTHER::" not in text
    assert "APPLICATION_MESSAGE" not in catalog.singular
    if kind != "missing":
        assert "APPLICATION_MESSAGE" in text
    if kind == "missing":
        assert "E::Missing option" in text


@pytest.mark.parametrize(
    "args,expected",
    [
        (["--missing"], "No such option:"),
        (["--flag=x"], "Option '--flag' does not take a value."),
        (["--pair", "one"], "Option '--pair' requires 2 arguments."),
        (["--number"], "Option '--number' requires an argument."),
        (["unexpected"], "Got unexpected extra argument"),
    ],
)
def test_parser_diagnostics_are_translated(args, expected):
    require_api()
    catalog = Catalog("R")
    command = click.Command(
        "sample",
        params=[
            click.Option(["--flag"], is_flag=True),
            click.Option(["--pair"], nargs=2),
            click.Option(["--number"], type=int),
        ],
    )
    result = CliRunner().invoke(command, args, **catalog.settings)
    assert result.exit_code == 2, result.output
    assert "R::Error:" in result.output
    assert f"R::{expected}" in result.output


@pytest.mark.parametrize("custom", [False, True])
def test_version_decorator_is_deferred_and_keeps_custom_templates(custom):
    require_api()
    options = (
        {
            "message": "APPLICATION_VERSION %(version)s",
            "help": "APPLICATION_VERSION_HELP",
        }
        if custom
        else {}
    )

    @click.command()
    @click.version_option("1.2.3", **options)
    def command():
        pass

    runner = CliRunner()
    for label in ["V", "W"]:
        catalog = Catalog(label)
        result = runner.invoke(command, ["--version"], **catalog.settings)
        assert result.exit_code == 0, result.output
        expected = (
            "APPLICATION_VERSION 1.2.3"
            if custom
            else f"{label}::command, version 1.2.3"
        )
        assert expected in result.output
        help_result = runner.invoke(command, ["--help"], **catalog.settings)
        assert help_result.exit_code == 0
        expected_help = (
            "APPLICATION_VERSION_HELP"
            if custom
            else f"{label}::Show the version and exit."
        )
        assert expected_help in help_result.output
        assert "APPLICATION_VERSION %(version)s" not in catalog.singular
        assert "APPLICATION_VERSION_HELP" not in catalog.singular


@pytest.mark.parametrize("kind", ["prompt", "confirm", "confirmation"])
def test_terminal_validation_templates_use_current_context(kind):
    require_api()
    catalog = Catalog("U")

    @click.command(context_settings=catalog.settings)
    def command():
        if kind == "prompt":
            click.prompt("APPLICATION_LABEL", type=int)
        elif kind == "confirm":
            click.confirm("APPLICATION_LABEL")
        else:
            click.prompt("APPLICATION_LABEL", confirmation_prompt=True)

    inputs = {
        "prompt": "bad\n12\n",
        "confirm": "bad\ny\n",
        "confirmation": "first\nsecond\nmatch\nmatch\n",
    }
    result = CliRunner().invoke(command, input=inputs[kind])
    assert result.exit_code == 0, result.output
    assert "U::Error:" in result.output
    if kind == "confirmation":
        assert "U::Repeat for confirmation" in result.output
    assert "APPLICATION_LABEL" not in catalog.singular


def test_pause_uses_context_without_translating_custom_label(monkeypatch, capsys):
    import click.termui

    monkeypatch.setattr(click.termui, "isatty", lambda stream: True)
    monkeypatch.setattr(click.termui, "getchar", lambda *args, **kwargs: "x")
    catalog = Catalog("P")
    with context(catalog):
        click.pause()
        click.pause("APPLICATION_PAUSE")
    assert "P::Press any key to continue..." in capsys.readouterr().out
    assert "APPLICATION_PAUSE" not in catalog.singular


@pytest.mark.parametrize("fails_to_start", [False, True])
def test_editor_errors_keep_context_through_late_display(monkeypatch, fails_to_start):
    from click._termui_impl import Editor

    def process(*args, **kwargs):
        if fails_to_start:
            raise OSError("EDITOR_START_FAILURE")
        return SimpleNamespace(wait=lambda: 1)

    monkeypatch.setattr(subprocess, "Popen", process)
    catalog = Catalog("ED")
    with context(catalog):
        with pytest.raises(click.ClickException) as caught:
            Editor(editor="APPLICATION_EDITOR").edit_file("unused")
    output = shown(caught.value)
    assert "ED::Error:" in output
    assert "ED::APPLICATION_EDITOR: Editing failed" in output
    assert "APPLICATION_EDITOR" not in catalog.singular


@pytest.mark.parametrize("version", [b"3.2.0", b"unknown"])
def test_completion_setup_uses_current_context(monkeypatch, capsys, version):
    from click.shell_completion import BashComplete

    monkeypatch.setattr("shutil.which", lambda name: "/unused/bash")
    monkeypatch.setattr(
        subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout=version)
    )
    with context(Catalog("B")):
        BashComplete._check_version()
    assert capsys.readouterr().err.startswith("B::")


def test_nested_contexts_restore_the_previous_language():
    outer, inner = context(Catalog("OUT")), context(Catalog("IN"))
    with outer:
        first = click.ClickException("value")
        with inner:
            second = click.ClickException("value")
        third = click.ClickException("value")
    assert shown(first).startswith("OUT::Error:")
    assert shown(second).startswith("IN::Error:")
    assert shown(third).startswith("OUT::Error:")


def test_parallel_contexts_do_not_change_process_translations():
    require_api()
    barrier = Barrier(2)

    def worker(label):
        catalog = Catalog(label)
        with context(catalog):
            barrier.wait(timeout=5)
            error = click.ClickException("APPLICATION_MESSAGE")
            text = click.get_current_context().gettext("hello")
            barrier.wait(timeout=5)
        return shown(error), text

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(worker, ["A", "B"]))
    for label, (error, text) in zip(["A", "B"], results):
        assert error.startswith(f"{label}::Error:")
        assert text == f"{label}::hello"
    assert shown(click.ClickException("plain")) == "Error: plain\n"
