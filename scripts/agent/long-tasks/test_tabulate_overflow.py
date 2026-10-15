"""Independent public-API acceptance for terminal cell overflow."""

import inspect
import re
import subprocess
import sys
from pathlib import Path

import pytest
import wcwidth
import tabulate as library


ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)", re.DOTALL)


def require_feature():
    parameters = inspect.signature(library.tabulate).parameters
    assert "coloverflow" in parameters, "exports coloverflow and truncation_marker"
    assert "truncation_marker" in parameters


def render(data, **kwargs):
    require_feature()
    return library.tabulate(data, **kwargs)


def visible(value):
    return ESCAPE.sub("", value)


def assert_closed_at_borders(rendered):
    """Observe terminal state, accepting equivalent basic SGR reset sequences."""
    observations = []
    for line in rendered.splitlines():
        foreground = False
        bold = False
        hyperlink = False
        index = 0
        while index < len(line):
            match = ESCAPE.match(line, index)
            if match:
                code = match.group()
                if code.startswith("\x1b[") and code.endswith("m"):
                    parameters = [int(item or 0) for item in code[2:-1].split(";")]
                    for item in parameters:
                        if item == 0:
                            foreground = bold = False
                        elif item == 1:
                            bold = True
                        elif item == 22:
                            bold = False
                        elif item == 39:
                            foreground = False
                        elif 30 <= item <= 37 or 90 <= item <= 97:
                            foreground = True
                elif code.startswith("\x1b]8;"):
                    payload = code[4:-1] if code.endswith("\x07") else code[4:-2]
                    hyperlink = payload.split(";", 1)[1]
                index = match.end()
                continue
            assert line[index] != "\x1b", "partial or unsupported escape in rendered cell"
            if line[index] in "|│" or re.match(r" +[|│]", visible(line[index:])):
                assert not foreground and not bold and not hyperlink, "terminal state leaked into table border"
            observations.append((line[index], foreground, bold, hyperlink))
            index += 1
        assert not foreground and not bold and not hyperlink
        observations.append(("\n", False, False, False))
    return observations


def retained_states(observations, text="abc"):
    content = "".join(item[0] for item in observations)
    start = content.index(text)
    return observations[start:start + len(text)]


def test_exports_truncation():
    require_feature()


@pytest.mark.parametrize("tablefmt", ["plain", "grid", "fancy_grid", "pipe"])
def test_body_truncation_uses_cell_width_before_table_layout(tablefmt):
    options = dict(headers=["Name", "Other"], tablefmt=tablefmt, disable_numparse=True)
    actual = render([["abcdefgh", "keep"], ["xy", "stable"]], maxcolwidths=[4, None], coloverflow="truncate", **options)
    expected = library.tabulate([["abc…", "keep"], ["xy", "stable"]], **options)
    assert actual == expected


def test_default_and_explicit_wrap_keep_existing_output():
    data = [["alpha beta gamma", 12.345], ["line one\nline two", 7.0]]
    options = dict(headers=["long header", "Number"], maxcolwidths=[5, None], maxheadercolwidths=[6, None], tablefmt="grid")
    expected = library.tabulate(data, **options)
    assert render(data, coloverflow="wrap", **options) == expected
    assert render(data, coloverflow=[], **options) == expected


def test_header_and_body_widths_are_independent():
    actual = render([["abcdefgh", "second-value"]], headers=["long-heading", "other-heading"], tablefmt="grid",
                    disable_numparse=True, coloverflow="truncate", maxcolwidths=[4, None], maxheadercolwidths=[3, 5])
    expected = library.tabulate([["abc…", "second-value"]], headers=["lo…", "othe…"], tablefmt="grid", disable_numparse=True)
    assert actual == expected


