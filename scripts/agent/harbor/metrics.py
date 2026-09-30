"""Comparable measurements from provider usage and native agent evidence."""

import json
import re
import statistics

COST_COMPONENTS = ("uncached_input", "cached_input", "cache_write", "output")


def verifier_infrastructure_issue(output):
    missing_pytest = 'Failed to spawn: `pytest`' in output
    missing_uv = 'uv: command not found' in output and 'test session starts' not in output
    return "verifier_dependency_unavailable" if missing_pytest or missing_uv else None


def trial_infrastructure_issue(result, verifier_output):
    exception = result.get("exception_info") or {}
    execution = result.get("agent_execution") or {}
    message = exception.get("exception_message", "")
    if not execution.get("started_at"):
        if "Docker compose command failed" in message and any(
            marker in message for marker in ("Pulling", "failed to pull", "pull access denied")
        ):
            return "environment_image_unavailable"
        if result.get("agent_setup") and exception:
            return "agent_installation_failed"
        if result.get("environment_setup") and exception:
            return "environment_setup_failed"
    return verifier_infrastructure_issue(verifier_output)


def environment_evidence(config, log):
    """Read historical setup evidence, never substitute today's environment."""
    hashes = {}
    for key, label in (("setup_sha256", "environment setup"),
                       ("ca_sha256", "package CA bundle"),
                       ("uv_sha256", r"UV 0\.7\.13 archive"),
                       ("cancellation_sha256", "cancellation adapter")):
        match = re.search(r"Campaign " + label + r" SHA-256: ([0-9a-f]{64})", log)
        hashes[key] = match.group(1) if match else None
    environment = config.get("environment") or {}
    barrier = re.search(r"Campaign provider idle barrier seconds: ([0-9.]+)", log)
    return {"type": environment.get("type"), "import_path": environment.get("import_path"), **hashes,
            "provider_idle_barrier_seconds": float(barrier.group(1)) if barrier else None}


def tool_environment_diagnostics(outputs):
    """Record concrete tool-output symptoms without changing official task outcomes."""
    observations = {}
    for reference, output in outputs:
        if isinstance(output, str):
            observations[reference] = output
    matched = {}
    for reference, output in observations.items():
        numbers = re.findall(r"rosetta error: Unimplemented syscall number (\d+)", output)
        if numbers:
            matched[reference] = sorted(set(map(int, numbers)))
    issues = []
    if matched:
        issues.append({"kind": "rosetta_unimplemented_syscall", "tool_observations": len(matched),
                       "syscall_numbers": sorted({number for numbers in matched.values() for number in numbers}),
                       "references": sorted(matched), "interpretation": "Observed host compatibility symptom; official reward is unchanged."})
    return {"measured_tool_outputs": len(observations), "issues": issues}


def native_codex_operations(directory):
    """Count native operation items separately from outer model tool calls."""
    path = directory / "agent/codex.txt"
    if not path.exists():
        return None
    thread, observed, completed = None, {}, {}
    with path.open(errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") == "thread.started":
                if isinstance(event.get("thread_id"), str):
                    thread = event["thread_id"]
                continue
            if event.get("type") not in ("item.started", "item.updated", "item.completed"):
                continue
            item = event.get("item")
            if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                    or item.get("type") not in ("command_execution", "file_change")):
                continue
            key = (thread, item["id"])
            # Keep only measurement fields; commands and output may contain credentials.
            measured = {name: item.get(name) for name in ("type", "exit_code", "status")}
            observed[key] = measured
            if event["type"] == "item.completed":
                completed[key] = measured
    if not observed:
        return None
    commands = [item for item in completed.values() if item["type"] == "command_execution"]
    changes = [item for item in completed.values() if item["type"] == "file_change"]
    return {"source": "codex_native_jsonl_items",
            "completed_by_type": {"command_execution": len(commands), "file_change": len(changes)},
            "pending_items": len(observed.keys() - completed.keys()),
            "failed_command_executions": sum(type(item["exit_code"]) is int and item["exit_code"] != 0 for item in commands),
            "unknown_command_exit_codes": sum(type(item["exit_code"]) is not int for item in commands),
            "failed_file_change_operations": sum(item["status"] == "failed" for item in changes),
            "interpretation": "Unique native operation items scoped by thread; outer ATIF model tool calls can contain multiple operations. File-change items count operations, not files. Missing native evidence is unknown."}


