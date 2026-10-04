"""Behavioral build/CLI checks frozen before first participant execution."""
import copy
import hashlib
import json
import logging
from pathlib import Path

import pytest
import yaml
from click.testing import CliRunner

from mkdocs.__main__ import cli
from mkdocs.commands import build as build_command
from mkdocs.config.defaults import MkDocsConfig
from mkdocs.plugins import BasePlugin, event_priority
from mkdocs.structure.files import File


def config_for(tmp_path, *, manifest="deployment/manifest.json", require_feature=True, validate=True, **options):
    docs = tmp_path / "docs"
    theme = tmp_path / "theme"
    docs.mkdir(exist_ok=True)
    theme.mkdir(exist_ok=True)
    for name, data in {
        "index.md": b"# Home\nA public page.",
        "guide/topic.md": "# Guide\nUnicode: \u7ea2\u8272.".encode(),
        "assets/empty.bin": b"",
        "assets/data.bin": bytes(range(256)),
        "assets/caf\u00e9.txt": "caf\u00e9 \u7ea2\u8272".encode(),
    }.items():
        path = docs / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(data)
    (theme / "main.html").write_text("<!doctype html><title>{{ page.title }}</title>{{ page.content }}", encoding="utf8")
    (theme / "404.html").write_text("missing", encoding="utf8")
    cfg = MkDocsConfig(config_file_path=str(tmp_path / "mkdocs.yml"))
    if require_feature:
        assert "build_manifest" in dict(cfg._schema), "build_manifest option is missing"
    values = dict(site_name="Inventory fixture", docs_dir=str(docs), site_dir=str(tmp_path / "site"),
                  theme={"name": None, "custom_dir": str(theme), "static_templates": ["404.html"]}, plugins=[],
                  site_url="https://example.test/project/", use_directory_urls=True)
    values.update(options)
    if require_feature:
        values["build_manifest"] = manifest
    cfg.load_dict(values)
    if validate:
        errors, warnings = cfg.validate()
        assert errors == [] and warnings == [], (errors, warnings)
    return cfg


def inventory(cfg, manifest=None):
    path = Path(cfg.site_dir) / (manifest or cfg.build_manifest)
    return json.loads(path.read_text(encoding="utf8"))


def expected_files(cfg, manifest=None):
    root = Path(cfg.site_dir)
    excluded = manifest or cfg.build_manifest
    result = []
    for path in root.rglob("*"):
        if path.is_symlink() or any((root / parent).is_symlink() for parent in path.relative_to(root).parents):
            continue
        if path.is_file() and path.relative_to(root).as_posix() != excluded:
            raw = path.read_bytes()
            result.append({"path": path.relative_to(root).as_posix(), "size": len(raw),
                           "sha256": hashlib.sha256(raw).hexdigest()})
    return sorted(result, key=lambda entry: entry["path"])


def assert_inventory(cfg, manifest=None):
    value = inventory(cfg, manifest)
    assert value["version"] == 1
    actual = [{k: entry[k] for k in ["path", "size", "sha256"]} for entry in value["files"]]
    assert actual == expected_files(cfg, manifest)
    assert all(isinstance(entry["size"], int) and not isinstance(entry["size"], bool) for entry in value["files"])
    return value


class Probe(BasePlugin):
    def __init__(self, post=None, transform=None, files=None):
        self.post = post
        self.transform = transform
        self.files = files
        self.calls = []
        self.errors = []

    def on_files(self, files, *, config):
        if self.files:
            return self.files(files, config)

    def on_post_build(self, *, config):
        self.calls.append("post")
        if self.post:
            self.post(config)

    def on_build_manifest(self, manifest, *, config):
        self.calls.append("manifest")
        if self.transform:
            return self.transform(manifest, config)

    def on_build_error(self, *, error):
        self.errors.append(error)