@pytest.mark.parametrize("modes", [["truncate"], ("truncate",), ["truncate", "wrap"]])
def test_per_column_modes_leave_trailing_columns_wrapped(modes):
    actual = render([["abcdefgh", "alpha beta"]], coloverflow=modes, maxcolwidths=[4, 4], tablefmt="grid", disable_numparse=True)
    expected = library.tabulate([["abc…", "alpha beta"]], maxcolwidths=[None, 4], tablefmt="grid", disable_numparse=True)
    assert actual == expected


def test_unbounded_body_and_header_remain_unchanged():
    options = dict(headers=["long heading"], tablefmt="grid", disable_numparse=True)
    data = [["unbounded content"]]
    expected = library.tabulate(data, **options)
    assert render(data, coloverflow="truncate", **options) == expected
    assert render(data, coloverflow="truncate", maxcolwidths=[None], maxheadercolwidths=[None], **options) == expected


@pytest.mark.parametrize("value,width,marker,expected", [
    ("abcd", 4, "…", "abcd"),
    ("abcde", 4, "..", "ab.."),
    ("abcdef", 2, "long", "lo"),
    ("abcdef", 2, "", "ab"),
    ("abcdef", 2, "界界", "界"),
    ("abcdef", 1, "界", ""),
    ("abcdef", 1, "…", "…"),
])
def test_marker_boundaries(value, width, marker, expected):
    actual = render([[value, "guard"]], coloverflow="truncate", maxcolwidths=[width, None], truncation_marker=marker,
                    tablefmt="grid", disable_numparse=True)
    assert actual == library.tabulate([[expected, "guard"]], tablefmt="grid", disable_numparse=True)


def test_multiline_cells_keep_internal_empty_lines_and_row_alignment():
    actual = render([["abcdef\n\nxyzabcdef", "side"]], coloverflow="truncate", maxcolwidths=[4, None],
                    tablefmt="grid", rowalign="bottom", disable_numparse=True)
    expected = library.tabulate([["abc…\n\nxyz…", "side"]], tablefmt="grid", rowalign="bottom", disable_numparse=True)
    assert actual == expected


def test_numeric_formatting_precedes_clipping_and_numeric_alignment_survives():
    actual = render([[1234.5678], [9.1]], tablefmt="grid", floatfmt=".2f", numalign="right",
                    coloverflow="truncate", maxcolwidths=5)
    expected = library.tabulate([["1234…"], ["9.10"]], tablefmt="grid", stralign="right", disable_numparse=True)
    assert actual == expected


def test_integer_grouping_is_applied_before_clipping():
    actual = render([[1234567], [25]], tablefmt="grid", intfmt=",", numalign="right",
                    coloverflow="truncate", maxcolwidths=6)
    expected = library.tabulate([["1,234…"], ["25"]], tablefmt="grid", stralign="right", disable_numparse=True)
    assert actual == expected


def test_missing_value_substitution_is_clipped():
    actual = render([[None], ["x"]], tablefmt="grid", missingval="(missing)", coloverflow="truncate", maxcolwidths=4)
    expected = library.tabulate([["(mi…"], ["x"]], tablefmt="grid", disable_numparse=True)
    assert actual == expected


def test_firstrow_and_mapping_headers_use_the_same_display_column_rules():
    options = dict(tablefmt="grid", disable_numparse=True, coloverflow="truncate", maxcolwidths=4, maxheadercolwidths=3)
    expected = library.tabulate([["abc…"]], headers=["he…"], tablefmt="grid", disable_numparse=True)
    assert render([["heading"], ["abcdef"]], headers="firstrow", **options) == expected
    assert render([{"heading": "abcdef"}], headers="keys", **options) == expected


def test_showindex_is_display_column_zero():
    actual = render([["abcdefgh"], ["xy"]], showindex=["first-row", "second-row"], tablefmt="grid",
                    disable_numparse=True, coloverflow="truncate", maxcolwidths=[4, 5])
    expected = library.tabulate([["abcd…"], ["xy"]], showindex=["fir…", "sec…"], tablefmt="grid", disable_numparse=True)
    assert actual == expected


