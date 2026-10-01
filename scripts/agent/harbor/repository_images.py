"""Import one frozen GHCR task image without rewriting its registry manifest."""

import argparse
import datetime
import gzip
import hashlib
import io
import json
import math
import re
import shutil
import subprocess
import tarfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests

from worker_admission import maintenance_session
from resource_leases import ResourceLeases
from repository_launch import BENCH, environment, guard_idle


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


class ImageTransferError(RuntimeError):
    """A sanitized, structured transport outcome; callers never inspect raw stderr."""

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


def transfer(url, headers, partial, *, timeout=90, wall_timeout=None):
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
            text=True, capture_output=True,
            timeout=min(timeout + 5, wall_timeout) if wall_timeout is not None else timeout + 5)
    except subprocess.TimeoutExpired:
        # subprocess.run kills and reaps its child before raising; never expose stderr/URLs.
        raise ImageTransferError("Image transfer exceeded wall-clock deadline", "WALL_TIMEOUT") from None
    if result.returncode:
        raise ImageTransferError("Image transfer failed with curl exit " + str(result.returncode),
            "CURL_" + str(result.returncode))


def download(repository, headers, cache, identity, log, kind="blobs", *, total_timeout=1800, max_no_progress=4):
    """Resume healthy prefixes within a per-blob monotonic deadline, including backoff."""
    if not math.isfinite(total_timeout) or total_timeout <= 0:
        raise ValueError("Image download deadline must be finite and positive")
    if type(max_no_progress) is not int or max_no_progress < 1:
        raise ValueError("Image no-progress limit must be a positive integer")
    started = time.monotonic()
    deadline = started + total_timeout
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
    attempt, no_progress = 0, 0
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            log({"digest": identity, "attempt": attempt, "status": "deadline-exceeded",
                "partial_bytes": partial.stat().st_size if partial.exists() else 0,
                "elapsed_seconds": time.monotonic() - started})
            raise RuntimeError("Image blob download exceeded total deadline: " + identity)
        return value
    while True:
        available = remaining()
        before = partial.stat().st_size if partial.exists() else 0
        attempt += 1
        error = None
        try:
            outgoing = {**headers, "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"}
            transfer("https://ghcr.io/v2/" + repository + "/" + kind + "/" + identity,
                     outgoing, partial, timeout=min(90, available), wall_timeout=available)
        except RuntimeError as failure:
            error = failure
        after = partial.stat().st_size if partial.exists() else 0
        actual = digest(partial) if partial.exists() else None
        # A deadline can arrive after the final body byte. Only the complete SHA
        # permits publication, and a spent overall deadline still keeps evidence.
        if actual == identity:
            remaining()
            partial.rename(path)
            log({"digest": identity, "attempt": attempt, "bytes": after,
                "status": "verified-after-transfer-error" if error else "verified",
                **({"error_type": type(error).__name__} if error else {}),
                "elapsed_seconds": time.monotonic() - started})
            return path
        if error is None:
            # Completed corrupt content must not be resumed at EOF on a new run.
            quarantine = None
            if actual is not None:
                quarantine = path.with_name(path.name + ".corrupt-" + actual.split(":", 1)[1]
                    + "-" + str(time.time_ns()))
                partial.rename(quarantine)
            log({"digest": identity, "attempt": attempt, "status": "checksum-mismatch",
                "actual_digest": actual, "bytes": after,
                "quarantine": str(quarantine) if quarantine else None})
            raise ValueError("Downloaded image blob identity mismatch")
        remaining()
        progress = (isinstance(error, ImageTransferError)
            and error.code in ("CURL_18", "CURL_28", "WALL_TIMEOUT") and after > before)
        no_progress = 0 if progress else no_progress + 1
        log({"digest": identity, "attempt": attempt, "error_type": type(error).__name__,
            "error_code": error.code if isinstance(error, ImageTransferError) else "TRANSFER_ERROR",
            "status": "progress" if progress else "retry",
            "partial_bytes": after, "gained_bytes": after - before,
            "no_progress_failures": no_progress,
            "elapsed_seconds": time.monotonic() - started})
        if no_progress >= max_no_progress:
            raise RuntimeError("Image blob download exhausted retries without healthy progress: " + identity) from None
        if not progress:
            time.sleep(min(2 ** no_progress, 8, remaining()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--task", required=True)
    parser.add_argument("--name", required=True, help="Unique evidence directory name")
    parser.add_argument("--gateway-directory", required=True, type=Path)
    parser.add_argument("--gateway-url", required=True, help="Local HTTP gateway origin used for both idle checks")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.name):
        parser.error("Evidence name must contain lowercase letters, digits and hyphens")
    origin = urlsplit(args.gateway_url)
    if origin.username is not None or origin.password is not None or origin.query or origin.fragment:
        raise ValueError("Gateway origin must not contain credentials, query or fragment")
    manifest_bytes = args.manifest.read_bytes()
    expected = json.loads(manifest_bytes)["tasks"][args.task]["image"]
    match = re.fullmatch(r"ghcr.io/([a-z0-9_./-]+):[A-Za-z0-9_.-]+", expected["name"])
    if not match or expected["id"] != expected["manifest_digest"]:
        raise ValueError("Expected a frozen GHCR manifest identity")
    repository = match.group(1)
    # The scoped gateway token is used only for the read-only idle check.
    health_env = environment(args.gateway_directory, args.gateway_url)
    env = {key: value for key, value in health_env.items()
        if key in ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "DOCKER_HOST", "DOCKER_CONFIG")}
    frozen = json.loads(manifest_bytes)
    resource_directory = BENCH / "campaign/resource-leases"
    capacity = frozen.get("resource_pool")
    if capacity is None:
        # Preparation manifests may predate attempted participants, but must use
        # the already configured dedicated worker; never invent another pool.
        capacity = json.loads((resource_directory / "resources.json").read_text())["capacity"]
    leases = ResourceLeases(resource_directory, capacity)
    socket = Path(env["DOCKER_HOST"].removeprefix("unix://"))
    profile = socket.parent.name
    if frozen.get("vm", {}).get("profile", profile) != profile:
        raise ValueError("Image worker differs from the frozen profile")
    with maintenance_session(leases, owner=str((BENCH / "image-imports" / args.name).resolve()),
            manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
            worker={"profile": profile, "socket": str(socket)}) as maintenance:
        guard_idle(health_env)
        out = BENCH / "image-imports" / args.name
        out.mkdir(parents=True, exist_ok=False)
        cache = BENCH / "registry-blobs"
        cache.mkdir(exist_ok=True)
        evidence = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "task": args.task, "image": expected, "manifest_file": str(args.manifest.resolve()),
            "gateway_directory": str(args.gateway_directory.resolve()),
            "gateway_health_url": health_env["SCRIPTACT_GATEWAY_HEALTH_URL"],
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "script_sha256": digest(__file__),
            "transport": "GHCR HTTPS with default certificate verification; original OCI manifest and blobs",
            "status": "preparing"}
        importing = False
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
            importing = True
            with (out / "load.log").open("x") as stream:
                subprocess.run(["docker", "load", "--input", str(archive)], env=env, stdout=stream,
                               stderr=subprocess.STDOUT, check=True, timeout=600)
            importing = False
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
            if importing:
                maintenance.block("image_import_settlement_unknown")
            evidence["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            (out / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence), flush=True)

if __name__ == "__main__":
    main()