@pytest.mark.parametrize("directory_urls", [False, True])
@pytest.mark.parametrize("manifest", ["manifest.json", "deployment/v1.json", "space dir/清单.json", ".inventory.json"])
def test_final_inventory_is_exact_sorted_and_counts_bytes(tmp_path, monkeypatch, directory_urls, manifest):
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")
    cfg = config_for(tmp_path, manifest=manifest, use_directory_urls=directory_urls)
    build_command.build(cfg)
    value = assert_inventory(cfg)
    names = [entry["path"] for entry in value["files"]]
    assert ("guide/topic/index.html" if directory_urls else "guide/topic.html") in names
    assert "assets/data.bin" in names and "assets/empty.bin" in names and "assets/café.txt" in names
    assert "404.html" in names
    assert str(tmp_path) not in json.dumps(value)
    first = (Path(cfg.site_dir) / manifest).read_bytes()
    build_command.build(cfg)
    assert (Path(cfg.site_dir) / manifest).read_bytes() == first


@pytest.mark.parametrize("value", [False, True, 0, 1, [], {}, "", "/tmp/inventory.json", "C:\\inventory.json", "C:inventory.json",
    "../inventory.json", "x/../inventory.json", "./inventory.json", "x/./inventory.json", "x//inventory.json",
    "x/", "x\\inventory.json", "bad\x00name.json", "bad\nname.json"])
def test_invalid_configuration_is_a_normal_validation_error(tmp_path, value):
    cfg = config_for(tmp_path, manifest=value, validate=False)
    errors, _ = cfg.validate()
    assert any(key == "build_manifest" for key, _ in errors)


def test_disabled_option_does_not_run_manifest_event(tmp_path):
    cfg = config_for(tmp_path, manifest=None)
    plugin = Probe()
    cfg.plugins["probe"] = plugin
    build_command.build(cfg)
    assert plugin.calls == ["post"]
    assert not (Path(cfg.site_dir) / "manifest.json").exists()
    assert not (Path(cfg.site_dir) / "deployment").exists()


def test_inventory_observes_post_build_changes_dotfiles_and_generated_files(tmp_path):
    cfg = config_for(tmp_path)
    def add_files(files, config):
        files.append(File.generated(config, "generated.md", content="# Generated"))
        return files
    def post(config):
        root = Path(config.site_dir)
        (root / "post.bin").write_bytes(b"\x00post\xff")
        (root / ".well-known").mkdir()
        (root / ".well-known/inventory-note").write_text("public")
        (root / "index.html").write_bytes(b"post-processed")
        (root / "assets/data.bin").unlink()
    plugin = Probe(post=post, files=add_files)
    cfg.plugins["probe"] = plugin
    build_command.build(cfg)
    value = assert_inventory(cfg)
    names = [x["path"] for x in value["files"]]
    assert "generated/index.html" in names and "post.bin" in names and ".well-known/inventory-note" in names
    assert "assets/data.bin" not in names
    assert plugin.calls == ["post", "manifest"]


def test_search_plugin_output_is_included(tmp_path):
    cfg = config_for(tmp_path, theme={"name": "mkdocs"}, plugins=["search"])
    build_command.build(cfg)
    value = assert_inventory(cfg)
    assert "search/search_index.json" in [x["path"] for x in value["files"]]


def test_dirty_build_inventory_includes_unchanged_and_stale_files(tmp_path):
    cfg = config_for(tmp_path)
    build_command.build(cfg)
    root = Path(cfg.site_dir)
    (root / "stale.bin").write_bytes(b"old deployment data")
    (Path(cfg.docs_dir) / "index.md").write_text("# Changed\nNew text")
    build_command.build(cfg, dirty=True)
    value = assert_inventory(cfg)
    assert "stale.bin" in [x["path"] for x in value["files"]]
    assert "New text" in (root / "index.html").read_text()
    assert cfg.build_manifest not in [x["path"] for x in value["files"]]


