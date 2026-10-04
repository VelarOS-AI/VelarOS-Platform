"""Frozen behavioral checks; candidates do not receive this file."""
import copy
from html.parser import HTMLParser
import xml.etree.ElementTree as etree

import markdown
from markdown.extensions import Extension
from markdown.treeprocessors import Treeprocessor
import pytest


class Elements(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.elements = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    @property
    def classes(self):
        return {token for _, attrs in self.elements for token in attrs.get("class", "").split()}

    @property
    def targets(self):
        return [(tag, key, value) for tag, attrs in self.elements
                for key, value in attrs.items() if key in {"id", "href", "src"}]


def convert(source, extensions=(), configs=None, prefix="doc-", **options):
    md = markdown.Markdown(
        extensions=list(extensions), extension_configs=copy.deepcopy(configs or {}),
        class_prefix=prefix, **options
    )
    assert md.class_prefix == prefix
    return md, md.convert(source)


CASES = [
    ("footnotes", "text[^a] and again[^a]\n\n[^a]: detail", ["footnotes"], {},
     {"footnote", "footnote-ref", "footnote-backref"}),
    ("admonition", '!!! note "Title"\n    café 中文', ["admonition"], {},
     {"admonition", "note", "admonition-title"}),
    ("fenced", '```python\nx = "中文"\n```', ["fenced_code"], {}, {"language-python"}),
    ("fenced-config", '```python\nx = 1\n```', ["fenced_code"],
     {"fenced_code": {"lang_prefix": "source-"}}, {"source-python"}),
    ("hilite", '    :::python\n    x = "中文"', ["codehilite"], {}, {"codehilite"}),
    ("hilite-fallback", '    :::python\n    x = 1', ["codehilite"],
     {"codehilite": {"use_pygments": False}}, {"codehilite", "language-python"}),
    ("hilite-config", '    :::python\n    x = 1', ["codehilite"],
     {"codehilite": {"css_class": "highlight compact"}}, {"highlight", "compact"}),
    ("hilite-fenced", '```python\nx = 1\n```', ["fenced_code", "codehilite"],
     {"codehilite": {"css_class": "highlight compact"}}, {"highlight", "compact"}),
    ("toc", '[TOC]\n\n# Heading\n\n## Child', ["toc"],
     {"toc": {"title": "Contents", "anchorlink": True, "permalink": True}},
     {"toc", "toctitle", "toclink", "headerlink"}),
    ("toc-config", '[TOC]\n\n# Heading', ["toc"],
     {"toc": {"title": "Contents", "anchorlink": True, "permalink": True,
              "toc_class": "outline compact", "title_class": "caption",
              "anchorlink_class": "jump heading", "permalink_class": "perma mark"}},
     {"outline", "compact", "caption", "jump", "heading", "perma", "mark"}),
    ("wiki", '[[Page Name]]', ["wikilinks"], {}, {"wikilink"}),
    ("wiki-config", '[[Page Name]]', ["wikilinks"],
     {"wikilinks": {"html_class": "wiki internal"}}, {"wiki", "internal"}),
]


@pytest.mark.parametrize("prefix", ["", "doc-", "_reader2-"])
@pytest.mark.parametrize("name,source,extensions,configs,classes", CASES,
                         ids=[item[0] for item in CASES])
def test_generated_classes_and_link_identity(name, source, extensions, configs, classes, prefix):
    _, html = convert(source, extensions, configs, prefix)
    _, plain = convert(source, extensions, configs, "")
    actual = Elements(html)
    assert {prefix + token for token in classes} <= actual.classes
    if prefix:
        assert not classes.intersection(actual.classes)
    assert actual.targets == Elements(plain).targets
    if name.startswith("hilite"):
        assert Elements(plain).classes - classes <= actual.classes


@pytest.mark.parametrize("prefix", [None, True, 2, [], {}])
def test_non_string_prefix_is_rejected(prefix):
    with pytest.raises(TypeError):
        markdown.Markdown(class_prefix=prefix)


@pytest.mark.parametrize("prefix", ["two words", "9start", "-dash", "a:b", "x.", "中文", "x\n"])
def test_invalid_prefix_is_rejected(prefix):
    with pytest.raises(ValueError):
        markdown.Markdown(class_prefix=prefix)


def test_default_and_top_level_api():
    md = markdown.Markdown()
    assert md.class_prefix == ""
    source = "text[^n]\n\n[^n]: note"
    plain = markdown.markdown(source, extensions=["footnotes"])
    assert plain == markdown.markdown(source, extensions=["footnotes"], class_prefix="")
    assert "book-footnote" in markdown.markdown(source, extensions=["footnotes"], class_prefix="book-")


@pytest.mark.parametrize("output_format", ["html", "xhtml"])
def test_nested_admonitions_and_extension_composition(output_format):
    source = ('!!! note "Outer"\n    !!! warning "Inner"\n        café 中文\n\n'
              '        - first[^one]\n        - second\n\n[^one]: footnote detail')
    _, html = convert(source, ["extra", "admonition", "sane_lists"], output_format=output_format)
    actual = Elements(html)
    assert {"doc-admonition", "doc-note", "doc-warning", "doc-admonition-title",
            "doc-footnote", "doc-footnote-ref", "doc-footnote-backref"} <= actual.classes
    assert sum("doc-admonition" in attrs.get("class", "").split()
               for _, attrs in actual.elements) == 2
    assert "café 中文" in html
    assert "<li>" in html


def test_toc_property_inserted_toc_and_reset_agree():
    configs = {"toc": {"title": "Contents", "anchorlink": True, "permalink": True}}
    md, html = convert("[TOC]\n\n# Café 中文\n\n## Nested", ["toc"], configs)
    expected = {"doc-toc", "doc-toctitle"}
    assert expected <= Elements(md.toc).classes
    assert md.toc.strip() in html
    assert md.toc_tokens[0]["name"] == "Café 中文"
    md.reset()
    second = md.convert("[TOC]\n\n# Other")
    assert md.class_prefix == "doc-"
    assert "Café 中文" not in second
    assert expected <= Elements(md.toc).classes
    assert md.toc.strip() in second


def test_explicit_classes_raw_html_and_literals_keep_their_spelling():
    source = ('# User heading {.toc .footnote}\n\n'
              'Paragraph\n{.admonition .note}\n\n'
              '<div class="toc footnote" markdown="1">\n\n**nested**\n{.headerlink}\n\n</div>\n\n'
              '<span class="wikilink">raw café 中文</span>\n\n'
              '`class="footnote"`\n\n'
              'text[^x]\n\n[^x]: generated footnote')
    explicit = {"toc", "footnote", "admonition", "note", "headerlink", "wikilink"}
    # This fixture must actually create the user classes even before the new option exists.
    assert explicit <= Elements(markdown.markdown(source, extensions=["extra", "toc"])).classes
    _, html = convert(source, ["extra", "toc"])
    actual = Elements(html)
    assert explicit | {"doc-footnote", "doc-footnote-ref", "doc-footnote-backref"} <= actual.classes
    assert 'class="footnote"' in html
    assert "raw café 中文" in html
    assert '<span class="wikilink">' in html


@pytest.mark.parametrize("with_hilite", [False, True])
def test_fenced_explicit_classes_and_id_are_not_generated(with_hilite):
    extensions = ["fenced_code", "attr_list"] + (["codehilite"] if with_hilite else [])
    configs = {"codehilite": {"use_pygments": False}}
    source = '```{.python .footnote .custom #sample}\nprint("café 中文")\n```'
    _, html = convert(source, extensions, configs)
    actual = Elements(html)
    assert {"doc-language-python", "footnote", "custom"} <= actual.classes
    assert "doc-footnote" not in actual.classes
    assert ("pre", "id", "sample") in actual.targets
    assert "café 中文" in html


def test_empty_optional_classes_stay_empty():
    _, html = convert("[TOC]\n\n# Heading\n\n[[Page]]", ["toc", "wikilinks"], {
        "toc": {"title": "Contents", "toc_class": "", "title_class": "",
                "anchorlink": True, "anchorlink_class": "",
                "permalink": True, "permalink_class": ""},
        "wikilinks": {"html_class": ""},
    })
    assert Elements(html).classes == set()


def test_meta_wikilink_configuration_uses_generated_class():
    _, html = convert("wiki_html_class: custom links\n\n[[Page Name]]", ["meta", "wikilinks"])
    assert {"doc-custom", "doc-links"} <= Elements(html).classes


def test_prefix_is_local_to_each_converter_and_configuration():
    configs = {"toc": {"toc_class": "outline compact"}}
    source = "[TOC]\n\n# Heading"
    a, first = convert(source, ["toc"], configs, "a-")
    b, second = convert(source, ["toc"], configs, "b-")
    assert {"a-outline", "a-compact"} <= Elements(first).classes
    assert {"b-outline", "b-compact"} <= Elements(second).classes
    a.reset()
    assert a.convert(source) == first
    assert b.convert(source) == second
    assert configs == {"toc": {"toc_class": "outline compact"}}
    assert {"outline", "compact"} <= Elements(markdown.markdown(source, extensions=["toc"],
                                                              extension_configs=configs)).classes


class CustomClasses(Treeprocessor):
    def run(self, root):
        element = etree.SubElement(root, "aside")
        element.set("class", "footnote external")
        element.text = "third party"


class CustomExtension(Extension):
    def extendMarkdown(self, md):
        md.treeprocessors.register(CustomClasses(md), "custom_class_probe", 25)


def test_third_party_extension_classes_are_preserved():
    _, html = convert("text[^a]\n\n[^a]: detail", [CustomExtension(), "footnotes"])
    actual = Elements(html)
    assert {"footnote", "external", "doc-footnote"} <= actual.classes
    assert '<aside class="footnote external">third party</aside>' in html
