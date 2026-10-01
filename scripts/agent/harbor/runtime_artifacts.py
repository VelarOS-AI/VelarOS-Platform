"""Select frozen runtimes by the task's actual architecture and libc, before API use."""

import hashlib
import os
import shutil
import urllib.request
from pathlib import Path

NODE_VERSION = "24.15.0"
UV_VERSION = "0.7.13"
DOWNLOADS = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench/runtime-downloads"
UV_ARTIFACTS = {
    "glibc": (DOWNLOADS / "uv-0.7.13-linux-x64.tar.gz", "909278eb197c5ed0e9b5f16317d1255270d1f9ea4196e7179ce934d48c4c2545", "gnu"),
    "musl": (DOWNLOADS / "uv-0.7.13-linux-x64-musl.tar.gz", "560bb64e060354e45138d7dd47c8dd48a4f7a349af5520d29cd3c704e79f286c", "musl"),
}
RUNTIME_PROFILE = r"""set -eu
uname -m
for loader in /lib/ld-musl-*.so.1; do
  if [ -f "$loader" ]; then printf 'musl\n'; exit 0; fi
done
if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then printf 'glibc\n'; else exit 2; fi
"""


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


async def runtime_profile(environment):
    result = await environment.exec(command=RUNTIME_PROFILE)
    lines = (result.stdout or "").strip().splitlines()
    if result.return_code or len(lines) != 2 or lines[0] not in ("x86_64", "aarch64") or lines[1] not in UV_ARTIFACTS:
        raise ValueError("Unsupported task runtime: architecture/libc must be identified before installing an agent")
    return {"arch": {"x86_64": "x64", "aarch64": "arm64"}[lines[0]], "libc": lines[1]}


def portable_path(bundle, arch, libc):
    if arch not in ("x64", "arm64") or libc not in UV_ARTIFACTS:
        raise ValueError("Unsupported portable runtime")
    return bundle.parent / f"{bundle.name}-linux-{arch}{'-musl' if libc == 'musl' else ''}.tar.gz"


def verify_profile(metadata, profile):
    # Historical archives have no libc field and were GNU-only.
    if metadata.get("arch") != profile["arch"] or metadata.get("libc", "glibc") != profile["libc"]:
        raise ValueError("Portable archive architecture/libc differs from the task")


def node_artifact(arch, libc):
    if arch not in ("x64", "arm64") or libc not in UV_ARTIFACTS:
        raise ValueError("Unsupported Node runtime")
    suffix = "-musl" if libc == "musl" else ""
    name = f"node-v{NODE_VERSION}-linux-{arch}{suffix}.tar.xz"
    base = ("https://unofficial-builds.nodejs.org/download/release/" if libc == "musl" else "https://nodejs.org/dist/") + f"v{NODE_VERSION}/"
    with urllib.request.urlopen(base + "SHASUMS256.txt", timeout=30) as response:
        checksums = response.read().decode().splitlines()
    expected = next(line.split()[0] for line in checksums if line.split()[-1] == name)
    path = DOWNLOADS / name
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    if path.exists() and digest(path) != expected:
        raise ValueError("Cached Node archive differs from published checksum; preserve it for diagnosis")
    if not path.exists():
        temporary = path.with_suffix(path.suffix + ".partial")
        with urllib.request.urlopen(base + name, timeout=60) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target)
        if digest(temporary) != expected:
            raise ValueError("Node archive checksum mismatch")
        os.replace(temporary, path)
    return path, {"nodeVersion": NODE_VERSION, "nodeSha256": expected, "nodeSource": base + name, "libc": libc}
