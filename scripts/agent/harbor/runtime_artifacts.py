"""Select frozen runtimes by the task's actual architecture and libc, before API use."""

import base64
import binascii
import hashlib
import os
import shutil
import struct
import urllib.request
from pathlib import Path

NODE_VERSION = "24.15.0"
UV_VERSION = "0.7.13"
DOWNLOADS = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench/runtime-downloads"
UV_ARTIFACTS = {
    "glibc": (DOWNLOADS / "uv-0.7.13-linux-x64.tar.gz", "909278eb197c5ed0e9b5f16317d1255270d1f9ea4196e7179ce934d48c4c2545", "gnu"),
    "musl": (DOWNLOADS / "uv-0.7.13-linux-x64-musl.tar.gz", "560bb64e060354e45138d7dd47c8dd48a4f7a349af5520d29cd3c704e79f286c", "musl"),
}
SHELL_PREFIX_BYTES = 65536
ELF_RUNTIME_INTERPRETERS = {
    "x64": {
        "machine": 62,
        "musl": ("/lib/ld-musl-x86_64.so.1",),
        "glibc": ("/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "/lib/ld-linux-x86-64.so.2"),
    },
    "arm64": {
        "machine": 183,
        "musl": ("/lib/ld-musl-aarch64.so.1",),
        "glibc": ("/lib/ld-linux-aarch64.so.1", "/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1", "/lib64/ld-linux-aarch64.so.1"),
    },
}
RUNTIME_PROFILE = rf"""set -eu
uname -m
printf 'shell-elf-base64\n'
dd if=/bin/sh bs={SHELL_PREFIX_BYTES} count=1 2>/dev/null | base64
"""


def elf_interpreter(data, arch):
    """Identify a dynamic shell's ABI from a complete, bounded ELF header/table.

    Callers may supply only a prefix; every byte read must be present in that
    prefix. Static, malformed, unsupported or ambiguous shells fail closed.
    Loader-file presence cannot override the executable's actual interpreter.
    """
    def invalid():
        raise ValueError("Unsupported task shell: a verified ELF64 interpreter is required")

    if arch not in ELF_RUNTIME_INTERPRETERS or not isinstance(data, bytes) or len(data) < 64:
        invalid()
    if data[:7] != b"\x7fELF\x02\x01\x01":
        invalid()
    header = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)
    kind, machine, version = header[:3]
    phoff, ehsize, phentsize, phnum = header[4], header[7], header[8], header[9]
    if kind not in (2, 3) or machine != ELF_RUNTIME_INTERPRETERS[arch]["machine"] or version != 1:
        invalid()
    if ehsize != 64 or phentsize != 56 or phoff < 64 or not 0 < phnum < 65535:
        invalid()
    if phoff + phentsize * phnum > len(data):
        invalid()
    interpreters = []
    for index in range(phnum):
        segment = struct.unpack_from("<IIQQQQQQ", data, phoff + index * phentsize)
        if segment[0] != 3:  # PT_INTERP
            continue
        offset, size = segment[2], segment[5]
        if not 2 <= size <= 4096 or offset + size > len(data):
            invalid()
        raw = data[offset:offset + size]
        if raw[-1:] != b"\0" or b"\0" in raw[:-1]:
            invalid()
        try:
            interpreter = raw[:-1].decode("ascii")
        except UnicodeDecodeError:
            invalid()
        if not interpreter.startswith("/") or ".." in interpreter.split("/"):
            invalid()
        interpreters.append(interpreter)
    if len(interpreters) != 1:
        invalid()
    interpreter = interpreters[0]
    for libc in UV_ARTIFACTS:
        if interpreter in ELF_RUNTIME_INTERPRETERS[arch][libc]:
            return {"arch": arch, "libc": libc, "interpreter": interpreter}
    invalid()


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


async def runtime_profile(environment):
    result = await environment.exec(command=RUNTIME_PROFILE, timeout_sec=30)
    output = result.stdout or ""
    lines = output.strip().splitlines()
    if result.return_code or len(output) > SHELL_PREFIX_BYTES * 2 or len(lines) < 3 or lines[0] not in ("x86_64", "aarch64") or lines[1] != "shell-elf-base64":
        raise ValueError("Unsupported task runtime: architecture/libc must be identified before installing an agent")
    try:
        data = base64.b64decode("".join(lines[2:]), validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Unsupported task runtime: invalid bounded shell evidence") from None
    if len(data) > SHELL_PREFIX_BYTES:
        raise ValueError("Unsupported task runtime: shell evidence exceeds probe bound")
    arch = {"x86_64": "x64", "aarch64": "arm64"}[lines[0]]
    profile = elf_interpreter(data, arch)
    return {"arch": arch, "libc": profile["libc"]}


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
