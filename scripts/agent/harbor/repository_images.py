"""Import one frozen GHCR task image without rewriting its registry manifest."""

import argparse
import datetime
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import time
from pathlib import Path

import requests

from repository_launch import BENCH, guard_idle


def digest(path):
    with Path(path).open("rb") as stream:
        return "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()


def blob_path(cache, identity):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
        raise ValueError("Unsupported image content digest")
    return cache / identity.split(":", 1)[1]


def received_range_bytes(*, status, returncode, content_range, start, end, total, received):
    """Accept a contiguous HTTP range prefix; only the final digest publishes a blob."""
    if not 0 <= start <= end < total or not 0 < received <= end - start + 1:
        return 0
    if status != 206 or content_range != f"bytes {start}-{end}/{total}":
        return 0
    # curl 18 and 28 preserve the received body on early EOF or deadline. All
    # other failures (including TLS and write errors) remain unusable.
    if returncode not in (0, 18, 28) or (returncode == 0 and received != end - start + 1):
        return 0
    return received


def validate_blob(cache, descriptor):
    path = blob_path(cache, descriptor["digest"])
    if digest(path) != descriptor["digest"] or path.stat().st_size != descriptor["size"]:
        raise ValueError("Image blob identity or size mismatch")
    return path


def verify_image(cache, expected):
    manifest_path = blob_path(cache, expected["manifest_digest"])
    if digest(manifest_path) != expected["manifest_digest"]:
        raise ValueError("Image manifest identity mismatch")
    manifest = json.loads(manifest_path.read_bytes())
    if manifest["config"]["digest"] != expected["config_digest"]:
        raise ValueError("Image config differs from frozen manifest")
    config = json.loads(validate_blob(cache, manifest["config"]).read_bytes())
    if config["architecture"] != "amd64" or config["os"] != "linux":
        raise ValueError("Image must be the frozen Linux AMD64 platform")
    layers, diff_ids = manifest["layers"], config["rootfs"]["diff_ids"]
    if len(layers) != len(diff_ids):
        raise ValueError("Image layer count mismatch")
    for layer, expected_diff in zip(layers, diff_ids):
        path = validate_blob(cache, layer)
        media = layer["mediaType"]
        if media.endswith("gzip"):
            opener = gzip.open
        elif media.endswith(".tar"):
            opener = open
        else:
            raise ValueError("Unsupported image layer encoding")
        with opener(path, "rb") as stream:
            actual = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected_diff:
            raise ValueError("Uncompressed image layer identity mismatch")
    return manifest, config


def write_oci_archive(cache, expected, archive):
    """Keep original compressed blobs and manifest so Docker's image ID is stable."""
    manifest, config = verify_image(cache, expected)
    manifest_path = blob_path(cache, expected["manifest_digest"])
    descriptor = {"mediaType": manifest["mediaType"], "digest": expected["manifest_digest"],
        "size": manifest_path.stat().st_size,
        "annotations": {"io.containerd.image.name": expected["name"],
            "org.opencontainers.image.ref.name": expected["name"]},
        "platform": {"architecture": config["architecture"], "os": config["os"]}}
    descriptors = [descriptor, manifest["config"], *manifest["layers"]]
    with tarfile.open(archive, "x") as output:
        for name, value in (("oci-layout", {"imageLayoutVersion": "1.0.0"}),
                            ("index.json", {"schemaVersion": 2, "manifests": [descriptor]})):
            content = json.dumps(value).encode()
            info = tarfile.TarInfo(name)
            info.size = len(content)
            output.addfile(info, io.BytesIO(content))
        for identity in dict.fromkeys(item["digest"] for item in descriptors):
            output.add(blob_path(cache, identity), arcname="blobs/sha256/" + identity.split(":", 1)[1])
    return manifest, config


def transfer(url, headers, partial, *, timeout=90):
    """Bound the entire transfer, including trickling bodies; keep auth out of argv/logs."""
    def quote(value):
        if any(ord(char) < 32 for char in value):
            raise ValueError("Invalid download configuration character")
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    config = "\n".join([
        "url = " + quote(url), "output = " + quote(str(partial)),
        *["header = " + quote(key + ": " + value) for key, value in headers.items()],
        "continue-at = -", "location", "fail", "silent", "show-error",
        'proto-redir = "=https"', "connect-timeout = " + str(min(25, timeout)),
        "max-time = " + str(timeout),
    ])
    try:
        result = subprocess.run(["curl", "-q", "--config", "-"], input=config,
            text=True, capture_output=True, timeout=timeout + 5)
    except subprocess.TimeoutExpired:
        # subprocess.run kills and reaps its child before raising; never expose stderr/URLs.
        raise RuntimeError("Image transfer exceeded wall-clock deadline") from None
    if result.returncode:
        raise RuntimeError("Image transfer failed with curl exit " + str(result.returncode))