def distribution(values):
    values = sorted(v for v in values if isinstance(v, (int, float)))
    if not values:
        return None
    return {"count": len(values), "mean": statistics.mean(values),
            "p50": statistics.median(values), "p90": values[max(0, (len(values) * 9 + 9) // 10 - 1)],
            "max": values[-1]}


def request_metrics(calls):
    rows = []
    for call in calls:
        usage = call.get("usage") or {}
        details = usage.get("input_tokens_details") or usage.get("prompt_tokens_details") or {}
        output = usage.get("output_tokens_details") or usage.get("completion_tokens_details") or {}
        rows.append({"input": usage.get("input_tokens", usage.get("prompt_tokens")),
                     "output": usage.get("output_tokens", usage.get("completion_tokens")),
                     "read": details.get("cached_tokens"), "write": details.get("cache_write_tokens"),
                     "reasoning": output.get("reasoning_tokens")})

    def total(key):
        values = [r[key] for r in rows]
        # An empty request set consumed zero tokens; an actual request without usage is unknown.
        return sum(values) if all(isinstance(v, (int, float)) for v in values) else None

    inputs, reads = total("input"), total("read")
    durations = [c.get("durationMs") for c in calls]
    transport_groups = {"streaming": [], "nonstreaming": [], "unknown": []}
    for call in calls:
        stream = (call.get("metadata") or {}).get("stream")
        transport_groups["streaming" if stream is True else "nonstreaming" if stream is False else "unknown"].append(call)
    savings = []
    components = []
    for call, row in zip(calls, rows):
        pricing = call.get("pricing")
        part = dict.fromkeys(COST_COMPONENTS)
        if (pricing and all(row[k] is not None for k in ("input", "output", "read", "write"))
                and all(k in pricing for k in ("input", "cached", "write", "output", "longThreshold", "longInputMultiplier", "longOutputMultiplier"))
                and all(row[k] >= 0 for k in ("input", "output", "read", "write"))
                and row["read"] + row["write"] <= row["input"]):
            long = row["input"] > pricing["longThreshold"]
            input_multiplier = pricing["longInputMultiplier"] if long else 1
            part = {
                "uncached_input": (row["input"] - row["read"] - row["write"]) * pricing["input"] * input_multiplier / 1_000_000,
                "cached_input": row["read"] * pricing["cached"] * input_multiplier / 1_000_000,
                "cache_write": row["write"] * pricing["write"] * input_multiplier / 1_000_000,
                "output": row["output"] * pricing["output"] * (pricing["longOutputMultiplier"] if long else 1) / 1_000_000,
            }
        components.append(part)
        if pricing and all(row[k] is not None for k in ("input", "read", "write")):
            multiplier = pricing["longInputMultiplier"] if row["input"] > pricing["longThreshold"] else 1
            savings.append((row["read"] * (pricing["input"] - pricing["cached"])
                            - row["write"] * (pricing["write"] - pricing["input"])) * multiplier / 1_000_000)
    return {
        "requests": len(calls), "input_tokens": inputs, "output_tokens": total("output"),
        "reasoning_tokens": total("reasoning"), "cache_read_tokens": reads, "cache_write_tokens": total("write"),
        "cache_token_hit_rate": reads / inputs if inputs and reads is not None else None,
        "cache_net_savings_usd": sum(savings) if len(savings) == len(calls) else None,
        "requests_with_cache_hit": sum((r["read"] or 0) > 0 for r in rows),
        "peak_input_tokens": max((r["input"] for r in rows if r["input"] is not None), default=None),
        "request_seconds": distribution([v / 1000 for v in durations if v is not None]),
        "model_request_seconds_sum": sum(durations) / 1000 if all(v is not None for v in durations) else None,
        "gateway_queue_seconds": distribution([c["queueWaitMs"] / 1000 for c in calls if "queueWaitMs" in c]),
        "first_byte_seconds": distribution([c["firstByteMs"] / 1000 for c in calls if "firstByteMs" in c]),
        "transport": {"request_counts": {key: len(group) for key, group in transport_groups.items()},
            "endpoints": sorted({c["metadata"]["endpoint"] for c in calls if (c.get("metadata") or {}).get("endpoint")}),
            "first_byte_seconds": {key: distribution([c["firstByteMs"] / 1000 for c in group
                if isinstance(c.get("firstByteMs"), (int, float))]) for key, group in transport_groups.items()}},
        "first_output_seconds": distribution([c["firstOutputMs"] / 1000 for c in calls if "firstOutputMs" in c]),
        "first_reasoning_seconds": distribution([c["firstReasoningMs"] / 1000 for c in calls if "firstReasoningMs" in c]),
        "first_native_tool_input_seconds": distribution([c["firstToolInputMs"] / 1000 for c in calls if "firstToolInputMs" in c]),
        "explicit_cache_breakpoints": distribution([c.get("metadata", {}).get("explicitCacheBreakpoints") for c in calls]),
        "distinct_cache_keys": len({c["metadata"]["cacheKeyHash"] for c in calls if c.get("metadata", {}).get("cacheKeyHash")}) if any("cacheKeyHash" in c.get("metadata", {}) for c in calls) else None,
        "http_error_requests": sum(c["status"] not in ("http-200", "reserved") for c in calls),
        "unsettled_requests": sum(c["status"] == "reserved" for c in calls),
        "unknown_cost_requests": sum(c.get("estimatedUsd") is None for c in calls),
        "known_cost_usd": sum(c.get("estimatedUsd") or 0 for c in calls),
        "cost_components_usd": {key: sum(part[key] for part in components)
                                if all(part[key] is not None for part in components) else None
                                for key in COST_COMPONENTS},
        "models": sorted({c["model"] for c in calls if c.get("model")}),
        "reasoning_efforts": sorted({c["metadata"]["reasoningEffort"] for c in calls if c.get("metadata", {}).get("reasoningEffort")}),
    }


def history_cache_metrics(turns):
    """Measure body changes in recorded provider requests, not estimated cache tokens."""
    previous = None
    transitions, rewritten, retirements = 0, 0, 0
    prefix_chars = []
    for turn in turns:
        body = (turn.get("request") or {}).get("body")
        provider = json.loads(body).get("providerRequest") if body else None
        if not provider or not isinstance(provider.get("messages"), list):
            previous = None
            continue
        messages = [{"role": "system", "content": provider.get("system", "")}] + provider["messages"]
        content = [(m.get("role"), m.get("content")) for m in messages]
        historical = {}
        for _, text in content:
            if not isinstance(text, str) or not text.startswith("{"):
                continue
            try:
                header = json.loads(text.split("\n", 1)[0])
            except (json.JSONDecodeError, TypeError):
                continue
            ref = header.get("ref") if isinstance(header, dict) else None
            if isinstance(ref, dict) and ref.get("id"):
                historical[(ref.get("sessionId"), ref["id"])] = (text, header)
        if previous is not None:
            transitions += 1
            length = 0
            for (role_a, text_a), (role_b, text_b) in zip(previous[0], content):
                if role_a != role_b or not isinstance(text_a, str) or not isinstance(text_b, str):
                    break
                if text_a == text_b:
                    length += len(text_a)
                    continue
                for left, right in zip(text_a, text_b):
                    if left != right:
                        break
                    length += 1
                break
            prefix_chars.append(length)
            for ref in previous[1].keys() & historical.keys():
                if previous[1][ref][0] != historical[ref][0]:
                    rewritten += 1
                    retirements += historical[ref][1].get("reason") == "lease-expired-or-released"
        previous = (content, historical)
    return {"measured_transitions": transitions, "historical_body_rewrites": rewritten,
            "lease_retirements": retirements, "unchanged_prefix_chars": distribution(prefix_chars)}


def prompt_layout_metrics(turns):
    """Count recorded prompt text separately from raw frame partitions and tokens."""
    provider_sizes, frame_sizes, other_blocks, partitions = [], [], [], {}
    continuation_items, continuation_chars, continuation_tokens, continuation_modes = [], [], [], set()
    def text_parts(content):
        if isinstance(content, str):
            return [content], 0
        if isinstance(content, list):
            texts = [block["text"] for block in content if isinstance(block, dict) and isinstance(block.get("text"), str)]
            return texts, len(content) - len(texts)
        return [], 0 if content is None else 1
    for turn in turns:
        body = (turn.get("request") or {}).get("body")
        request = json.loads(body) if body else {}
        provider = request.get("providerRequest") or {}
        if not isinstance(provider.get("messages"), list):
            continue
        states = [message["continuation"] for message in provider["messages"]
                  if isinstance(message.get("continuation"), dict)]
        continuation_items.append(len(states))
        continuation_chars.append(sum(len(state.get("data", "")) for state in states if isinstance(state.get("data"), str)))
        continuation_tokens.append((request.get("estimate") or {}).get("opaqueTokens", 0))
        for state in states:
            if state.get("format") != "openai-responses-v1":
                continue
            try:
                mode = json.loads(state["data"]).get("reasoningContext")
                if isinstance(mode, str):
                    continuation_modes.add(mode)
            except (ValueError, TypeError, KeyError, AttributeError):
                pass
        texts, unknown = text_parts(provider.get("system"))
        for message in provider["messages"]:
            parts, count = text_parts(message.get("content"))
            texts.extend(parts)
            unknown += count
        provider_sizes.append(sum(map(len, texts)))
        other_blocks.append(unknown)
        frame_sizes.append(sum(len(part) for part in texts if part.startswith("Runtime 本帧工作内存（origin=runtime-view）")))
        for material in (request.get("request") or {}).get("materials", []):
            if material.get("origin") != "runtime-view":
                continue
            frame = json.loads(material["text"])
            for name, value in frame.get("partitions", {}).items():
                partitions.setdefault(name, []).append(len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))))
    return {"measured_requests": len(provider_sizes), "unmeasured_requests": len(turns) - len(provider_sizes),
            "provider_text_chars": distribution(provider_sizes), "working_frame_text_chars": distribution(frame_sizes),
            "non_text_blocks": distribution(other_blocks),
            "continuation": {"history_items": distribution(continuation_items),
                             "serialized_chars": distribution(continuation_chars),
                             "reserved_input_tokens": distribution(continuation_tokens),
                             "prior_response_reasoning_contexts": sorted(continuation_modes),
                             "interpretation": "Archived continuation metadata and driver capacity reservation, not separately billed tokens or proof every item was used by the provider."},
            "raw_partition_json_chars": {name: distribution(sizes) for name, sizes in partitions.items()},
            "interpretation": "Recorded Unicode character counts, not token estimates. Raw partition JSON differs from rendered prompt text; non-text payload size is not measured."}


