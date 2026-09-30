"""Verified offline CLI installation for Harbor's native Claude Code adapter."""

import hashlib
import json
from pathlib import Path

from harbor.agents.installed.claude_code import ClaudeCode, ClaudeCodeOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PortableClaudeCodeOptions(ClaudeCodeOptions):
    bundle: str


class PortableClaudeCode(ClaudeCode):
    options_model = PortableClaudeCodeOptions

    def __init__(self, *args, bundle: str, **kwargs):
        self.bundle = Path(bundle).resolve()
        self.installation = json.loads(self.bundle.with_suffix(".json").read_text())
        super().__init__(*args, bundle=bundle, **kwargs)
        if self._version != self.installation["version"]:
            raise ValueError("CLI version does not match the verified archive")

    async def install(self, environment: BaseEnvironment) -> None:
        architecture = (await environment.exec(command="uname -m")).stdout.strip()
        if architecture != "x86_64" or self.installation["platform"] != "linux/x64/glibc":
            raise ValueError("This Claude Code archive requires an x86_64 glibc task")
        with self.bundle.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != self.installation["sha256"]:
                raise ValueError("Claude Code archive integrity mismatch")
        await environment.upload_file(self.bundle, "/tmp/harbor-claude-code.tgz")
        await self.exec_as_root(environment, command="""
set -eu
mkdir -p /opt/harbor-claude-code
tar -xzf /tmp/harbor-claude-code.tgz -C /opt/harbor-claude-code --strip-components=1 package/claude
rm /tmp/harbor-claude-code.tgz
chmod 755 /opt/harbor-claude-code/claude
ln -sf /opt/harbor-claude-code/claude /usr/local/bin/claude
claude --version
""", timeout_sec=180)
        if not await self._installed_claude_satisfies_version(environment):
            raise ValueError("Installed Claude Code version verification failed")

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        context.metadata = {**(context.metadata or {}), "installation": self.installation}
