"""Offline Codex installation and conservative native usage normalization for ATIF."""

from collections import Counter
import hashlib
import json
from pathlib import Path
import tempfile

from harbor.agents.installed.codex import Codex, CodexOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from scripts.agent.harbor.runtime_artifacts import runtime_profile, verify_profile


def native_usage(value):
    """Keep only validated counters; absent optional counters are never invented."""
    required = {"input_tokens", "output_tokens", "cached_input_tokens"}
    optional = {"cache_write_input_tokens", "reasoning_output_tokens", "total_tokens"}
    if not isinstance(value, dict) or not required.issubset(value):
        return None
    counters = {key: value[key] for key in required | optional if key in value}
    if any(type(count) is not int or count < 0 for count in counters.values()):
        return None
    if counters["cached_input_tokens"] + counters.get("cache_write_input_tokens", 0) > counters["input_tokens"]:
        return None
    if counters.get("reasoning_output_tokens", 0) > counters["output_tokens"]:
        return None
    if "total_tokens" in counters and counters["total_tokens"] != counters["input_tokens"] + counters["output_tokens"]:
        return None
    return counters


def usage_advance(previous, total, last):
    """A repeated snapshot after a failed stream is not another measured API call."""
    if total is None or last is None:
        return "missing_or_invalid_usage"
    if set(total) != set(last) or (previous is not None and set(previous) != set(total)):
        return "counter_shape_changed"
    baseline = previous or {key: 0 for key in total}
    delta = {key: total[key] - baseline[key] for key in total}
    if any(value < 0 for value in delta.values()):
        return "counter_regression"
    if not any(delta.values()) and any(last.values()):
        return "unchanged_cumulative_snapshot"
    if delta != last:
        return "unproven_usage_delta"
    return "verified"


def normalized_usage_transcript(source, destination):
    """Write a temporary parser view, preserving the original rollout and all partial output."""
    previous = None
    seen_snapshot = False
    counts = Counter()
    with source.open() as reader, destination.open("x") as writer:
        for line in reader:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                writer.write(line)
                continue
            payload = event.get("payload")
            if event.get("type") == "event_msg" and isinstance(payload, dict) and payload.get("type") == "token_count":
                info = payload.get("info")
                total = native_usage(info.get("total_token_usage")) if isinstance(info, dict) else None
                last = native_usage(info.get("last_token_usage")) if isinstance(info, dict) else None
                reason = "missing_cumulative_baseline" if seen_snapshot and previous is None else usage_advance(previous, total, last)
                counts[reason] += 1
                # Missing, malformed, regressed, or differently shaped counters
                # cannot reset the cumulative baseline and rebill an old snapshot.
                # A valid forward total can establish the next baseline even when
                # this event's last-call attribution remains unknown.
                if total is not None and (
                    previous is None
                    or (set(previous) == set(total) and all(total[key] >= previous[key] for key in total))
                ):
                    previous = total
                seen_snapshot = True
                if reason != "verified" and isinstance(info, dict):
                    info["last_token_usage"] = None
                    line = json.dumps(event) + "\n"
            writer.write(line)
    return dict(counts)


class PortableCodexOptions(CodexOptions):
    bundle: str


class PortableCodex(Codex):
    options_model = PortableCodexOptions

    def _convert_events_to_trajectory(self, session_dir):
        self._native_usage_accounting = None
        files = list(session_dir.glob("*.jsonl"))
        if not files:
            return super()._convert_events_to_trajectory(session_dir)
        # The official converter selects the lexically newest native rollout.
        # Its parser and event grouping remain unchanged; only unsupported usage
        # attribution is withheld in this short-lived derived view.
        with tempfile.TemporaryDirectory(prefix="harbor-codex-usage-") as temporary:
            derived = Path(temporary) / session_dir.name
            derived.mkdir()
            counts = normalized_usage_transcript(max(files), derived / max(files).name)
            trajectory = super()._convert_events_to_trajectory(derived)
        if trajectory is None:
            return None
        groups = {}
        for step in trajectory.steps:
            if step.source == "agent":
                groups[(step.extra or {}).get("api_call_id", f"step:{step.step_id}")] = step.metrics
        known = [metrics for metrics in groups.values() if metrics is not None]
        unmeasured = sum(metrics is None for metrics in groups.values())
        accounting = {
            "scope": "native_model_output_groups; requests_without_native_output_are_not_observable",
            "known_usage_call_groups": len(known),
            "unmeasured_call_groups": unmeasured,
            "unknown_price_call_groups": sum(metrics.cost_usd is None for metrics in known),
            "known_estimated_cost_usd": sum(metrics.cost_usd for metrics in known if metrics.cost_usd is not None),
            "token_snapshot_classification": counts,
            "actual_provider_cost_usd": None,
        }
        self._native_usage_accounting = accounting
        if trajectory.final_metrics:
            trajectory.final_metrics.extra = {**(trajectory.final_metrics.extra or {}), "native_usage_accounting": accounting}
            if unmeasured or accounting["unknown_price_call_groups"]:
                trajectory.final_metrics.total_cost_usd = None
        return trajectory

    def __init__(self, *args, bundle: str, **kwargs):
        self.bundle = Path(bundle).resolve()
        self.installation = json.loads(self.bundle.with_suffix(".json").read_text())
        super().__init__(*args, bundle=bundle, **kwargs)
        if self._version != self.installation["version"]:
            raise ValueError("CLI version does not match the pinned bundle")

    async def install(self, environment: BaseEnvironment) -> None:
        verify_profile(self.installation, await runtime_profile(environment))
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
rm -f /usr/local/bin/codex
cat >/usr/local/bin/codex <<'CODEX'
#!/bin/sh
exec /opt/harbor-codex/node/bin/node /opt/harbor-codex/node_modules/@openai/codex/bin/codex.js "$@"
CODEX
chmod 755 /usr/local/bin/codex
codex --version
""", timeout_sec=180)
        if not await self._installed_codex_satisfies_version(environment):
            raise ValueError("Installed Codex version verification failed")

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        context.metadata = {**(context.metadata or {}), "installation": self.installation}
        if isinstance(getattr(self, "_native_usage_accounting", None), dict):
            context.metadata["native_usage_accounting"] = self._native_usage_accounting
