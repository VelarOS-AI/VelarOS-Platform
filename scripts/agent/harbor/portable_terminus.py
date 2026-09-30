"""Prepare regional Ubuntu mirrors before the unchanged native Terminus setup."""

import hashlib
import shlex
from pathlib import Path

from .repository_agents import RepositoryTerminus


UBUNTU_MIRRORS = r"""
set -eu
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
  [ -f "$source" ] || continue
  sed -i -E 's#https?://([a-z0-9-]+\.)*archive\.ubuntu\.com/ubuntu([/ ]|$)#https://mirrors.aliyun.com/ubuntu\2#g' "$source"
done
"""


class RepositoryTerminusWithMirrors(RepositoryTerminus):
    async def setup(self, environment):
        result = await environment.exec(command=UBUNTU_MIRRORS, user="root", timeout_sec=30)
        if result.return_code:
            raise RuntimeError("Terminus Ubuntu mirror preparation failed")
        self.logger.info("Campaign Terminus setup adapter SHA-256: %s",
                         hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
        release = await environment.exec(command=". /etc/os-release; printf '%s %s' \"$ID\" \"$VERSION_ID\"", timeout_sec=10)
        if release.stdout.strip() != "ubuntu 20.04":
            await super().setup(environment)
            return
        # Focal's tmux 3.0a has no new-session -e. Its native login Bash reads
        # these same package transport variables from /etc/profile.d instead.
        extra_env = self._extra_env
        allowed = {"UV_INDEX_URL", "PIP_INDEX_URL", "UV_NATIVE_TLS", "UV_HTTP_TIMEOUT", "UV_HTTP_RETRIES"}
        if not set(extra_env) <= allowed:
            raise ValueError("Legacy tmux environment compatibility only permits package transport settings")
        profile = "\n".join("export " + key + "=" + shlex.quote(value) for key, value in extra_env.items()) + "\n"
        result = await environment.exec(command="printf %s " + shlex.quote(profile) +
            " > /etc/profile.d/harbor-terminus-packages.sh", user="root", timeout_sec=10)
        if result.return_code:
            raise RuntimeError("Legacy tmux login environment preparation failed")
        self._extra_env = {}
        try:
            await super().setup(environment)
        finally:
            self._extra_env = extra_env
