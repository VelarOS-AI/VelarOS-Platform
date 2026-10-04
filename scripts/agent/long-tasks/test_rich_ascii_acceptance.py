"""Independent behavioral checks for the frozen Rich development task."""

from io import StringIO

import pytest

from rich import box
from rich.bar import Bar
from rich.console import Console, Group
from rich.layout import Layout
from rich.markdown import Markdown
from rich.panel import Panel
from rich.pretty import Pretty
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn
from rich.progress_bar import ProgressBar
from rich.rule import Rule
from rich.spinner import Spinner
from rich.status import Status
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from rich.traceback import Traceback
from rich.tree import Tree


class EncodedOutput(StringIO):
    def __init__(self, encoding):
        super().__init__()
        self._encoding = encoding

    @property
    def encoding(self):
        return self._encoding


def console(**kwargs):
    return Console(file=StringIO(), width=48, color_system=None, get_time=lambda: 0.0, **kwargs)


def render(item, *, mode=True, width=48):
    target = console(ascii_only=mode, record=True)
    target.print(item, width=width)
    return target.export_text()


def make_table():
    table = Table(title="Inventory", caption="Current", show_lines=True)
    table.add_column("Name")
    table.add_column("Count")
    table.add_row("apple", "3")
    table.add_row("pear", "4")
    return table


def make_tree():
    tree = Tree("root", guide_style="bold underline2")
    tree.add("branch").add("leaf")
    tree.add("other")
    return tree


def make_traceback():
    try:
        raise ValueError("invalid item")
    except ValueError as error:
        return Traceback.from_exception(type(error), error, error.__traceback__)


def make_syntax_error():
    try:
        compile("def broken(:\n    pass", "input.py", "exec")
    except SyntaxError as error:
        return Traceback.from_exception(type(error), error, error.__traceback__)


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16", "ascii", "cp1252"])
@pytest.mark.parametrize("mode", [None, True, False])
def test_mode_precedence(encoding, mode):
    target = Console(file=EncodedOutput(encoding), ascii_only=mode)
    expected = not encoding.startswith("utf") if mode is None else mode
    assert target.ascii_only is expected
    assert target.options.ascii_only is expected
    assert target.encoding == encoding


def test_local_option_copy():
    target = console(ascii_only=False)
    options = target.options
    updated = options.update(ascii_only=True)
    assert not options.ascii_only
    assert not target.ascii_only
    assert updated.ascii_only
    assert updated.update(width=21).ascii_only
    assert not updated.update(ascii_only=False).ascii_only
    text = "".join(segment.text for segment in target.render(Panel("value"), updated))
    assert text.isascii()


@pytest.mark.parametrize(
    "factory",
    [
        make_table,
        lambda: Panel("payload", title="Title", subtitle="Subtitle"),
        lambda: Rule("Title"),
        lambda: Rule(),
        make_tree,
        lambda: ProgressBar(total=100, completed=37),
        lambda: ProgressBar(total=100, completed=100),
        lambda: ProgressBar(pulse=True),
        lambda: Bar(size=100, begin=12, end=73, width=18),
        lambda: Spinner("dots", text="Loading"),
        lambda: Spinner("dots", text=Panel("Loading")),
        lambda: Status("Loading", console=console(ascii_only=True)),
        lambda: Markdown("# Title\n\n- first\n  - nested\n- second\n\n> quote\n\n---\n\n![photo](img.png)\n\n| A | B |\n| - | - |\n| a | b |"),
        lambda: Syntax("x = 1\nprint(x)", "python", line_numbers=True, highlight_lines={1}),
        make_traceback,
        make_syntax_error,
        lambda: Pretty({"items": list(range(24))}, max_length=3),
        lambda: Layout(name="main"),
    ],
    ids=["table", "panel", "rule-title", "rule-empty", "tree", "progress-partial", "progress-complete", "progress-pulse", "bar", "spinner-text", "spinner-nested", "status", "markdown", "syntax", "traceback", "syntax-error", "pretty", "layout"],
)
def test_built_in_ascii_decorations(factory):
    output = render(factory())
    assert output.strip()
    assert output.isascii(), repr(output)


@pytest.mark.parametrize("width", [1, 2, 3, 7, 19])
@pytest.mark.parametrize("kind", ["rule", "bar", "progress"])
def test_narrow_widths(kind, width):
    item = {"rule": Rule("a long title"), "bar": Bar(100, 1, 33, width=width), "progress": ProgressBar(total=100, completed=33, width=width)}[kind]
    output = render(item, width=width)
    assert output.isascii()
    assert all(len(line) <= width for line in output.splitlines())


@pytest.mark.parametrize("box_name", ["ASCII", "SQUARE", "ROUNDED", "HEAVY", "DOUBLE", "HORIZONTALS"])
def test_standard_boxes(box_name):
    table = make_table()
    table.box = getattr(box, box_name)
    assert render(table).isascii()


@pytest.mark.parametrize("kind", ["table", "markdown", "spinner", "traceback"])
def test_unicode_content_preserved(kind):
    label = "café 中文"
    if kind == "table":
        item = Table()
        item.add_column("Text")
        item.add_row(label)
    elif kind == "markdown":
        item = Markdown(label)
    elif kind == "spinner":
        item = Spinner("dots", text=Text(label))
    else:
        error = ValueError(label)
        item = Traceback.from_exception(type(error), error, None)
    output = render(item)
    assert label in output
    assert output.replace(label, "").isascii()


def test_reusable_objects_do_not_leak_mode():
    for item in [Panel("content"), Spinner("dots", text="wait"), make_tree(), make_table(), ProgressBar(total=10, completed=3)]:
        before = render(item, mode=False)
        assert not before.isascii()
        assert render(item, mode=True).isascii()
        assert render(item, mode=False) == before


def test_nested_progress_and_inspect():
    target = console(ascii_only=True, record=True)
    progress = Progress(SpinnerColumn(), TextColumn("{task.description}"), BarColumn(), console=target, auto_refresh=False)
    progress.add_task("copy", total=10, completed=4)
    target.print(Panel(Group(progress, make_tree(), Markdown("- entry"))))
    from rich import inspect
    inspect({"a": 1}, console=target, methods=False)
    assert target.export_text().isascii()