def agent_metrics(directory):
    traces_path = directory / "agent/traces.json"
    if not traces_path.exists():
        trajectory = directory / "agent/trajectory.json"
        if not trajectory.exists():
            return None
        data = json.loads(trajectory.read_text())
        # ATIF supports portable call counts; implementation-specific context metrics remain unknown.
        return {"tool_calls": sum(len(s.get("tool_calls") or []) for s in data.get("steps", [])),
                "tool_call_scope": "atif_model_tool_calls",
                "native_operations": native_codex_operations(directory),
                "context": None,
                "environment_diagnostics": tool_environment_diagnostics([
                    (str(result.get("source_call_id") or f'{step.get("step_id")}-{index}'), result.get("content"))
                    for step in data.get("steps", [])
                    for index, result in enumerate((step.get("observation") or {}).get("results", []))])}
    data = json.loads(traces_path.read_text())
    status_path = directory / "agent/status.json"
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    sessions = [("root", data["traces"])] + [(b.get("kind"), b["turns"]) for b in data.get("branches", [])]
    turns = [t for _, session in sessions for t in session]
    invocations = {i["id"]: i for t in turns for i in t.get("invocations", [])}
    executions = {e["executionId"]: e for t in turns for e in t.get("executions", [])}
    contexts, segments, maintenance = [], [], 0
    result_frames, result_exposures, partial_exposures, reference_exposures = 0, 0, 0, 0
    omitted_results, visible_sizes, source_sizes = set(), [], []
    for kind, session in sessions:
        indices = set()
        for turn in session:
            request = json.loads(turn["request"]["body"]).get("request", {}) if (turn.get("request") or {}).get("body") else {}
            context = request.get("contextStatus") or {}
            if context:
                contexts.append(context)
            for material in request.get("materials", []):
                if material.get("origin") != "runtime-view":
                    continue
                frame = json.loads(material["text"])
                partitions = frame.get("partitions", {})
                if "recent" not in partitions:
                    continue
                result_frames += 1
                results = partitions["recent"].get("results", [])
                result_exposures += len(results)
                partial_exposures += sum(r.get("representation") == "excerpt" for r in results)
                reference_exposures += sum(r.get("bodyIncluded") is False for r in results)
                omitted_results.update(r["ref"] for r in results if r.get("omitted"))
                footprint = partitions.get("runtime", {}).get("materialStatus", {}).get("footprint", {})
                source_sizes.append(footprint.get("leasedResultSources", sum(r.get("size", {}).get("chars", 0) for r in results)))
                if "leasedResults" in footprint:
                    visible_sizes.append(footprint["leasedResults"])
            maintenance += kind == "context" or request.get("mode") == "maintenance"
            if context.get("segment", {}).get("index") is not None:
                indices.add(context["segment"]["index"])
        segments.append(max(0, len(indices) - 1))
    summaries = [i.get("summary", {}) for i in invocations.values()]
    all_rejected = [json.loads(t["decision"]["body"]) for t in turns
                if (t.get("decision") or {}).get("body") and json.loads(t["decision"]["body"]).get("status") == "rejected"]
    rejected = [r for r in all_rejected if (r.get("error") or {}).get("code") in ("SCRIPT_PROTOCOL", "PROTOCOL")]
    cancelled = [r for r in all_rejected if (r.get("error") or {}).get("code") in (20, "20", "CANCELLED", "ABORT_ERR")]
    def rejection_total(section, key, decisions=None):
        values = [(r.get(section) or {}).get(key) for r in (rejected if decisions is None else decisions)]
        return sum(values) if all(isinstance(v, (int, float)) for v in values) else None
    rejected_ms = rejection_total("timing", "modelMs")
    all_rejected_ms = rejection_total("timing", "modelMs", all_rejected)
    rejection_codes = [str((r.get("error") or {}).get("code", "unknown")) for r in all_rejected]
    response_bodies = [t["response"]["body"] for t in turns
                       if (t.get("response") or {}).get("body") and not t["response"].get("truncated")]
    control_matches = [(body, re.search(r"(?m)^@@s[0-9a-f]{32}(?:[ \t]|$)", body)) for body in response_bodies]
    shell_results = [json.loads(s["output"]) for s in summaries
                     if s.get("moduleId") == "velaros:shell" and s.get("operation") == "run"
                     and s.get("output") and not s.get("outputTruncated")]
    shell_outputs = []
    for reference, invocation in invocations.items():
        summary = invocation.get("summary") or {}
        if (summary.get("moduleId") == "velaros:shell" and summary.get("operation") == "run"
                and summary.get("output") and not summary.get("outputTruncated")):
            value = json.loads(summary["output"])
            shell_outputs.append((reference, (value.get("stdout") or "") + "\n" + (value.get("stderr") or "")))
    return {
        "turns": len(turns), "branches": len(data.get("branches", [])),
        "harness_trace_export": status.get("traceExport"),
        "environment_diagnostics": tool_environment_diagnostics(shell_outputs),
        "tool_calls": len(invocations),
        "tool_call_scope": "scriptact_host_operations",
        "failed_tool_calls": sum(s.get("status") == "failed" for s in summaries),
        "failed_shell_commands": sum(s.get("success") is False for s in shell_results),
        "shell_outputs_measured": len(shell_results),
        "shell_commands_with_stderr": sum(bool((s.get("stderr") or "").strip()) for s in shell_results),
        "successful_shell_commands_with_stderr": sum(s.get("success") is True and bool((s.get("stderr") or "").strip()) for s in shell_results),
        "script_executions": len(executions),
        "script_seconds_sum": sum((e.get("durationMs") or 0) for e in executions.values()) / 1000,
        "observed_observation_seconds": sum((t.get("timing", {}).get("observationMs") or 0) for t in turns) / 1000,
        "repair_turns": sum((t.get("repair") or 0) > 0 for t in turns),
        "protocol_rejections": len(rejected),
        "protocol_rejection_model_seconds": rejected_ms / 1000 if rejected_ms is not None else None,
        "protocol_rejection_input_tokens": rejection_total("usage", "inputTokens"),
        "protocol_rejection_output_tokens": rejection_total("usage", "outputTokens"),
        "response_rejections": {"total": len(all_rejected), "protocol": len(rejected), "cancelled": len(cancelled),
            "other": len(all_rejected) - len(rejected) - len(cancelled),
            "by_error_code": {code: rejection_codes.count(code) for code in sorted(set(rejection_codes))},
            "model_seconds": all_rejected_ms / 1000 if all_rejected_ms is not None else None,
            "input_tokens": rejection_total("usage", "inputTokens", all_rejected),
            "output_tokens": rejection_total("usage", "outputTokens", all_rejected)},
        "response_control": {
            "measured_responses": len(response_bodies),
            "unmeasured_responses": len(turns) - len(response_bodies),
            "responses_without_marker": sum(match is None for _, match in control_matches),
            "leading_narration_chars": distribution([match.start() for _, match in control_matches if match]),
            "total_response_chars": sum(len(body) for body in response_bodies),
        },
        "context": {
            "history_cache": [history_cache_metrics(session) for _, session in sessions],
            "prompt_layout": prompt_layout_metrics(turns),
            "maintenance_model_calls": maintenance, "observed_segment_transitions": sum(segments),
            "input_limits": sorted({c["inputLimit"] for c in contexts if "inputLimit" in c}),
            "peak_estimated_tokens": max((c["inputTokens"] for c in contexts if "inputTokens" in c), default=None),
            "pressure_frames": sum(c.get("pressure") not in (None, "normal") for c in contexts),
            "observed_prepare_seconds": sum((t.get("timing", {}).get("contextMs") or 0) for t in turns) / 1000,
            "preparation_measurements_missing": sum(t.get("timing", {}).get("contextMs") is None for t in turns),
            "result_visibility": {
                "frames": result_frames, "exposures": result_exposures,
                "partial_exposures": partial_exposures, "reference_only_exposures": reference_exposures,
                "unique_results_with_omissions": len(omitted_results),
                "peak_visible_leased_chars": max(visible_sizes, default=None),
                "peak_source_leased_chars": max(source_sizes, default=None),
            } if result_frames else None,
        },
    }


