"""Compare frozen versions on the same declared tasks without dispatching work."""
import argparse
import hashlib
import json
import math
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def delta(before, after):
    before, after = number(before), number(after)
    return None if before is None or after is None else {
        "before": before, "after": after, "difference": after - before,
        "ratio": after / before if before else None}


def load_inputs(spec, evidence):
    loaded = {}
    for name in ("manifest", "report", "pricing"):
        path = Path(spec[name]).resolve()
        raw = path.read_bytes()
        evidence[str(path)] = hashlib.sha256(raw).hexdigest()
        loaded[name] = json.loads(raw)
    manifest, report = loaded["manifest"], loaded["report"]
    if report["manifest_sha256"] != digest(spec["manifest"]):
        raise ValueError("Report is not bound to the supplied frozen manifest")
    if report.get("unsettled_requests") != 0 or report.get("issues") or report.get("report_errors"):
        raise ValueError("Report is incomplete or has unresolved evidence issues")
    if report.get("model") != manifest["model"] or report.get("reasoning_effort") != manifest["reasoning_effort"]:
        raise ValueError("Report model configuration differs from its manifest")
    pricing_path = Path(spec["pricing"]).resolve()
    # Compare only a price contract already pinned in the manifest, never a new
    # current price fetched after an old campaign completed.
    matches = [expected for path, expected in manifest["files_sha256"].items()
               if pricing_path == (Path(spec["root"]) / path).resolve()]
    if matches != [digest(pricing_path)]:
        raise ValueError("Pricing contract is not pinned by the frozen manifest")
    return loaded


def participant_contract(manifest, name):
    participant = manifest.get("participants", {}).get(name)
    model, effort = manifest["model"], manifest["reasoning_effort"]
    if not isinstance(model, str) or not model or not isinstance(effort, str) or not effort:
        raise ValueError("Frozen model configuration is unknown")
    # Harbor declarations carry the provider-qualified model; bundle identity and
    # native provider configuration carry the exact API model. Match only the
    # two spellings already accepted by ScriptActAgent, not arbitrary providers.
    models = (model, "openai/" + model)
    if (not isinstance(participant, dict) or not participant.get("agent") or
            participant.get("model") not in models):
        raise ValueError("Selected participant model differs from its frozen manifest")
    kwargs = participant.get("kwargs")
    if not isinstance(kwargs, dict) or kwargs.get("reasoning_effort") != effort:
        raise ValueError("Selected participant reasoning effort differs from its frozen manifest")
    config, identity = kwargs.get("config", {}), participant.get("identity", {})
    if not isinstance(config, dict) or not isinstance(identity, dict):
        raise ValueError("Selected participant model configuration is malformed")
    if "model_name" in kwargs and kwargs["model_name"] not in models:
        raise ValueError("Selected participant model override differs from its frozen manifest")
    for values, field, expected in (
        (config, "model", model),
        (config, "model_reasoning_effort", effort),
        (identity, "modelName", model), (identity, "reasoningEffort", effort),
    ):
        if field in values and values[field] != expected:
            raise ValueError("Selected participant model override differs from its frozen manifest")
    return {key: participant[key] for key in
            ("agent", "model", "kwargs", "identity", "files_sha256") if key in participant}


def trial(manifest, report, participant, task):
    attempts = [a for a in manifest["attempts"] if a["participant"] == participant and a["task"] == task]
    jobs = [j for j in report["jobs"] if j["job"] == participant]
    if len(attempts) != 1 or len(jobs) != 1:
        raise ValueError("Exactly one declared attempt and report participant are required")
    attempt = attempts[0]
    candidates = [t for t in jobs[0]["trials"] if
                  t.get("source_job") == attempt["source_job"] and t.get("replay_job") == attempt["replay_job"]]
    if len(candidates) != 1:
        raise ValueError("Exactly one terminal official replay is required")
    result = candidates[0]
    if result["task"] != task and result["task"] != "swebench-pro/" + task:
        raise ValueError("Trial task identity differs from its declared attempt")
    if number(result.get("reward")) is None or not result.get("score_authority"):
        raise ValueError("Official task quality is unknown")
    return result


def measurements(row):
    metrics, agent = row["metrics"], row.get("agent_metrics") or {}
    unknown = metrics.get("unknown_cost_requests")
    reference = number(metrics.get("known_cost_usd")) if type(unknown) is int and unknown == 0 else None
    return {
        "official_reward": row["reward"], "agent_seconds": number(row.get("agent_seconds")),
        "whole_attempt_seconds": number(row.get("attempt_wall_seconds")),
        "complete_reference_model_fee_usd": reference, "unknown_usage_requests": unknown,
        "actual_provider_fee_usd": number(metrics.get("actual_provider_cost_usd")),
        "input_tokens": number(metrics.get("input_tokens")),
        "output_tokens": number(metrics.get("output_tokens")),
        "cache_read_tokens": number(metrics.get("cache_read_tokens")),
        "SDK_response_rejections": agent.get("response_rejections"),
        "gateway_request_failures": metrics.get("request_failure_counts"),
        "tool_usage": agent.get("tool_usage"),
        "native_operations": agent.get("native_operations"),
        "infrastructure_issue": row.get("infrastructure_issue"),
    }