@pytest.mark.parametrize("mode", ["mutate", "replace", "reorder"])
def test_manifest_hooks_chain_metadata_and_save_sorted_inventory(tmp_path, mode):
    cfg = config_for(tmp_path)
    order = []
    class First(Probe):
        @event_priority(50)
        def on_build_manifest(self, manifest, *, config):
            order.append("first")
            manifest["deployment"] = {"channel": "test"}
            manifest["files"][0]["public"] = True
    class Second(Probe):
        @event_priority(-50)
        def on_build_manifest(self, manifest, *, config):
            order.append("second")
            assert manifest["deployment"] == {"channel": "test"}
            target = copy.deepcopy(manifest) if mode == "replace" else manifest
            target["approved"] = True
            if mode == "reorder":
                target["files"].reverse()
            return target if mode == "replace" else None
    cfg.plugins["second"] = Second()
    cfg.plugins["first"] = First()
    build_command.build(cfg)
    value = assert_inventory(cfg)
    assert order == ["first", "second"] and value["approved"] is True
    assert value["deployment"] == {"channel": "test"}
    assert value["files"][0]["public"] is True


@pytest.mark.parametrize("mode", ["version", "missing", "added", "duplicate", "path", "size", "digest", "list", "object", "nan"])
def test_invalid_hook_result_fails_without_replacing_prior_manifest(tmp_path, mode):
    cfg = config_for(tmp_path)
    build_command.build(cfg)
    path = Path(cfg.site_dir) / cfg.build_manifest
    previous = path.read_bytes()
    before = sorted(p.relative_to(cfg.site_dir).as_posix() for p in Path(cfg.site_dir).rglob("*") if p.is_file())
    def corrupt(value, config):
        if mode == "version": value["version"] = 2
        if mode == "missing": value["files"].pop()
        if mode == "added": value["files"].append({"path": "not-produced", "size": 1, "sha256": "0" * 64})
        if mode == "duplicate": value["files"].append(dict(value["files"][0]))
        if mode == "path": value["files"][0]["path"] = "renamed"
        if mode == "size": value["files"][0]["size"] += 1
        if mode == "digest": value["files"][0]["sha256"] = "0" * 64
        if mode == "list": return []
        if mode == "object": value["metadata"] = object()
        if mode == "nan": value["metadata"] = float("nan")
        return value
    plugin = Probe(transform=corrupt)
    cfg.plugins["probe"] = plugin
    with pytest.raises(Exception):
        build_command.build(cfg, dirty=True)
    assert path.read_bytes() == previous
    assert len(plugin.errors) == 1
    after = sorted(p.relative_to(cfg.site_dir).as_posix() for p in Path(cfg.site_dir).rglob("*") if p.is_file())
    assert after == before


@pytest.mark.parametrize("failure", ["post", "strict", "manifest"])
def test_failed_lifecycle_never_publishes_new_manifest(tmp_path, failure):
    cfg = config_for(tmp_path)
    build_command.build(cfg)
    path = Path(cfg.site_dir) / cfg.build_manifest
    previous = path.read_bytes()
    def post(config):
        if failure == "post": raise RuntimeError("post build failed")
        if failure == "strict": logging.getLogger("mkdocs.fixture").warning("test warning")
    def transform(value, config):
        if failure == "manifest": raise RuntimeError("manifest hook failed")
    plugin = Probe(post=post, transform=transform)
    cfg.plugins["probe"] = plugin
    cfg.strict = failure == "strict"
    with pytest.raises(Exception):
        build_command.build(cfg, dirty=True)
    assert path.read_bytes() == previous
    assert len(plugin.errors) == 1
    if failure != "manifest": assert "manifest" not in plugin.calls


@pytest.mark.parametrize("collision", ["page", "asset", "generated", "template"])
def test_existing_output_collisions_are_rejected(tmp_path, collision):
    name = {"page": "index.html", "asset": "assets/data.bin", "generated": "generated.txt", "template": "404.html"}[collision]
    cfg = config_for(tmp_path, manifest=name)
    if collision == "generated":
        def files(current, config):
            current.append(File.generated(config, "generated.txt", content="public generated output"))
            return current
        cfg.plugins["probe"] = Probe(files=files)
    with pytest.raises(Exception):
        build_command.build(cfg)
    target = Path(cfg.site_dir) / name
    if target.exists():
        with pytest.raises((ValueError, UnicodeDecodeError)):
            json.loads(target.read_bytes())


