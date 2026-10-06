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

from scripts.agent.harbor.bundle_integrity import verify_bundle
from scripts.agent.harbor.pricing import summarize_usage, validate_pricing
from scripts.agent.harbor.runtime_artifacts import portable_path, runtime_profile, verify_profile
from scripts.agent.harbor.trace_artifact import read_trace_artifact


class ScriptActOptions(InstalledAgentOptions):
    bundle: str
    reasoning_effort: str
    runtime_cache: str | None = None


class ScriptActAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(atif=True)
    options_model = ScriptActOptions

    def __init__(self, logs_dir: Path, *, bundle: str, reasoning_effort: str, runtime_cache: str | None = None, **kwargs):
        self.bundle = Path(bundle).resolve()
        self.runtime_cache = Path(runtime_cache).resolve() if runtime_cache else self.bundle.parent / "runtime-downloads"
        self.identity = verify_bundle(self.bundle)
        super().__init__(logs_dir=logs_dir, bundle=bundle, reasoning_effort=reasoning_effort, runtime_cache=runtime_cache, **kwargs)
        expected_model = self.identity.get("modelName")
        if not expected_model or self.model_name not in ("openai/" + expected_model, expected_model):
            raise ValueError("Requested model differs from the frozen candidate model")
        if self.identity.get("reasoningEffort") not in ("low", "medium", "high"):
            raise ValueError("Candidate has no valid frozen reasoning effort")
        if reasoning_effort != self.identity["reasoningEffort"]:
            raise ValueError("Requested reasoning effort differs from the frozen candidate reasoning effort")
        if self.identity.get("pricing") is not None:
            validate_pricing(self.identity["pricing"], expected_model, reasoning_effort)

    @staticmethod
    def name() -> str:
        return "velaros-scriptact"

    def version(self) -> str:
        return self.identity["sourceCommit"][:12] + ":" + self.identity["bundleFingerprint"][:12]

    async def install(self, environment: BaseEnvironment) -> None:
        profile = await runtime_profile(environment)
        node_arch = profile["arch"]
        bun_arch = {"x64": "x64", "arm64": "aarch64"}[node_arch]
        portable = portable_path(self.bundle, node_arch, profile["libc"])
        if portable.exists():
            metadata = json.loads(portable.with_suffix(".json").read_text())
            verify_profile(metadata, profile)
            with portable.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if metadata["bundleFingerprint"] != self.identity["bundleFingerprint"] or metadata.get("bundleSealSha256") != self.identity["bundleSeal"]["sha256"] or metadata["sha256"] != digest:
                raise ValueError("Portable archive does not match this bundle")
            await environment.upload_file(portable, "/tmp/scriptact-agent.tar.gz")
            await self.exec_as_root(environment, command="""
set -eu
mkdir -p /opt/velaros-scriptact
tar -xzf /tmp/scriptact-agent.tar.gz -C /opt/velaros-scriptact
rm /tmp/scriptact-agent.tar.gz
chmod -R a+rX /opt/velaros-scriptact
cd /opt/velaros-scriptact
node/bin/node --input-type=module -e "await import('@velaros-ai/velaros'); await import('@velaros-ai/velaros/execution/local')"
""", timeout_sec=180)
            self.identity = {**self.identity, "portable": metadata}
            return
        if profile["libc"] == "musl":
            raise ValueError("Prepare the matching musl portable archive before dispatch; online GNU fallback is incompatible")
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
node --input-type=module -e "await import('@velaros-ai/velaros'); await import('@velaros-ai/velaros/execution/local')"
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
        traces = read_trace_artifact(self.logs_dir / "traces.json")
        all_turns = traces["traces"] + [turn for branch in traces["branches"] for turn in branch["turns"]]
        usages = []
        for turn in all_turns:
            decision = turn.get("decision") or {}
            try:
                body = json.loads(decision["body"]) if decision.get("body") and not decision.get("truncated") else {}
                usages.append(body.get("usage") if isinstance(body, dict) else None)
            except (ValueError, TypeError):
                usages.append(None)
        estimate = summarize_usage(usages, self.identity.get("pricing"), self.identity.get("modelName"), self.identity.get("reasoningEffort"))
        context.n_input_tokens = estimate["input_tokens"]
        context.n_output_tokens = estimate["output_tokens"]
        context.n_cache_tokens = estimate["cache_read_tokens"]
        context.cost_usd = estimate["cost_usd"]
        context.metadata = {**(context.metadata or {}), "source": self.identity,
            "runtime": json.loads((self.logs_dir / "status.json").read_text()), "atif_schema": trajectory.schema_version,
            "cost_estimate": {**estimate, "basis": "runtime usage and frozen candidate pricing",
                              "pricing_sha256": (self.identity.get("pricing") or {}).get("sha256"),
                              "authority": "gateway-request-ledger"}}