def compare(config):
    evidence = {}
    old = load_inputs(config["baseline"], evidence)
    new = load_inputs(config["candidate"], evidence)
    om, nm = old["manifest"], new["manifest"]
    for spec in (config["baseline"], config["candidate"]):
        if spec["participant"] == spec["control"]:
            raise ValueError("Version participant and independent control must differ")
    controls = []
    for manifest, spec in ((om, config["baseline"]), (nm, config["candidate"])):
        participant_contract(manifest, spec["participant"])
        controls.append(participant_contract(manifest, spec["control"]))
    if controls[0] != controls[1]:
        raise ValueError("Independent control implementation or model configuration differs")
    fields = ("model", "reasoning_effort", "vm", "resource_pool", "trial_concurrency",
              "source_phase_seconds", "agent_budget_seconds", "dataset_revision", "official_replay_sha256")
    if any(om.get(k) != nm.get(k) for k in fields) or om["gateway"]["upstream"] != nm["gateway"]["upstream"]:
        raise ValueError("Frozen model, upstream, resource or evaluation contracts differ")
    tasks = config["tasks"]
    if not tasks or len(tasks) != len(set(tasks)):
        raise ValueError("Declare a nonempty unique task cohort before comparison")
    equal_prices = old["pricing"] == new["pricing"]
    rows = []
    for task in tasks:
        if task not in om["tasks"] or task not in nm["tasks"] or om["tasks"][task] != nm["tasks"][task]:
            raise ValueError("Frozen task, official files or image differ")
        before = measurements(trial(om, old["report"], config["baseline"]["participant"], task))
        after = measurements(trial(nm, new["report"], config["candidate"]["participant"], task))
        control_before = measurements(trial(om, old["report"], config["baseline"]["control"], task))
        control_after = measurements(trial(nm, new["report"], config["candidate"]["control"], task))
        successful = before["official_reward"] == after["official_reward"] == 1
        clean = successful and not before["infrastructure_issue"] and not after["infrastructure_issue"]
        flags = []
        if after["official_reward"] < before["official_reward"]:
            flags.append("official_quality_regression")
        time = delta(before["agent_seconds"], after["agent_seconds"]) if clean else None
        whole = delta(before["whole_attempt_seconds"], after["whole_attempt_seconds"]) if clean else None
        cost = delta(before["complete_reference_model_fee_usd"], after["complete_reference_model_fee_usd"]) if equal_prices else None
        if time and time["difference"] > 0:
            flags.append("observed_agent_time_increase")
        if whole and whole["difference"] > 0:
            flags.append("observed_whole_attempt_time_increase")
        if cost and cost["difference"] > 0:
            flags.append("observed_reference_fee_increase")
        if not clean:
            flags.append("successful_efficiency_comparison_unavailable")
        elif time is None or whole is None:
            flags.append("time_comparison_unavailable")
        if any((v.get("SDK_response_rejections") or {}).get("total", 0) or
               any((v.get("gateway_request_failures") or {}).values())
               for v in (before, after, control_before, control_after)):
            flags.append("client_or_gateway_failure_observed")
        rows.append({"task": task, "baseline": before, "candidate": after,
                     "control_baseline": control_before, "control_candidate": control_after,
                     "agent_time_change": time, "whole_attempt_time_change": whole,
                     "reference_fee_change": cost, "review_flags": flags})
    if any(digest(path) != expected for path, expected in evidence.items()):
        raise ValueError("Frozen inputs changed during comparison")
    return {"schema": 1, "status": "review_required" if any(r["review_flags"] for r in rows) else "compared",
            "rows": rows, "equal_reference_price_contracts": equal_prices,
            "causal_performance_gain_proved": False, "general_superiority_proved": False,
            "evidence_files_sha256": evidence,
            "interpretation": "Observed same-task version comparison only. SDK and gateway failures are separate. "
                              "Control movement, model variation and interruptions prevent a single pair from proving causality. "
                              "Unknown fees remain unknown; failed tasks never create successful speed gains. "
                              "A review flag diagnoses evidence and never authorizes paid dispatch."}


def compare_config(path):
    path = Path(path)
    raw = path.read_bytes()
    expected = hashlib.sha256(raw).hexdigest()
    result = compare(json.loads(raw))
    if digest(path) != expected:
        raise ValueError("Comparison config changed during comparison")
    result["comparison_config_sha256"] = expected
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = compare_config(args.config)
    with args.output.open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"status": result["status"], "tasks": len(result["rows"]), "output_sha256": digest(args.output)}))


if __name__ == "__main__":
    main()