@pytest.mark.parametrize("value,width,expected", [
    ("界界界A", 5, "界界…"),
    ("Ae\u0301BCDE", 4, "Ae\u0301B…"),
    ("A👨\u200d👩\u200d👧BCD", 4, "A👨\u200d👩\u200d👧…"),
    ("🇺🇸🇬🇧AB", 4, "🇺🇸…"),
    ("❤️❤️ab", 3, "❤️…"),
])
def test_unicode_display_graphemes_are_not_split(value, width, expected):
    actual = render([[value]], tablefmt="plain", disable_numparse=True, coloverflow="truncate", maxcolwidths=width)
    assert actual == expected
    assert wcwidth.wcswidth(actual) <= width


def test_clipped_sgr_is_preserved_and_closed_before_padding_and_border():
    cell = "\x1b[1;31mabcdef\x1b[0m"
    actual = render([[cell, "guard"]], tablefmt="grid", disable_numparse=True,
                    coloverflow="truncate", maxcolwidths=[4, None])
    expected = library.tabulate([["abc…", "guard"]], tablefmt="grid", disable_numparse=True)
    assert visible(actual) == expected
    observations = assert_closed_at_borders(actual)
    assert all(foreground and bold for _, foreground, bold, _ in retained_states(observations))


@pytest.mark.parametrize("terminator", ["\x07", "\x1b\\"])
def test_clipped_osc8_hyperlink_closes_before_adjacent_cells(terminator):
    opening = "\x1b]8;;https://example.invalid/document" + terminator
    closing = "\x1b]8;;" + terminator
    actual = render([[opening + "abcdef" + closing, "guard"]], tablefmt="grid", disable_numparse=True,
                    coloverflow="truncate", maxcolwidths=[4, None])
    expected = library.tabulate([["abc…", "guard"]], tablefmt="grid", disable_numparse=True)
    assert visible(actual) == expected
    observations = assert_closed_at_borders(actual)
    assert all(link == "https://example.invalid/document" for _, _, _, link in retained_states(observations))


def test_unclipped_escape_sequences_are_unchanged():
    value = "\x1b[31mabc\x1b[0m"
    actual = render([[value]], tablefmt="grid", coloverflow="truncate", maxcolwidths=10)
    assert value in actual
    assert actual == library.tabulate([[value]], tablefmt="grid")


def test_invalid_modes_markers_and_truncation_widths_raise_value_error():
    require_feature()
    for mode in [None, 1, True, {}, "clip", ["truncate", "invalid"], [None]]:
        with pytest.raises(ValueError):
            library.tabulate([["abcdef"]], coloverflow=mode, maxcolwidths=4)
    for marker in [None, 1, b"bytes", "a\nb", "a\rb", "\x1b[31mx"]:
        with pytest.raises(ValueError):
            library.tabulate([["abcdef"]], coloverflow="truncate", truncation_marker=marker, maxcolwidths=4)
    for width in [0, -1, True, False, 1.5, "4"]:
        for keyword in ["maxcolwidths", "maxheadercolwidths"]:
            with pytest.raises(ValueError):
                library.tabulate([["abcdef"]], headers=["heading"], coloverflow="truncate", **{keyword: [width]})


def test_optional_wcwidth_absence_keeps_the_codepoint_fallback_usable():
    require_feature()
    code = """import sys
sys.modules['wcwidth'] = None
from tabulate import tabulate
assert tabulate([['abcdef']], tablefmt='plain', coloverflow='truncate', maxcolwidths=4) == 'abc…'
assert tabulate([['界界界界界']], tablefmt='plain', coloverflow='truncate', maxcolwidths=4) == '界界界…'
"""
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr


def test_readme_and_offline_example_are_delivered():
    require_feature()
    readme = Path("README.md").read_text()
    assert "coloverflow" in readme and "truncation_marker" in readme
    result = subprocess.run([sys.executable, "examples/truncation.py"], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
