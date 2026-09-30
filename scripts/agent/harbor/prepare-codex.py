"""Package the pinned official Codex CLI and verified Linux Node runtime."""

import hashlib
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    root = Path(__file__).resolve().parents[3]
    work = root / ".velaros-workspace/bench"
    output = work / "comparison/codex-0.158.0-linux-x64.tar.gz"
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        manifest = json.loads(output.with_suffix(".json").read_text())
        if manifest["version"] != "0.158.0" or digest(output) != manifest["sha256"]:
            raise ValueError("Existing Codex artifact failed verification; preserve it and use a new artifact path")
        print(output, json.dumps(manifest))
        return
    node_archive = work / "runtime-downloads/node-v24.15.0-linux-x64.tar.xz"
    node_sha = "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6"
    if digest(node_archive) != node_sha:
        raise ValueError("Node archive differs from official SHA-256")
    with tempfile.TemporaryDirectory(prefix="codex-pack-", dir=output.parent) as temporary:
        package = Path(temporary)
        (package / "package.json").write_text(json.dumps({"name": "harbor-codex-portable", "private": True, "dependencies": {"@openai/codex": "0.158.0"}}))
        for flags in (["--lockfile-only"], ["--production", "--frozen-lockfile", "--os", "linux", "--cpu", "x64"]):
            subprocess.run(["bun", "install", "--ignore-scripts", *flags], cwd=package, check=True, timeout=180)
        (package / "node").mkdir()
        subprocess.run(["tar", "-xJf", str(node_archive), "--strip-components", "1", "-C", str(package / "node")], check=True)
        for entry in package.rglob("*"):
            if entry.is_symlink() and not entry.resolve().is_relative_to(package):
                raise ValueError(f"External symlink in CLI archive: {entry.relative_to(package)}")
        manifest = {"cli": "@openai/codex", "version": "0.158.0", "arch": "x64", "nodeVersion": "24.15.0", "nodeSha256": node_sha,
                    "lockSha256": digest(package / "bun.lock")}
        (package / "installation.json").write_text(json.dumps(manifest, indent=2))
        with tarfile.open(output, "w:gz") as archive:
            for entry in sorted(package.iterdir()):
                archive.add(entry, arcname=entry.name)
    manifest["sha256"] = digest(output)
    manifest["bytes"] = output.stat().st_size
    output.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(output, json.dumps(manifest))


if __name__ == "__main__":
    main()