def aggregate_trials(trials):
    successful = [t for t in trials if t["score"] == 1]
    calls = [t["metrics"] for t in trials]
    all_cost_known = bool(trials) and all(m["unknown_cost_requests"] == 0 for m in calls)
    cost = sum(m["known_cost_usd"] for m in calls)
    def sum_known(key):
        values = [m[key] for m in calls]
        return sum(values) if values and all(v is not None for v in values) else None
    def component_total(key):
        values = [m["cost_components_usd"][key] for m in calls]
        return sum(values) if values and all(v is not None for v in values) else None
    inputs, reads = sum_known("input_tokens"), sum_known("cache_read_tokens")
    return {
        "successes": len(successful), "known_cost_usd": cost, "all_cost_known": all_cost_known,
        "clean_successes": sum(not t["exception"] for t in successful),
        "cost_components_usd": {key: component_total(key) for key in COST_COMPONENTS},
        "spend_per_success_usd": cost / len(successful) if all_cost_known and successful else None,
        "agent_seconds_all_attempts": distribution([t["agent_seconds"] for t in trials]),
        "agent_seconds_successful": distribution([t["agent_seconds"] for t in successful]),
        "input_tokens": inputs, "output_tokens": sum_known("output_tokens"),
        "reasoning_tokens": sum_known("reasoning_tokens"), "cache_read_tokens": reads,
        "cache_write_tokens": sum_known("cache_write_tokens"),
        "cache_token_hit_rate": reads / inputs if inputs and reads is not None else None,
        "model_requests": sum(m["requests"] for m in calls),
    }


