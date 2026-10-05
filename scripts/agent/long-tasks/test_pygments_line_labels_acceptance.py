"""Independent public-output checks for the frozen line-label integration task."""

import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

import pytest

from pygments import format as pygments_format
from pygments.formatter import Formatter
from pygments.formatters import get_formatter_by_name
from pygments.token import Comment, Name, Text
from pygments.util import OptionError


VIEWS = [
    "html-table",
    "html-inline",
    "svg",
    "rtf",
    "terminal",
    "terminal256",
    "terminal16m",
    "groff",
]
TOKENS = [(Name, "alpha"), (Text, "\nbeta\n"), (Comment, "gamma")]
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def formatter(view, **options):
    alias = "html" if view.startswith("html-") else view
    opts = {"linenos": True}
    if view.startswith("html-"):
        opts["linenos"] = view.split("-", 1)[1]
    opts.update(options)
    return get_formatter_by_name(alias, **opts)


def render(view, tokens=TOKENS, **options):
    return pygments_format(iter(tokens), formatter(view, **options))


class HtmlNumbers(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.labels = []
        self.targets = []
        self.active = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "").split()
        table_number = tag == "td" and "linenos" in classes
        in_table = any(number for _, number in self.stack)
        if tag == "span" and ("linenos" in classes or in_table):
            self.active = {"depth": len(self.stack), "text": ""}
        for name in ("href", "id", "name"):
            if name in attrs:
                self.targets.append((tag, name, attrs[name]))
        if tag not in {"br", "meta", "link", "img", "hr"}:
            self.stack.append((tag, table_number))

    def handle_endtag(self, tag):
        if (
            self.active
            and tag == "span"
            and len(self.stack) == self.active["depth"] + 1
        ):
            self.labels.append(self.active["text"])
            self.active = None
        if self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if self.active:
            self.active["text"] += data


def html_numbers(value):
    parser = HtmlNumbers()
    parser.feed(value)
    return parser


def svg_numbers(value):
    root = ET.fromstring(value)
    return [
        node
        for node in root.iter()
        if node.tag.endswith("}text") and node.get("text-anchor") == "end"
    ]


def plain_labels(view, value):
    if view.startswith("html-"):
        return html_numbers(value).labels
    if view == "svg":
        return ["".join(node.itertext()) for node in svg_numbers(value)]
    if view == "rtf":
        return re.findall(r"\{\\cf\d+ ([^{}\\]*?) {2}\}", value)
    value = ANSI.sub("", value)
    if view.startswith("terminal"):
        return re.findall(r"^([^\n:]+): ", value, re.M)
    return re.findall(r"^((?:P\[)? *\d+(?:\]Q)?) ", value, re.M)


@pytest.mark.parametrize("view", VIEWS)
def test_native_number_fields_receive_affixes(view):
    before = plain_labels(view, render(view))
    after = plain_labels(view, render(view, lineno_prefix="P[", lineno_suffix="]Q"))
    assert before, "baseline number parser must discover numbers"
    assert after == [
        "P[" + number + "]Q" for number in before
    ], "line number affixes were not rendered"


@pytest.mark.parametrize("view", VIEWS)
def test_empty_defaults_and_disabled_numbering(view):
    assert render(view) == render(view, lineno_prefix="", lineno_suffix="")
    assert render(view, linenos=False) == render(
        view, linenos=False, lineno_prefix="P[", lineno_suffix="]Q"
    )
    f = formatter(view)
    assert f.lineno_prefix == f.lineno_suffix == ""


@pytest.mark.parametrize("option", ["lineno_prefix", "lineno_suffix"])
@pytest.mark.parametrize("value", [None, 42, ["text"], "bad\nline", "bad\rline"])
def test_options_reject_invalid_values_before_rendering(option, value):
    with pytest.raises(OptionError, match=option):
        Formatter(**{option: value})
    for view in VIEWS:
        with pytest.raises(OptionError, match=option):
            formatter(view, linenos=False, **{option: value})


@pytest.mark.parametrize("view", VIEWS)
def test_reused_and_interleaved_instances_start_each_document_independently(view):
    first = formatter(view, lineno_prefix="P[", lineno_suffix="]Q")
    second = formatter(view, lineno_prefix="other", lineno_suffix="end")
    expected = pygments_format(iter(TOKENS), first)
    pygments_format(iter([(Text, "one\ntwo\nthree\n")]), second)
    assert pygments_format(iter(TOKENS), first) == expected
    assert expected == render(view, lineno_prefix="P[", lineno_suffix="]Q")
    assert first.lineno_prefix == "P[" and second.lineno_prefix == "other"


@pytest.mark.parametrize("view", VIEWS)
def test_fragmented_one_shot_stream_and_encoded_output(view):
    tokens = [(Text, "a"), (Name, "b\n"), (Text, "\n"), (Comment, "café")]
    opts = {"lineno_prefix": "P[", "lineno_suffix": "]Q"}
    unicode_output = render(view, tokens, **opts)
    encoded = render(view, tokens, encoding="utf-8", **opts)
    if view == "svg":
        # The encoding declaration is intentionally present only for byte output.
        assert ET.tostring(ET.fromstring(encoded)) == ET.tostring(
            ET.fromstring(unicode_output)
        )
    else:
        assert encoded.decode("utf-8") == unicode_output
    before = plain_labels(view, render(view, tokens))
    after = plain_labels(view, unicode_output)
    assert after == [
        "P[" + number + "]Q" for number in before
    ], "line number affixes were not rendered"


