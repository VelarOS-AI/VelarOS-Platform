"""Prepare a portable Linux agent archive before the benchmark setup timer starts."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from bundle_integrity import verify_bundle
from runtime_artifacts import node_artifact, portable_path, verify_profile


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, default=Path(".velaros-workspace/bench/bundle"))
    parser.add_argument("--arch", choices=["x64", "arm64"], default="x64")
    parser.add_argument("--libc", choices=["glibc", "musl"], default="glibc")
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    identity = verify_bundle(bundle)
    archive = portable_path(bundle, args.arch, args.libc)
    if archive.exists():
        metadata = json.loads(archive.with_suffix(".json").read_text())
        verify_profile(metadata, {"arch": args.arch, "libc": args.libc})
        if metadata["bundleFingerprint"] != identity["bundleFingerprint"] or metadata.get("bundleSealSha256") != identity["bundleSeal"]["sha256"] or digest(archive) != metadata["sha256"]:
            raise ValueError("Existing portable artifact differs; preserve it and prepare a new versioned bundle")
        print(archive, json.dumps(metadata), flush=True)
        return
    node, runtime = node_artifact(args.arch, args.libc)
    with tempfile.TemporaryDirectory(prefix="scriptact-linux-", dir=bundle.parent) as temporary:
        prepared = Path(temporary) / "agent"
        shutil.copytree(bundle, prepared, ignore=shutil.ignore_patterns("node_modules"))
        verify_bundle(prepared)
        subprocess.run(["bun", "install", "--production", "--ignore-scripts", "--frozen-lockfile", "--os", "linux", "--cpu", args.arch], cwd=prepared, check=True, timeout=300)
        (prepared / "node").mkdir()
        subprocess.run(["tar", "-xJf", str(node), "--strip-components", "1", "-C", str(prepared / "node")], check=True)
        for path in prepared.rglob("*"):
            if path.is_symlink() and not path.resolve().is_relative_to(prepared):
                raise RuntimeError(f"External symlink in portable archive: {path}")
        partial = archive.with_suffix(archive.suffix + ".partial")
        # BSD tar otherwise adds AppleDouble sidecars for macOS metadata to Linux installations.
        archive_env = {**os.environ, "COPYFILE_DISABLE": "1"}
        subprocess.run(["tar", "-czf", str(partial), "-C", str(prepared), "."], check=True, timeout=120, env=archive_env)
        os.replace(partial, archive)
    metadata = {"bundleFingerprint": identity["bundleFingerprint"], "bundleSealSha256": identity["bundleSeal"]["sha256"], "arch": args.arch,
                "sha256": digest(archive), **runtime, "bytes": archive.stat().st_size}
    archive.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(archive, json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