def compare_jobs(reference, candidate):
    """Use equal task weights and only jointly solved tasks for efficiency.

    All attempts remain in each job's aggregate. Successful-attempt efficiency
    is conditional evidence, not a replacement for reliability or total spend.
    """
    def successful_by_task(job):
        grouped = {}
        for trial in job["trials"]:
            if trial["score"] == 1 and not trial["exception"]:
                grouped.setdefault(trial["task"], []).append(trial)
        return grouped

    def mean_known(values):
        return statistics.mean(values) if values and all(v is not None for v in values) else None

    left, right = successful_by_task(reference), successful_by_task(candidate)
    rows = []
    for task in sorted(left.keys() & right.keys()):
        row = {"task": task}
        for side, trials in (("reference", left[task]), ("candidate", right[task])):
            costs = [t["metrics"]["known_cost_usd"] if t["metrics"]["unknown_cost_requests"] == 0 else None for t in trials]
            row[side] = {"successful_attempts": len(trials),
                         "model_requests": mean_known([t["metrics"].get("requests") for t in trials]),
                         "agent_seconds": mean_known([t["agent_seconds"] for t in trials]),
                         "cost_usd": mean_known(costs)}
        rows.append(row)
    means = {side: {metric: mean_known([r[side][metric] for r in rows])
                    for metric in ("model_requests", "agent_seconds", "cost_usd")}
             for side in ("reference", "candidate")}
    ratios = {}
    for metric in ("model_requests", "agent_seconds", "cost_usd"):
        denominator, numerator = means["reference"][metric], means["candidate"][metric]
        ratios[metric] = numerator / denominator if denominator and numerator is not None else None
    return {"reference": reference["job"], "candidate": candidate["job"],
            "complete": all(j["planned"] is not None and j["completed"] == j["planned"] for j in (reference, candidate)),
            "same_task_set": {t["task"] for t in reference["trials"]} == {t["task"] for t in candidate["trials"]},
            "jointly_solved_tasks": len(rows), "successful_task_means": means,
            "candidate_over_reference": ratios, "tasks": rows,
            "interpretation": "descriptive only; conditional on verified success without a runtime exception; task weights equal; small samples do not establish superiority"}