def download(repository, headers, cache, identity, log, kind="blobs"):
    path = blob_path(cache, identity)
    if path.exists():
        if digest(path) != identity:
            raise ValueError("Existing content-addressed cache entry is corrupt")
        return path
    partial = path.with_suffix(".partial")
    if partial.exists() and digest(partial) == identity:
        partial.rename(path)
        log({"digest": identity, "bytes": path.stat().st_size, "status": "recovered-verified-partial"})
        return path
    for attempt in range(1, 5):
        try:
            outgoing = {**headers, "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"}
            transfer("https://ghcr.io/v2/" + repository + "/" + kind + "/" + identity,
                     outgoing, partial)
            if digest(partial) != identity:
                partial.unlink()
                raise ValueError("Downloaded image blob identity mismatch")
            partial.rename(path)
            log({"digest": identity, "attempt": attempt, "bytes": path.stat().st_size, "status": "verified"})
            return path
        except (RuntimeError, ValueError) as error:
            # A deadline can arrive after the last body byte. Trust complete identity,
            # rather than retrying an already complete range and receiving HTTP 416.
            if partial.exists() and digest(partial) == identity:
                partial.rename(path)
                log({"digest": identity, "attempt": attempt, "bytes": path.stat().st_size,
                     "status": "verified-after-transfer-error", "error_type": type(error).__name__})
                return path
            log({"digest": identity, "attempt": attempt, "error_type": type(error).__name__,
                "partial_bytes": partial.stat().st_size if partial.exists() else 0})
            if attempt == 4:
                raise RuntimeError("Image blob download exhausted retries: " + identity) from None
            time.sleep(min(2 ** attempt, 8))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--task", required=True)
    parser.add_argument("--name", required=True, help="Unique evidence directory name")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.name):
        parser.error("Evidence name must contain lowercase letters, digits and hyphens")
    manifest_bytes = args.manifest.read_bytes()
    expected = json.loads(manifest_bytes)["tasks"][args.task]["image"]
    match = re.fullmatch(r"ghcr.io/([a-z0-9_./-]+):[A-Za-z0-9_.-]+", expected["name"])
    if not match or expected["id"] != expected["manifest_digest"]:
        raise ValueError("Expected a frozen GHCR manifest identity")
    repository = match.group(1)
    env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "USER", "LANG", "TMPDIR")}
    env.update({"DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(BENCH / "docker-config")})
    # The scoped gateway token is used only for the read-only idle check.
    health_env = {**env, "OPENAI_API_KEY": (BENCH / "campaign/gateway-token").read_text().strip()}
    guard_idle(health_env)
    out = BENCH / "image-imports" / args.name
    out.mkdir(parents=True, exist_ok=False)
    cache = BENCH / "registry-blobs"
    cache.mkdir(exist_ok=True)
    evidence = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "task": args.task, "image": expected, "manifest_file": str(args.manifest.resolve()),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "script_sha256": digest(__file__),
        "transport": "GHCR HTTPS with default certificate verification; original OCI manifest and blobs",
        "status": "preparing"}
    def log(value):
        with (out / "download.jsonl").open("a") as stream:
            stream.write(json.dumps(value) + "\n")
        print(json.dumps(value), flush=True)
    try:
        vm_disk = subprocess.check_output(["colima", "-p", "scriptact-bench", "ssh", "--",
            "df", "-Pk", "/var/lib/docker"], env=env, text=True, timeout=30)
        evidence["vm_disk_available_bytes"] = int(vm_disk.strip().splitlines()[-1].split()[3]) * 1024
        if evidence["vm_disk_available_bytes"] < 4 * 1024 ** 3:
            raise RuntimeError("Insufficient dedicated VM disk headroom")
        with requests.Session() as session:
            response = session.get("https://ghcr.io/token", params={"service": "ghcr.io", "scope": "repository:" + repository + ":pull"}, timeout=(20, 60))
            response.raise_for_status()
            headers = {"Authorization": "Bearer " + response.json()["token"]}
            raw_manifest = download(repository, headers, cache, expected["manifest_digest"], log, "manifests")
            image_manifest = json.loads(raw_manifest.read_bytes())
            if image_manifest["config"]["digest"] != expected["config_digest"]:
                raise ValueError("Registry config differs from frozen config")
            blobs = [image_manifest["config"], *image_manifest["layers"]]
            required = sum(item["size"] for item in blobs)
            # Cover downloaded blobs, the derived archive and 2 GiB headroom.
            if shutil.disk_usage(out).free < 2 * required + 2 * 1024 ** 3:
                raise RuntimeError("Insufficient host disk space for verified OCI import")
            for item in blobs:
                download(repository, headers, cache, item["digest"], log)
                validate_blob(cache, item)
        archive = out / "image.oci.tar"
        image_manifest, config = write_oci_archive(cache, expected, archive)
        evidence.update({"archive_sha256": digest(archive), "archive_bytes": archive.stat().st_size,
            "compressed_layer_bytes": sum(item["size"] for item in image_manifest["layers"]),
            "layers_verified": len(image_manifest["layers"]), "uncompressed_diff_ids_verified": len(config["rootfs"]["diff_ids"])})
        guard_idle(health_env)
        with (out / "load.log").open("x") as stream:
            subprocess.run(["docker", "load", "--input", str(archive)], env=env, stdout=stream,
                           stderr=subprocess.STDOUT, check=True, timeout=600)
        loaded = json.loads(subprocess.check_output(["docker", "image", "inspect", expected["name"]], env=env, text=True))[0]
        if loaded["Id"] != expected["id"] or loaded["Architecture"] != "amd64" or loaded["Os"] != "linux":
            raise ValueError("Imported image identity or platform differs")
        if loaded["RootFS"]["Layers"] != config["rootfs"]["diff_ids"]:
            raise ValueError("Imported image root filesystem differs")
        evidence.update({"status": "ready", "image_id": loaded["Id"], "image_size_bytes": loaded["Size"]})
        archive.unlink()
    except Exception as error:
        evidence.update({"status": "failed", "error_type": type(error).__name__})
        raise RuntimeError("Repository image preparation failed; evidence: " + str(out)) from None
    finally:
        evidence["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence), flush=True)


if __name__ == "__main__":
    main()