@pytest.mark.parametrize("mode", ["html-table", "html-inline"])
@pytest.mark.parametrize("noclasses", [False, True])
def test_html_escaping_padding_numeric_anchors_and_skipped_fields(mode, noclasses):
    opts = dict(
        linenostart=9,
        linenostep=2,
        linenospecial=2,
        lineanchors="source",
        anchorlinenos=True,
        noclasses=noclasses,
    )
    # Inline-style mode has no distinguishing span classes; compare its escaped public text below.
    base = render(mode, **opts)
    out = render(mode, lineno_prefix="<&P[", lineno_suffix="]é>", **opts)
    assert "&lt;&amp;P[10]é&gt;" in out
    assert "<&P[" not in out
    assert html_numbers(out).targets == html_numbers(base).targets
    if not noclasses:
        labels = html_numbers(out).labels
        assert labels == [" " * 9, "<&P[10]é>", " " * 9]
    assert "alpha" in out and "gamma" in out


@pytest.mark.parametrize("mode", ["html-table", "html-inline"])
def test_html_full_document_keeps_style_definitions_and_source(mode):
    opts = dict(full=True, lineanchors="part", anchorlinenos=True, linenostart=9)
    base = render(mode, **opts)
    out = render(mode, lineno_prefix="P[", lineno_suffix="]Q", **opts)
    assert html_numbers(out).labels == ["P[ 9]Q", "P[10]Q", "P[11]Q"]
    assert html_numbers(out).targets == html_numbers(base).targets
    assert re.findall(r"<style.*?</style>", base, re.S) == re.findall(
        r"<style.*?</style>", out, re.S
    )


def test_svg_escaping_selection_and_coordinates():
    opts = dict(linenostart=7, linenostep=2, linenowidth=88)
    base = ET.fromstring(render("svg", **opts))
    output = render("svg", lineno_prefix="<&P[", lineno_suffix="]é>", **opts)
    actual = ET.fromstring(output)
    left, right = list(base.iter()), list(actual.iter())
    assert len(left) == len(right)
    number_count = 0
    for a, b in zip(left, right):
        assert a.tag == b.tag and a.attrib == b.attrib
        assert a.tail == b.tail
        if a.get("text-anchor") == "end":
            number_count += 1
            assert b.text == "<&P[" + a.text + "]é>"
        else:
            assert a.text == b.text
    assert number_count > 0


def test_rtf_plain_text_escaping_and_unicode():
    out = render("rtf", lineno_prefix="{\\é", lineno_suffix="中}")
    assert r"\{\\{\u233}1{\u20013}\}" in out
    assert "alpha" in out and "gamma" in out


def test_rtf_skipped_number_fields_reserve_affix_width():
    options = dict(linenostart=9, linenostep=2)
    before = plain_labels("rtf", render("rtf", **options))
    after = plain_labels(
        "rtf", render("rtf", lineno_prefix="P[", lineno_suffix="]Q", **options)
    )
    assert (
        before
        and any(value.strip() for value in before)
        and any(not value.strip() for value in before)
    )
    assert after == [
        "P[" + value + "]Q" if value.strip() else " " * (len(value) + 4)
        for value in before
    ]


@pytest.mark.parametrize("view", ["terminal", "terminal256", "terminal16m"])
def test_terminal_unicode_labels_do_not_rewrite_unicode_source(view):
    tokens = [(Text, "café 中\nother")]
    out = ANSI.sub("", render(view, tokens, lineno_prefix="行[", lineno_suffix="]é"))
    assert out.startswith("行[0001]é: café 中\n行[0002]é: other")


def test_groff_affixes_are_text_and_wrapping_reserves_the_number_column():
    escaped = render("groff", lineno_prefix=".\\é", lineno_suffix="'")
    assert r"\[char46]\[u005C]\[u00E9]   1\[u0027] " in escaped
    tokens = [(Text, "abcdefghijkl")]
    value = render("groff", tokens, wrap=4, lineno_prefix="P[", lineno_suffix="]Q")
    assert "P[   1]Q abcd\n         efgh\n         ijkl" in value
    f = formatter("groff", wrap=4, lineno_prefix="P[", lineno_suffix="]Q")
    expected = pygments_format(iter(tokens), f)
    assert pygments_format(iter(tokens), f) == expected


@pytest.mark.parametrize("alias", ["html", "terminal", "svg", "rtf", "groff"])
def test_cli_passes_label_options_to_formatters(alias):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pygments",
            "-l",
            "text",
            "-f",
            alias,
            "-O",
            "linenos=true",
            "-P",
            "lineno_prefix=P[",
            "-P",
            "lineno_suffix=]Q",
        ],
        input="alpha\nbeta\n",
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert (
        "P[" in result.stdout and "]Q" in result.stdout
    ), "line number affixes were not rendered"


def test_base_formatter_validates_and_exposes_independent_options():
    one = Formatter(lineno_prefix="<", lineno_suffix="é")
    two = Formatter()
    assert (one.lineno_prefix, one.lineno_suffix) == ("<", "é")
    assert (two.lineno_prefix, two.lineno_suffix) == ("", "")
