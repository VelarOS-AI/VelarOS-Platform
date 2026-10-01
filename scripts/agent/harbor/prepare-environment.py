"""Freeze the official Terminal-Bench verifier bootstrap before paid runs."""

import argparse
import hashlib
import os
import shutil
import urllib.request
from pathlib import Path

from runtime_artifacts import UV_ARTIFACTS, UV_VERSION


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uv-archive", type=Path)
    parser.add_argument("--libc", choices=["glibc", "musl"], default="glibc")
    args = parser.parse_args()
    UV_ARCHIVE, UV_SHA256, target = UV_ARTIFACTS[args.libc]
    UV_ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    if UV_ARCHIVE.exists():
        if digest(UV_ARCHIVE) != UV_SHA256:
            raise ValueError("Existing bootstrap archive failed official checksum verification")
    else:
        temporary = UV_ARCHIVE.with_suffix(".partial")
        if args.uv_archive:
            shutil.copyfile(args.uv_archive, temporary)
        else:
            url = f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-x86_64-unknown-linux-{target}.tar.gz"
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as target:
                shutil.copyfileobj(response, target)
        if digest(temporary) != UV_SHA256:
            raise ValueError("Downloaded bootstrap differs from the official release checksum")
        os.replace(temporary, UV_ARCHIVE)
    print(UV_ARCHIVE, UV_SHA256)


if __name__ == "__main__":
    main()
