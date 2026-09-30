"""Prepare a portable Linux agent archive before the benchmark setup timer starts."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, default=Path(".velaros-workspace/bench/bundle"))
    parser.add_argument("--arch", choices=["x64", "arm64"], default="x64")
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    identity = json.loads((bundle / "identity.json").read_text())
    archive = bundle.parent / f"{bundle.name}-linux-{args.arch}.tar.gz"
    if archive.exists():
        metadata = json.loads(archive.with_suffix(".json").read_text())
        if metadata["bundleFingerprint"] != identity["bundleFingerprint"] or digest(archive) != metadata["sha256"]:
            raise ValueError("Existing portable artifact differs; preserve it and prepare a new versioned bundle")
        print(archive, json.dumps(metadata), flush=True)
        return
    cache = bundle.parent / "runtime-downloads"
    cache.mkdir(exist_ok=True)
    node_name = f"node-v24.15.0-linux-{args.arch}.tar.xz"
    base = "https://nodejs.org/dist/v24.15.0/"
    with urllib.request.urlopen(base + "SHASUMS256.txt", timeout=30) as response:
        checksums = response.read().decode().splitlines()
    expected = next(line.split()[0] for line in checksums if line.split()[-1] == node_name)
    node = cache / node_name
    if not node.exists() or digest(node) != expected:
        partial = node.with_suffix(node.suffix + ".partial")
        with urllib.request.urlopen(base + node_name, timeout=60) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        if digest(partial) != expected:
            raise RuntimeError("Official Node archive checksum mismatch")
        os.replace(partial, node)
    with tempfile.TemporaryDirectory(prefix="scriptact-linux-", dir=bundle.parent) as temporary:
        prepared = Path(temporary) / "agent"
        shutil.copytree(bundle, prepared, ignore=shutil.ignore_patterns("node_modules"))
        subprocess.run(["bun", "install", "--production", "--ignore-scripts", "--frozen-lockfile", "--os", "linux", "--cpu", args.arch], cwd=prepared, check=True, timeout=300)
        (prepared / "node").mkdir()
        subprocess.run(["tar", "-xJf", str(node), "--strip-components", "1", "-C", str(prepared / "node")], check=True)
        for path in prepared.rglob("*"):
            if path.is_symlink() and not path.resolve().is_relative_to(prepared):
                raise RuntimeError(f"External symlink in portable archive: {path}")
        partial = archive.with_suffix(archive.suffix + ".partial")
        subprocess.run(["tar", "-czf", str(partial), "-C", str(prepared), "."], check=True, timeout=120)
        os.replace(partial, archive)
    metadata = {"bundleFingerprint": identity["bundleFingerprint"], "arch": args.arch,
                "sha256": digest(archive), "nodeSha256": expected, "bytes": archive.stat().st_size}
    archive.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(archive, json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
