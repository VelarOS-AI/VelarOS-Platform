"""Offline installation for Harbor's unmodified official Codex run/trace adapter."""

import hashlib
import json
from pathlib import Path

from harbor.agents.installed.codex import Codex, CodexOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PortableCodexOptions(CodexOptions):
    bundle: str


class PortableCodex(Codex):
    options_model = PortableCodexOptions

    def __init__(self, *args, bundle: str, **kwargs):
        self.bundle = Path(bundle).resolve()
        self.installation = json.loads(self.bundle.with_suffix(".json").read_text())
        super().__init__(*args, bundle=bundle, **kwargs)
        if self._version != self.installation["version"]:
            raise ValueError("CLI version does not match the pinned bundle")

    async def install(self, environment: BaseEnvironment) -> None:
        architecture = (await environment.exec(command="uname -m")).stdout.strip()
        if architecture != "x86_64" or self.installation["arch"] != "x64":
            raise ValueError("This Codex archive requires an x86_64 task")
        with self.bundle.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != self.installation["sha256"]:
                raise ValueError("Codex archive integrity mismatch")
        await environment.upload_file(self.bundle, "/tmp/harbor-codex.tar.gz")
        await self.exec_as_root(environment, command="""
set -eu
mkdir -p /opt/harbor-codex
tar -xzf /tmp/harbor-codex.tar.gz -C /opt/harbor-codex
rm /tmp/harbor-codex.tar.gz
chmod -R a+rX /opt/harbor-codex
ln -sf /opt/harbor-codex/node/bin/node /usr/local/bin/node
ln -sf /opt/harbor-codex/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
codex --version
""", timeout_sec=180)
        if not await self._installed_codex_satisfies_version(environment):
            raise ValueError("Installed Codex version verification failed")

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        context.metadata = {**(context.metadata or {}), "installation": self.installation}
