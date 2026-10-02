"""Explicit local network helper for repository trials; verify before model dispatch."""

import asyncio
import hashlib
import json
from pathlib import Path

import yaml

from harbor.utils.container_cache import docker_build_context_hash

from .cancellable_environment import CancellableBenchmarkDocker

HELPER = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench/egress/harbor-gost-3.2.6-v2"
IMAGE_NAME = "scriptact-bench:egress-gost-3.2.6-v2--8620e34c530d327a"


def helper_evidence(directory=HELPER):
    directory = Path(directory).resolve()
    preparation = directory / "preparation.json"
    built = json.loads((directory / "build.json").read_text())
    source = json.loads(preparation.read_text())
    if hashlib.sha256(preparation.read_bytes()).hexdigest() != built["preparation_sha256"]:
        raise ValueError("Local network helper preparation changed")
    context = directory / "context"
    files = {str(path.relative_to(context)): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(context.rglob("*")) if path.is_file()}
    context_hash = docker_build_context_hash(context=context, dockerfile_path=context / "Dockerfile", build_args={}, platform="linux/arm64")
    if files != source["files_sha256"] or context_hash != source["context_hash"]:
        raise ValueError("Local network helper context changed")
    variants = {"3.3.0": ("gost-stable-v1",), "3.2.6": ("gost-3.2.6-v1", "gost-3.2.6-v2")}
    protocol = source["protocol"]
    allowed = variants.get(source["gost_version"], ())
    variant = next((item for item in allowed if protocol == "local-harbor-" + item), None)
    image_name = "scriptact-bench:egress-" + str(variant) + "--" + context_hash
    if variant is None or source["protocol"] != "local-harbor-" + variant:
        raise ValueError("Unknown local network helper protocol")
    if built["image_name"] != image_name or source["image_name"] != image_name or built["platform"] != "linux/arm64":
        raise ValueError("Local network helper identity/platform changed")
    if variant == "gost-3.2.6-v2":
        config = yaml.safe_load((context / "gost.yaml").read_text())
        if not isinstance(config, dict) or not isinstance(config.get("services"), list):
            raise ValueError("Local network helper response-header configuration changed")
        handlers = [item.get("handler") for item in config["services"] if isinstance(item, dict)
                    and isinstance(item.get("handler"), dict) and item["handler"].get("type") == "red"]
        delta = source.get("config_delta")
        if (not handlers or any(not isinstance(item.get("metadata"), dict) or item["metadata"].get("readTimeout") != "900s" for item in handlers)
                or not isinstance(delta, dict) or delta.get("kind") != "redirect_http_response_header_timeout"
                or delta.get("seconds") != 900
                or delta.get("original_harbor_config_sha256") != source["harbor_files_sha256"]["gost.yaml"]
                or delta.get("prepared_config_sha256") != files["gost.yaml"]):
            raise ValueError("Local network helper response-header deadline proof changed")
    return built


class RepositoryBenchmarkDocker(CancellableBenchmarkDocker):
    _EGRESS_CONTROL_SIDECAR_CONTEXT_PATH = HELPER / "context"
    _EGRESS_CONTROL_SIDECAR_DOCKER_NAME = "scriptact-bench:egress-gost-3.2.6-v2"
    _EGRESS_CONTROL_KERNEL_PROBE_IMAGE = IMAGE_NAME

    async def _ensure_egress_control_sidecar_image_built(self):
        evidence = helper_evidence(self._EGRESS_CONTROL_SIDECAR_CONTEXT_PATH.parent)
        image_name = evidence["image_name"]
        if image_name != self._EGRESS_CONTROL_KERNEL_PROBE_IMAGE:
            raise ValueError("Environment and local network helper identities differ")
        process = await asyncio.create_subprocess_exec("docker", "image", "inspect", image_name, "--format", "{{.Id}}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _ = await process.communicate()
        if process.returncode or stdout.decode().strip() != evidence["image_id"]:
            raise RuntimeError("Frozen local network helper is missing or changed; run prepare-egress.py build between trials")
        self._env_vars.egress_control_sidecar_image_name = image_name
        self.logger.info("Campaign repository network helper image: %s", evidence["image_id"])
        self.logger.info("Campaign repository environment SHA-256: %s", hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
