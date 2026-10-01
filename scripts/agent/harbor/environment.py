"""Shared Docker transport setup for every local campaign participant."""

import hashlib
from pathlib import Path

import certifi

from harbor.environments.docker.docker import DockerEnvironment

from scripts.agent.harbor.runtime_artifacts import UV_VERSION, UV_ARTIFACTS, runtime_profile

UV_ARCHIVE, UV_SHA256, _ = UV_ARTIFACTS["glibc"]


PACKAGE_MIRROR_SETUP = r"""
set -eu
if command -v apt-get >/dev/null 2>&1; then
  for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
    [ -f "$source" ] || continue
    sed -i -E \
      -e 's#https?://(deb\.debian\.org/debian-security|security\.debian\.org/debian-security)#https://mirrors.aliyun.com/debian-security#g' \
      -e 's#https?://deb\.debian\.org/debian([/ ]|$)#https://mirrors.aliyun.com/debian\1#g' \
      -e 's#https?://([a-z0-9-]+\.)?archive\.ubuntu\.com/ubuntu([/ ]|$)#https://mirrors.aliyun.com/ubuntu\2#g' \
      -e 's#https?://security\.ubuntu\.com/ubuntu([/ ]|$)#https://mirrors.aliyun.com/ubuntu\1#g' \
      "$source"
  done
  cat >/etc/apt/apt.conf.d/99-harbor-network <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
Acquire::https::CaInfo "/tmp/harbor-package-ca.pem";
Acquire::PDiffs "false";
APT
fi
"""

UV_BOOTSTRAP = r"""
set -eu
test "$(uname -m)" = x86_64
mkdir -p /opt/harbor-bootstrap/uv /root/.local/bin
tar -xzf /tmp/harbor-uv.tar.gz --strip-components=1 -C /opt/harbor-bootstrap/uv
rm /tmp/harbor-uv.tar.gz
ln -sf /opt/harbor-bootstrap/uv/uv /root/.local/bin/uv
ln -sf /opt/harbor-bootstrap/uv/uvx /root/.local/bin/uvx
printf 'export PATH="$HOME/.local/bin:$PATH"\n' >/root/.local/bin/env
/root/.local/bin/uv --version
"""


class BenchmarkDocker(DockerEnvironment):
    async def start(self, force_build: bool):
        await super().start(force_build)
        profile = await runtime_profile(self)
        if profile["arch"] != "x64":
            raise RuntimeError("The frozen UV bootstrap currently requires x64")
        archive, checksum, _ = UV_ARTIFACTS[profile["libc"]]
        if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise RuntimeError("Run prepare-environment.py --libc " + profile["libc"] + " before dispatch")
        certificates = Path(certifi.where())
        await self.upload_file(certificates, "/tmp/harbor-package-ca.pem")
        await self.upload_file(archive, "/tmp/harbor-uv.tar.gz")
        setup = PACKAGE_MIRROR_SETUP + UV_BOOTSTRAP
        result = await self.exec(command=setup, user="root", timeout_sec=60)
        if result.return_code:
            raise RuntimeError("Shared package mirror configuration failed: " + (result.stderr or ""))
        self.logger.info("Campaign environment setup SHA-256: %s", hashlib.sha256(setup.encode()).hexdigest())
        self.logger.info("Campaign package CA bundle SHA-256: %s", hashlib.sha256(certificates.read_bytes()).hexdigest())
        self.logger.info("Campaign UV %s archive SHA-256: %s", UV_VERSION, checksum)
