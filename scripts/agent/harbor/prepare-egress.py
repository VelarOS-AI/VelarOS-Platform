"""Prepare an explicit local Harbor network helper from verified official assets."""

import argparse
import datetime
import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

import certifi
import yaml
from harbor.environments.docker import EGRESS_CONTROL_SIDECAR_CONTEXT_PATH
from harbor.utils.container_cache import docker_build_context_hash

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / ".velaros-workspace/bench"
DIRECTORY = BENCH / "egress/harbor-gost-3.2.6-v2"
HTTP_RESPONSE_HEADER_TIMEOUT_SECONDS = 900
BASE_ID = "sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3"
BASE_TAG = "scriptact-bench-egress-base:" + BASE_ID.split(":")[1][:16]
RELEASES = {
    "3.3.0": ("d03699e3f385d4ff5dad68046712adfcc7515325a064d2ab046e0bece30f8f8f",
              "4820090db3500abaf9b9b8739f44607477673b53df2be9b3862d75fe2e92d1d1"),
    "3.2.6": ("f674c8f4a033dc1dfd4f0d5e9602fbe5b0d0f81307bf3794f44b5b5d6d622eae",
              "2eac27b3ed6c146576bdfb125452682c7eb3c89de65ebdb026af99691228b043"),
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def response_header_timeout(config):
    """Keep the network policy intact while bounding the HTTP response-header wait."""
    if not isinstance(config, dict) or not isinstance(config.get("services"), list):
        raise ValueError("Expected the official GOST services configuration")
    changed = 0
    for service in config["services"]:
        handler = service.get("handler") if isinstance(service, dict) else None
        if not isinstance(handler, dict) or handler.get("type") != "red":
            continue
        metadata = handler.setdefault("metadata", {})
        if not isinstance(metadata, dict):
            raise ValueError("Redirect handler metadata must be an object")
        metadata["readTimeout"] = str(HTTP_RESPONSE_HEADER_TIMEOUT_SECONDS) + "s"
        changed += 1
    if not changed:
        raise ValueError("Expected a redirect handler in the official GOST configuration")
    return config


def prepare(directory, assets, version="3.2.6"):
    if importlib.metadata.version("harbor") != "0.23.0":
        raise RuntimeError("This helper is frozen against Harbor 0.23.0")
    archive_name = f"gost_{version}_linux_arm64.tar.gz"
    archive_sha, checksums_sha = RELEASES[version]
    variant = "gost-stable-v1" if version == "3.3.0" else f"gost-{version}-v2"
    if digest(assets / archive_name) != archive_sha or digest(assets / "checksums.txt") != checksums_sha:
        raise ValueError("GOST release asset differs from the official GitHub digest")
    checksums = (assets / "checksums.txt").read_text().splitlines()
    if not any(line.split() == [archive_sha, archive_name] for line in checksums):
        raise ValueError("GOST release checksum does not match the archive")
    if directory.exists():
        raise ValueError("Preparation requires a new directory; use build to reuse verified contents")
    context = directory / "context"
    context.mkdir(parents=True)
    copied = {}
    for name in ("gost.yaml", "allowlist.txt", "entrypoint.sh", "bin/network-policy"):
        source = EGRESS_CONTROL_SIDECAR_CONTEXT_PATH / name
        destination = context / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        copied[name] = digest(source)
    config_delta = None
    if version == "3.2.6":
        config_path = context / "gost.yaml"
        config_path.write_text(yaml.safe_dump(response_header_timeout(yaml.safe_load(config_path.read_text())), sort_keys=False))
        config_delta = {"kind": "redirect_http_response_header_timeout", "seconds": HTTP_RESPONSE_HEADER_TIMEOUT_SECONDS,
                        "original_harbor_config_sha256": copied["gost.yaml"], "prepared_config_sha256": digest(config_path)}
    with tarfile.open(assets / archive_name) as archive:
        members = [member for member in archive.getmembers() if member.name == "gost" and member.isfile()]
        if len(members) != 1:
            raise ValueError("Expected exactly one regular gost binary in the official archive")
        with archive.extractfile(members[0]) as source, (context / "gost").open("xb") as target:
            shutil.copyfileobj(source, target)
    shutil.copyfile(certifi.where(), context / "package-ca.pem")
    (context / "Dockerfile").write_text(f"""FROM {BASE_TAG}
COPY package-ca.pem /tmp/harbor-package-ca.pem
RUN sed -i 's#http://ports.ubuntu.com/ubuntu-ports#https://mirrors.aliyun.com/ubuntu-ports#g; s#https://ports.ubuntu.com/ubuntu-ports#https://mirrors.aliyun.com/ubuntu-ports#g' /etc/apt/sources.list.d/ubuntu.sources \\
 && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=20 -o Acquire::https::CaInfo=/tmp/harbor-package-ca.pem update \\
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=20 -o Acquire::https::CaInfo=/tmp/harbor-package-ca.pem install -y --no-install-recommends ca-certificates nftables iproute2 \\
 && mkdir -p /opt/egress-sidecar \\
 && dpkg-query -W > /opt/egress-sidecar/packages.txt \\
 && rm -rf /var/lib/apt/lists/*
COPY gost /bin/gost
COPY gost.yaml allowlist.txt /opt/egress-sidecar/
COPY entrypoint.sh /opt/egress-sidecar/entrypoint.sh
COPY bin/network-policy /usr/local/bin/network-policy
RUN chmod 755 /bin/gost /opt/egress-sidecar/entrypoint.sh /usr/local/bin/network-policy
""")
    files = {str(path.relative_to(context)): digest(path) for path in sorted(context.rglob("*")) if path.is_file()}
    context_hash = docker_build_context_hash(context=context, dockerfile_path=context / "Dockerfile", build_args={}, platform="linux/arm64")
    evidence = {"prepared_at": timestamp(), "protocol": "local-harbor-" + variant, "harbor_version": "0.23.0",
        "gost_version": version, "gost_source": "https://github.com/go-gost/gost/releases/tag/v" + version,
        "gost_archive_sha256": archive_sha, "gost_checksums_sha256": checksums_sha,
        "base_id": BASE_ID, "base_tag": BASE_TAG, "platform": "linux/arm64",
        "harbor_files_sha256": copied, "files_sha256": files, "context_hash": context_hash,
        "config_delta": config_delta,
        "image_name": "scriptact-bench:egress-" + variant + "--" + context_hash,
        "scope": ("Explicit local infrastructure variant. The redirect HTTP response-header deadline is 900 seconds, "
                  "aligned with the gateway upstream deadline; allowlist, sniffing and task images retain their official semantics. "
                  "Actual network probes and fresh-container patch replay are required before paid repository trials."
                  if config_delta else "Explicit local infrastructure variant; agent task images and Harbor network policy are unchanged. Actual network probes and fresh-container patch replay are required before paid repository trials.")}
    (directory / "preparation.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return evidence


def build(directory):
    evidence = json.loads((directory / "preparation.json").read_text())
    context = directory / "context"
    files = {str(path.relative_to(context)): digest(path) for path in sorted(context.rglob("*")) if path.is_file()}
    if files != evidence["files_sha256"]:
        raise ValueError("Prepared context changed")
    if (directory / "build.json").exists():
        raise ValueError("Build evidence already exists; preserve the frozen image")
    env = {**os.environ, "DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(BENCH / "docker-config"), "DOCKER_BUILDKIT": "0"}
    def docker(*args, **kwargs):
        return subprocess.run(["docker", *args], env=env, check=True, text=True, **kwargs)
    if docker("ps", "--quiet", capture_output=True).stdout.strip():
        raise RuntimeError("Build only between trials when this dedicated VM has no running containers")
    base = json.loads(docker("image", "inspect", BASE_ID, capture_output=True).stdout)[0]
    if base["Id"] != BASE_ID or (base["Os"], base["Architecture"]) != ("linux", "arm64"):
        raise ValueError("Cached Ubuntu base identity/platform changed")
    docker("tag", BASE_ID, BASE_TAG)
    with (directory / "build.log").open("x") as log:
        docker("build", "--pull=false", "--platform=linux/arm64", "--tag", evidence["image_name"], str(context), stdout=log, stderr=subprocess.STDOUT, timeout=600)
    built = json.loads(docker("image", "inspect", evidence["image_name"], capture_output=True).stdout)[0]
    packages = docker("run", "--rm", "--pull=never", evidence["image_name"], "cat", "/opt/egress-sidecar/packages.txt", capture_output=True).stdout
    version = docker("run", "--rm", "--pull=never", evidence["image_name"], "/bin/gost", "-V", capture_output=True).stdout.strip()
    result = {"built_at": timestamp(), "image_name": evidence["image_name"], "image_id": built["Id"], "size": built["Size"],
        "platform": built["Os"] + "/" + built["Architecture"], "gost_version_output": version, "packages": packages,
        "preparation_sha256": digest(directory / "preparation.json"), "network_probe": "pending"}
    with (directory / "build.json").open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    return {key: value for key, value in result.items() if key != "packages"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("prepare", "build"))
    parser.add_argument("--directory", type=Path, default=DIRECTORY)
    parser.add_argument("--assets", type=Path, default=BENCH / "egress/gost-3.2.6-arm64")
    parser.add_argument("--gost-version", choices=tuple(RELEASES), default="3.2.6")
    args = parser.parse_args()
    result = prepare(args.directory.resolve(), args.assets.resolve(), args.gost_version) if args.mode == "prepare" else build(args.directory.resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
