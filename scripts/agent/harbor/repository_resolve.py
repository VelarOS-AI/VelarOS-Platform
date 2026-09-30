"""Resolve public GHCR images to verified Linux AMD64 manifests without model calls."""

import argparse
import datetime
import hashlib
import json
import re
import time
from pathlib import Path

import requests

INDEX_TYPES = ("application/vnd.oci.image.index.v1+json",
               "application/vnd.docker.distribution.manifest.list.v2+json")
MANIFEST_TYPES = ("application/vnd.oci.image.manifest.v1+json",
                  "application/vnd.docker.distribution.manifest.v2+json")
ACCEPT = ", ".join((*INDEX_TYPES, *MANIFEST_TYPES))
MAX_METADATA_BYTES = 2 * 1024 * 1024


class RegistryError(RuntimeError):
    def __init__(self, status, codes):
        super().__init__("Registry metadata request failed")
        self.status = status
        self.codes = codes


def image_reference(name):
    match = re.fullmatch(r"ghcr\.io/([a-z0-9_./-]+):([A-Za-z0-9_.-]+)", name)
    if not match or any(part in ("", ".", "..") for part in match[1].split("/")):
        raise ValueError("Expected a public GHCR repository and fixed tag")
    return match.groups()


def descriptor(value):
    identity, size = value.get("digest"), value.get("size")
    if not isinstance(identity, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", identity):
        raise ValueError("Unsupported metadata content digest")
    if type(size) is not int or size < 0:
        raise ValueError("Invalid descriptor size")
    return identity, size


def metadata(session, url, headers, *, expected=None, cache=None):
    started = time.monotonic()
    with session.get(url, headers=headers, timeout=(10, 20), stream=True) as response:
        raw = bytearray()
        for chunk in response.iter_content(16384):
            raw.extend(chunk)
            if len(raw) > MAX_METADATA_BYTES or time.monotonic() - started > 30:
                raise ValueError("Registry metadata exceeds the size or time bound")
        if response.status_code != 200:
            try:
                codes = [row.get("code") for row in json.loads(raw).get("errors", [])]
            except (ValueError, AttributeError, TypeError):
                codes = []
            raise RegistryError(response.status_code, codes)
        identity = "sha256:" + hashlib.sha256(raw).hexdigest()
        advertised = response.headers.get("Docker-Content-Digest")
        if advertised is not None and advertised != identity:
            raise ValueError("Registry content digest mismatch")
        if expected is not None and (identity, len(raw)) != descriptor(expected):
            raise ValueError("Metadata descriptor digest or size mismatch")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Registry metadata must be an object")
        if cache is not None:
            cache.mkdir(parents=True, exist_ok=True)
            path = cache / identity.split(":")[1]
            if path.exists():
                if path.read_bytes() != raw:
                    raise ValueError("Existing metadata cache entry is corrupt")
            else:
                with path.open("xb") as stream:
                    stream.write(raw)
        return value, identity


def resolve_image(session, name, authorization, cache):
    repository, tag = image_reference(name)
    base = "https://ghcr.io/v2/" + repository
    headers = {"Authorization": authorization, "Accept": ACCEPT}
    manifest, identity = metadata(session, base + "/manifests/" + tag, headers, cache=cache)
    root_identity = identity
    indexes = []
    while manifest.get("mediaType") in INDEX_TYPES:
        if len(indexes) >= 4:
            raise ValueError("Registry index nesting exceeds the supported bound")
        indexes.append(identity)
        candidates = [item for item in manifest.get("manifests", [])
                      if item.get("platform", {}).get("os") == "linux"
                      and item.get("platform", {}).get("architecture") == "amd64"]
        if len(candidates) != 1:
            raise ValueError("Registry index must select exactly one Linux AMD64 manifest")
        selected = candidates[0]
        child_identity, _ = descriptor(selected)
        manifest, identity = metadata(session, base + "/manifests/" + child_identity,
                                      headers, expected=selected, cache=cache)
        if manifest.get("mediaType") != selected.get("mediaType"):
            raise ValueError("Selected descriptor media type mismatch")
    if manifest.get("schemaVersion") != 2 or manifest.get("mediaType") not in MANIFEST_TYPES:
        raise ValueError("Expected an OCI or Docker image manifest")
    config_descriptor = manifest["config"]
    config_identity, _ = descriptor(config_descriptor)
    layers = manifest["layers"]
    if not isinstance(layers, list):
        raise ValueError("Manifest layers must be a list")
    for layer in layers:
        descriptor(layer)
    config, _ = metadata(session, base + "/blobs/" + config_identity, headers,
                         expected=config_descriptor, cache=cache)
    if config.get("os") != "linux" or config.get("architecture") != "amd64":
        raise ValueError("Resolved image config must be Linux AMD64")
    rootfs = config.get("rootfs", {})
    if rootfs.get("type") != "layers" or len(rootfs.get("diff_ids", [])) != len(layers):
        raise ValueError("Image config and layer count differ")
    return {"status": "resolved", "image": name,
            "identity": {"name": name, "id": identity, "manifest_digest": identity,
                         "config_digest": config_identity},
            "root_manifest_digest": root_identity, "index_chain": indexes,
            "platform": {"os": "linux", "architecture": "amd64"},
            "layers": len(layers), "compressed_bytes": sum(item["size"] for item in layers)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", action="append", required=True)
    parser.add_argument("--cache", type=Path, required=True, help="Metadata-only content-addressed cache")
    parser.add_argument("--output", type=Path, required=True, help="New evidence file; never overwritten")
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Keep original resolution evidence")
    for name in args.image:
        image_reference(name)
    session, tokens, rows = requests.Session(), {}, []
    for name in args.image:
        repository, _ = image_reference(name)
        try:
            if repository not in tokens:
                token, _ = metadata(session, "https://ghcr.io/token?service=ghcr.io&scope=repository:"
                                    + repository + ":pull", {})
                tokens[repository] = "Bearer " + token["token"]
            row = resolve_image(session, name, tokens[repository], args.cache)
        except RegistryError as error:
            row = {"image": name, "status": "registry-error", "http_status": error.status,
                   "registry_error_codes": error.codes}
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            row = {"image": name, "status": "resolution-error", "error_type": type(error).__name__}
        rows.append(row)
        print(json.dumps({"image": name, "status": row["status"]}), flush=True)
    record = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "accept": ACCEPT, "scope": "Public registry metadata only; no image layers or model calls.",
              "rows": rows}
    with args.output.open("x") as stream:
        stream.write(json.dumps(record, indent=2) + "\n")
    return 0 if all(row["status"] == "resolved" for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
