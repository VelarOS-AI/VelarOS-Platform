"""Registry indexes must not become false task-image gaps."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from repository_resolve import ACCEPT, INDEX_TYPES, MANIFEST_TYPES, RegistryError, resolve_image


class Response:
    def __init__(self, raw, status=200):
        self.raw, self.status_code, self.headers = raw, status, {}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def iter_content(self, _):
        yield self.raw


class RegistryResolutionTests(unittest.TestCase):
    def resolve_fixture(self, *, indexed=True, docker=False, mode=None):
        index_type, manifest_type = INDEX_TYPES[int(docker)], MANIFEST_TYPES[int(docker)]
        def pack(value):
            raw = json.dumps(value).encode()
            return raw, {"digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "size": len(raw)}
        config, config_descriptor = pack({"os": "linux", "architecture": "arm64" if mode == "config-platform" else "amd64",
            "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "1" * 64]}})
        child, child_descriptor = pack({"schemaVersion": 2, "mediaType": manifest_type,
            "config": config_descriptor, "layers": [{"digest": "sha256:" + "2" * 64, "size": 123}]})
        child_descriptor.update(mediaType=manifest_type, platform={"os": "linux", "architecture": "amd64"})
        selected = dict(child_descriptor)
        if mode == "wrong-size":
            selected["size"] += 1
        candidates = [selected, {"digest": "sha256:" + "3" * 64, "size": 456,
            "mediaType": manifest_type, "platform": {"os": "unknown", "architecture": "unknown"}}]
        if mode == "ambiguous":
            candidates.append(selected)
        if mode == "missing-platform":
            candidates = candidates[1:]
        index, index_descriptor = pack({"schemaVersion": 2, "mediaType": index_type, "manifests": candidates})
        routes = {"/manifests/fixed": index if indexed else child,
                  "/manifests/" + child_descriptor["digest"]: child + b" " if mode == "corrupt-child" else child,
                  "/blobs/" + config_descriptor["digest"]: config}
        calls = []
        test = self
        class Session:
            def get(self, url, *, headers, **kwargs):
                calls.append(url)
                # Mirrors GHCR's observed 404 when an OCI index is not advertised.
                if indexed and index_type not in headers.get("Accept", ""):
                    return Response(b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', 404)
                test.assertEqual(headers["Accept"], ACCEPT)
                test.assertTrue(kwargs["stream"])
                return Response(routes[url.removeprefix("https://ghcr.io/v2/example/repository")])
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            result = resolve_image(Session(), "ghcr.io/example/repository:fixed", "Bearer fixture", cache)
            self.assertEqual(result["identity"]["id"], child_descriptor["digest"])
            self.assertEqual(result["identity"]["config_digest"], config_descriptor["digest"])
            self.assertEqual(result["compressed_bytes"], 123)
            self.assertEqual((cache / child_descriptor["digest"].split(":")[1]).read_bytes(), child)
            self.assertEqual(len(calls), 3 if indexed else 2)
            self.assertEqual(result["index_chain"], [index_descriptor["digest"]] if indexed else [])
        return result

    def test_oci_index_selects_linux_image_and_skips_attestation(self):
        self.resolve_fixture()

    def test_missing_index_accept_reproduces_the_observed_registry_404(self):
        with patch("repository_resolve.ACCEPT", ", ".join(MANIFEST_TYPES)):
            with self.assertRaises(RegistryError) as caught:
                self.resolve_fixture()
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.codes, ["MANIFEST_UNKNOWN"])

    def test_docker_manifest_list_is_supported(self):
        self.resolve_fixture(docker=True)

    def test_single_platform_manifest_keeps_original_identity(self):
        self.resolve_fixture(indexed=False)

    def test_corrupt_child_and_wrong_descriptor_size_fail(self):
        for mode in ("corrupt-child", "wrong-size"):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "descriptor digest or size mismatch"):
                self.resolve_fixture(mode=mode)

    def test_missing_or_ambiguous_platform_is_not_guessed(self):
        for mode in ("missing-platform", "ambiguous"):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "exactly one Linux AMD64"):
                self.resolve_fixture(mode=mode)

    def test_config_platform_must_match_selected_descriptor(self):
        with self.assertRaisesRegex(ValueError, "config must be Linux AMD64"):
            self.resolve_fixture(mode="config-platform")


if __name__ == "__main__":
    unittest.main()