def test_collector_skips_file_and_directory_symlinks(tmp_path):
    cfg = config_for(tmp_path)
    external = tmp_path / "external"
    external.mkdir()
    (external / "private.txt").write_text("private-data")
    def post(config):
        root = Path(config.site_dir)
        (root / "linked-file").symlink_to(external / "private.txt")
        (root / "linked-dir").symlink_to(external, target_is_directory=True)
        (root / "cycle").symlink_to(root, target_is_directory=True)
    cfg.plugins["probe"] = Probe(post=post)
    build_command.build(cfg)
    value = assert_inventory(cfg)
    assert all("linked" not in x["path"] and "cycle" not in x["path"] for x in value["files"])


@pytest.mark.parametrize("kind", ["destination", "parent"])
def test_manifest_path_never_follows_symlinks(tmp_path, kind):
    cfg = config_for(tmp_path, manifest="redirect/out.json")
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "out.json"
    sentinel.write_text("do not replace")
    root = Path(cfg.site_dir)
    root.mkdir()
    if kind == "parent": (root / "redirect").symlink_to(outside, target_is_directory=True)
    else:
        (root / "redirect").mkdir()
        (root / "redirect/out.json").symlink_to(sentinel)
    with pytest.raises(Exception):
        build_command.build(cfg, dirty=True)
    assert sentinel.read_text() == "do not replace"


@pytest.mark.parametrize("command", ["build", "serve"])
def test_cli_documents_manifest_flag(command):
    result = CliRunner().invoke(cli, [command, "--help"])
    assert result.exit_code == 0 and "--manifest" in result.output


@pytest.mark.parametrize("override", [None, "cli/manifest.json"])
def test_build_cli_preserves_yaml_or_applies_override(tmp_path, override):
    cfg = config_for(tmp_path, manifest="yaml/manifest.json")
    path = tmp_path / "mkdocs.yml"
    path.write_text(yaml.safe_dump({"site_name": "CLI", "docs_dir": cfg.docs_dir, "site_dir": cfg.site_dir,
        "theme": {"name": None, "custom_dir": str(tmp_path / "theme")}, "plugins": [], "build_manifest": cfg.build_manifest}))
    args = ["build", "-f", str(path)] + (["--manifest", override] if override else [])
    result = CliRunner().invoke(cli, args)
    assert result.exit_code == 0, result.output
    assert_inventory(cfg, override or cfg.build_manifest)
    if override: assert not (Path(cfg.site_dir) / cfg.build_manifest).exists()


def test_serve_cli_initial_and_reload_build_use_manifest_option(tmp_path, monkeypatch):
    from mkdocs.commands import serve as serve_command
    cfg = config_for(tmp_path, manifest="yaml/manifest.json")
    path = tmp_path / "mkdocs.yml"
    path.write_text(yaml.safe_dump({"site_name": "Serve", "docs_dir": cfg.docs_dir,
        "theme": {"name": None, "custom_dir": str(tmp_path / "theme")}, "plugins": [], "build_manifest": cfg.build_manifest}))
    snapshots = []
    class Server:
        def __init__(self, *, builder, root, **kwargs): self.builder, self.root = builder, Path(root)
        def watch(self, *args, **kwargs): pass
        def shutdown(self): pass
        def serve(self, **kwargs):
            snapshots.append(json.loads((self.root / "cli/manifest.json").read_text()))
            (Path(cfg.docs_dir) / "new.md").write_text("# New reload page")
            self.builder()
            snapshots.append(json.loads((self.root / "cli/manifest.json").read_text()))
            assert not (self.root / "yaml/manifest.json").exists()
    monkeypatch.setattr(serve_command, "LiveReloadServer", Server)
    result = CliRunner().invoke(cli, ["serve", "-f", str(path), "--manifest", "cli/manifest.json", "--no-livereload"])
    assert result.exit_code == 0, result.output
    assert len(snapshots) == 2
    assert "new/index.html" not in [x["path"] for x in snapshots[0]["files"]]
    assert "new/index.html" in [x["path"] for x in snapshots[1]["files"]]
