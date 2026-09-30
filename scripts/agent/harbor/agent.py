"""Harbor installed-agent adapter for the unmodified ScriptAct runtime."""

import json
import hashlib
import os
import shlex
from pathlib import Path

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory


class ScriptActOptions(InstalledAgentOptions):
    bundle: str
    runtime_cache: str | None = None


class ScriptActAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(atif=True)
    options_model = ScriptActOptions

    def __init__(self, logs_dir: Path, *, bundle: str, runtime_cache: str | None = None, **kwargs):
        self.bundle = Path(bundle).resolve()
        self.runtime_cache = Path(runtime_cache).resolve() if runtime_cache else self.bundle.parent / "runtime-downloads"
        self.identity = json.loads((self.bundle / "identity.json").read_text())
        super().__init__(logs_dir=logs_dir, bundle=bundle, runtime_cache=runtime_cache, **kwargs)
        if self.model_name not in ("openai/gpt-6-sol", "gpt-6-sol"):
            raise ValueError("This campaign is configured for GPT-6 Sol")

    @staticmethod
    def name() -> str:
        return "velaros-scriptact"

    def version(self) -> str:
        return self.identity["sourceCommit"][:12] + ":" + self.identity["bundleFingerprint"][:12]

    async def install(self, environment: BaseEnvironment) -> None:
        architecture = (await environment.exec(command="uname -m")).stdout.strip()
        node_arch, bun_arch = {"x86_64": ("x64", "x64"), "aarch64": ("arm64", "aarch64")}[architecture]
        portable = self.bundle.parent / f"{self.bundle.name}-linux-{node_arch}.tar.gz"
        if portable.exists():
            metadata = json.loads(portable.with_suffix(".json").read_text())
            with portable.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if metadata["bundleFingerprint"] != self.identity["bundleFingerprint"] or metadata["sha256"] != digest:
                raise ValueError("Portable archive does not match this bundle")
            await environment.upload_file(portable, "/tmp/scriptact-agent.tar.gz")
            await self.exec_as_root(environment, command="""
set -eu
mkdir -p /opt/velaros-scriptact
tar -xzf /tmp/scriptact-agent.tar.gz -C /opt/velaros-scriptact
rm /tmp/scriptact-agent.tar.gz
chmod -R a+rX /opt/velaros-scriptact
cd /opt/velaros-scriptact
node/bin/node --input-type=module -e "await import('@velaros-ai/velaros'); await import('@velaros-ai/velaros/shell/local')"
""", timeout_sec=180)
            self.identity = {**self.identity, "portable": metadata}
            return
        await self.ensure_system_dependencies(environment, ("curl", "xz", "unzip", "ca_certificates"))
        await environment.upload_dir(self.bundle, "/opt/velaros-scriptact")
        manifest_path = self.runtime_cache / "manifest.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        for name, target in [(f"node-v24.15.0-linux-{node_arch}.tar.xz", "node.tar.xz"), (f"bun-linux-{bun_arch}.zip", "bun.zip")]:
            archive = self.runtime_cache / name
            if archive.exists() and name in manifest:
                with archive.open("rb") as source:
                    digest = hashlib.file_digest(source, "sha256").hexdigest()
                if digest != manifest[name]["sha256"]:
                    raise ValueError(f"Runtime cache integrity mismatch: {name}")
                await environment.upload_file(archive, f"/opt/velaros-scriptact/{target}")
        await self.exec_as_root(environment, command="""
set -eu
case "$(uname -m)" in x86_64) node_arch=x64; bun_arch=x64 ;; aarch64) node_arch=arm64; bun_arch=aarch64 ;; *) exit 2 ;; esac
cd /opt/velaros-scriptact
test -s node.tar.xz || curl --fail --location --retry 2 --connect-timeout 15 --max-time 240 https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-${node_arch}.tar.xz -o node.tar.xz
mkdir -p node
tar -xJf node.tar.xz --strip-components=1 -C node
rm node.tar.xz
test -s bun.zip || curl --fail --location --retry 2 --connect-timeout 15 --max-time 240 https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-linux-${bun_arch}.zip -o bun.zip
unzip -q bun.zip
rm bun.zip
export PATH="/opt/velaros-scriptact/node/bin:/opt/velaros-scriptact/bun-linux-${bun_arch}:$PATH"
bun install --production --ignore-scripts --frozen-lockfile
node --input-type=module -e "await import('@velaros-ai/velaros'); await import('@velaros-ai/velaros/shell/local')"
chmod -R a+rX /opt/velaros-scriptact
""", timeout_sec=600)

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        prompt = self.logs_dir / "instruction.txt"
        prompt.write_text(instruction)
        remote = str(self.environment_logs_dir)
        await environment.upload_file(prompt, f"{remote}/instruction.txt")
        endpoint = os.environ.get("SCRIPTACT_BENCH_BASE_URL")
        token_file = os.environ.get("SCRIPTACT_BENCH_TOKEN_FILE")
        if not endpoint or not token_file:
            raise ValueError("The campaign budget gateway must be configured")
        # Real provider credentials remain on the host; containers receive a campaign-scoped gateway token.
        result = await environment.exec(command="pwd")
        workspace = (result.stdout or "").strip()
        if not workspace or workspace == "/":
            workspace = "/workspace"
            await self.exec_as_root(environment, command="mkdir -p /workspace && chmod 777 /workspace")
        command = (
            "/opt/velaros-scriptact/node/bin/node /opt/velaros-scriptact/run.mjs"
            f" --instruction {shlex.quote(remote + '/instruction.txt')}"
            f" --output {shlex.quote(remote)} --workspace {shlex.quote(workspace)}"
            f" >{shlex.quote(remote + '/console.log')} 2>&1"
        )
        await self.exec_as_agent(environment, command=command, env={
            "OPENAI_API_KEY": Path(token_file).read_text().strip(),
            "OPENAI_BASE_URL": endpoint,
            "VELAROS_BENCH_CONTAINER": "1",
        })

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "trajectory.json"
        if not path.exists():
            return
        trajectory = Trajectory.model_validate_json(path.read_text())
        traces = json.loads((self.logs_dir / "traces.json").read_text())
        all_turns = traces["traces"] + [turn for branch in traces["branches"] for turn in branch["turns"]]
        usage = [json.loads(turn["decision"]["body"]).get("usage") for turn in all_turns if turn.get("decision") and turn["decision"].get("body")]
        if len(usage) == len(all_turns) and usage and all(item and isinstance(item.get("inputTokens"), (int, float)) and isinstance(item.get("outputTokens"), (int, float)) for item in usage):
            context.n_input_tokens = sum(item["inputTokens"] for item in usage)
            context.n_output_tokens = sum(item["outputTokens"] for item in usage)
            if all("cacheReadTokens" in item for item in usage):
                context.n_cache_tokens = sum(item["cacheReadTokens"] for item in usage)
                if all("cacheWriteTokens" in item for item in usage):
                    context.cost_usd = sum((
                        ((item["inputTokens"] - item["cacheReadTokens"] - item["cacheWriteTokens"]) * 2 + item["cacheReadTokens"] * 0.2 + item["cacheWriteTokens"] * 2.5) * (2 if item["inputTokens"] > 272000 else 1)
                        + item["outputTokens"] * (15 if item["inputTokens"] > 272000 else 10)
                    ) / 1_000_000 for item in usage)
        context.metadata = {"source": self.identity, "runtime": json.loads((self.logs_dir / "status.json").read_text()), "atif_schema": trajectory.schema_version}
