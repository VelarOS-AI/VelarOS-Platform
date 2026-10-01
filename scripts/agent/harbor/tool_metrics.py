"""Tool usage by recorded layer. Missing lifecycle evidence is unknown, never zero."""
import datetime
import math
import statistics


def _duration(start, finish):
    if not isinstance(start, str) or not isinstance(finish, str):
        return None
    try:
        value = (datetime.datetime.fromisoformat(finish) - datetime.datetime.fromisoformat(start)).total_seconds()
        return value if value >= 0 else None
    except (ValueError, TypeError):
        return None


def _distribution(values):
    values = sorted(value for value in values if value is not None)
    return {"count": len(values), "sum": sum(values), "p50": statistics.median(values),
            "p95": values[math.ceil(len(values) * .95) - 1], "max": values[-1]} if values else None


def operation_statistics(records, scope):
    """Input records contain measurement fields only, never argument/output contents."""
    groups = {}
    for record in records:
        key = (record["module"], record["operation"])
        groups.setdefault(key, []).append(record)
    rows = []
    for (module, operation), calls in sorted(groups.items()):
        statuses = {status: sum(call["status"] == status for call in calls)
                    for status in ("pending", "succeeded", "failed", "cancelled", "unknown")}
        rows.append({"module": module, "operation": operation, "calls": len(calls),
            "statuses": statuses,
            "started": sum(call["started"] is True for call in calls),
            "not_started": sum(call["started"] is False for call in calls),
            "started_unknown": sum(call["started"] is None for call in calls),
            "duration_seconds": _distribution([call["duration_seconds"] for call in calls]),
            "duration_unknown": sum(call["duration_seconds"] is None for call in calls),
            "effects": {effect: sum(call.get("effect") == effect for call in calls)
                        for effect in ("none", "committed", "partial", "unknown")},
            "discovery": module == "velaros:modules" or (module == "velaros:system" and operation.startswith("modules.")),
            "explicit_retries": sum(bool(call.get("retry_of")) for call in calls),
            "retry_evidence_unknown": sum(call.get("retry_of") is None for call in calls)})
    return {"schema": 1, "scope": scope, "calls": len(records), "operations": rows,
            "module_calls": {module: sum(row["calls"] for row in rows if row["module"] == module) for module in sorted({row["module"] for row in rows})},
            "records": records,
            "interpretation": "Counts are deduplicated within their recorded layer. Kernel duration includes handler adapter and effect-gate wait; it is not physical I/O time. Absent timestamps, retry links and native completion remain unknown. Costs are accounted per model request, not attributed to individual tools."}


def scriptact_operations(invocations):
    records = []
    for key, invocation in invocations.items():
        raw = invocation.get("parsed") or {}
        prepared = raw.get("prepared") or {}
        receipt = raw.get("receipt") or {}
        summary = invocation.get("summary") or {}
        life = receipt.get("lifecycle") or {}
        # Complete receipt lifecycle proves absence of handler entry; a pending record cannot.
        started = True if life.get("startedAt") else False if life.get("settledAt") else None
        status = summary.get("status", "unknown")
        if status not in ("pending", "succeeded", "failed", "cancelled"):
            status = "unknown"
        records.append({"id": str(key), "session_id": invocation.get("sessionId") or prepared.get("sessionId"),
            "execution_id": invocation.get("executionId") or prepared.get("executionId"),
            "module": summary.get("moduleId") or (prepared.get("binding") or {}).get("moduleId") or "unknown",
            "operation": summary.get("operation") or prepared.get("operation") or "unknown",
            "status": status, "effect": summary.get("effect", "unknown"),
            "started": started, "duration_seconds": _duration(life.get("startedAt"), life.get("settledAt")),
            "retry_of": receipt.get("retryOf")})
    return operation_statistics(records, "scriptact_kernel_invocations")


def atif_operations(data):
    calls = {}
    for step_index, step in enumerate(data.get("steps", [])):
        for index, call in enumerate(step.get("tool_calls") or []):
            identifier = call.get("tool_call_id") or f"step-{step_index}-{index}"
            key = (data.get("session_id", "root"), identifier)
            # ATIF's observations do not universally encode terminal tool success.
            calls[key] = {"id": str(key), "session_id": data.get("session_id"), "execution_id": None,
                "module": "model-tools", "operation": call.get("function_name") or "unknown",
                "status": "unknown", "effect": "unknown", "started": None,
                "duration_seconds": None, "retry_of": None}
    return operation_statistics(list(calls.values()), "atif_model_tool_calls")


def aggregate_tool_usage(trials):
    groups = {}
    measured = 0
    for trial in trials:
        metrics = trial.get("agent_metrics") or {}
        usages = [metrics.get("tool_usage"), (metrics.get("native_operations") or {}).get("tool_usage")]
        if not any(usages):
            continue
        measured += 1
        for usage in filter(None, usages):
            for row in usage["operations"]:
                key = (usage["scope"], row["module"], row["operation"])
                entry = groups.setdefault(key, {"scope": key[0], "module": key[1], "operation": key[2],
                    "calls": 0, "attempts": 0, "tasks": set(), "statuses": {}})
                entry["calls"] += row["calls"]
                entry["attempts"] += 1
                entry["tasks"].add(trial["task"])
                for status, count in row["statuses"].items():
                    entry["statuses"][status] = entry["statuses"].get(status, 0) + count
    return {"measured_attempts": measured, "unknown_attempts": len(trials) - measured,
        "operations": [{**entry, "tasks": sorted(entry["tasks"]), "task_coverage": len(entry["tasks"])}
                       for _, entry in sorted(groups.items())]}


def tool_usage_markdown(jobs):
    lines = ["", "## 工具模块使用统计", "",
        "按实际记录层级分别统计；发现模块和真正调用模块分开。缺少原始记录表示未知，调用次数不用于替代模型请求数或任务成绩。耗时分布与逐次关联 ID 保存在 JSON；调用方取消不等于底层操作已经结束。", "",
        "| 批次 | 记录层级 | 模块 / 操作 | 次数 | 涉及任务 | 成功 / 失败 / 取消 / 在途 / 未知 |",
        "|---|---|---|---:|---:|---|"]
    for job in jobs:
        usage = job.get("source_tool_usage") or job.get("aggregate", {}).get("tool_usage") or {}
        for row in usage.get("operations", []):
            statuses = row["statuses"]
            counts = " / ".join(str(statuses.get(status, 0)) for status in ("succeeded", "failed", "cancelled", "pending", "unknown"))
            lines.append(f'| {job["job"]} | {row["scope"]} | {row["module"]}.{row["operation"]} | {row["calls"]} | {row["task_coverage"]} | {counts} |')
        if usage.get("unknown_attempts"):
            lines += ["", f'{job["job"]}：{usage["unknown_attempts"]} 次尝试没有可用工具轨迹。']
    return lines
