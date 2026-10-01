"""Summarize completed Harbor trials without hiding errors or incomplete runs."""

import argparse
import datetime
import json
from pathlib import Path

from metrics import aggregate_trials, agent_metrics, compare_jobs, environment_evidence, pricing_basis_metrics, request_metrics, trial_infrastructure_issue
from tool_metrics import tool_usage_markdown
from request_identity import attributed_requests, legacy_requests, validate_request_ledger, verify_unique_attribution
from pricing import cost_comparison


def duration(phase):
    if not phase or not phase.get("started_at") or not phase.get("finished_at"):
        return None
    return (datetime.datetime.fromisoformat(phase["finished_at"]) - datetime.datetime.fromisoformat(phase["started_at"])).total_seconds()


def settlement_tail(calls, cleanup_at):
    """Provider accounting can outlive container cleanup after cancellation."""
    if not cleanup_at or any(not call.get("finishedAt") for call in calls):
        return None
    cleanup = datetime.datetime.fromisoformat(cleanup_at)
    return max([0.0, *[(datetime.datetime.fromisoformat(call["finishedAt"]) - cleanup).total_seconds() for call in calls]])


def codex_execution_status(directory):
    """Native terminal events can reveal failures hidden by historical shell wrappers."""
    path = directory / "agent/codex.txt"
    if not path.exists():
        return None
    status, message, errors, failures = "unconfirmed", None, 0, 0
    with path.open(errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") == "error":
                errors += 1
            elif event.get("type") == "turn.failed":
                status, failures = "failed", failures + 1
                error = event.get("error")
                message = error.get("message") if isinstance(error, dict) else None
            elif event.get("type") == "turn.completed":
                status, message = "completed", None
    return {"status": status, "message": message, "error_events": errors,
            "failed_turn_events": failures, "evidence": str(path.resolve())}


def finish_summary(metadata, planned, trials, pending):
    return {**metadata, "planned": planned, "completed": len(trials), "pending": pending,
            "unstarted": max(0, planned - len(trials) - len(pending)) if planned is not None else None,
            "mean_score": sum(t["score"] for t in trials) / len(trials) if trials and len(trials) == planned else None,
            "completed_mean_score": sum(t["score"] for t in trials) / len(trials) if trials else None,
            "errors": sum(t["exception"] is not None for t in trials),
            "infrastructure_issues": sum(t["infrastructure_issue"] is not None for t in trials),
            "aggregate": aggregate_trials(trials), "trials": trials}


def summarize(job, requests, tasks=None):
    validate_request_ledger(requests)
    config = json.loads((job / "config.json").read_text())
    lock_file = job / "lock.json"
    def selected(task):
        return not tasks or Path(task.get("path") or task.get("name") or "").name in tasks
    planned = sum(selected(t["task"]) for t in json.loads(lock_file.read_text())["trials"]) if lock_file.exists() else None
    trials = []
    pending = []
    legacy_windows = []
    for directory in sorted(job.iterdir()):
        if not directory.is_dir() or not (directory / "config.json").exists():
            continue
        trial_config = json.loads((directory / "config.json").read_text())
        if not selected(trial_config.get("task", {})):
            continue
        path = directory / "result.json"
        if not path.exists():
            pending.append(directory.name)
            continue
        result = json.loads(path.read_text())
        trial_log = directory / "trial.log"
        rewards = (result.get("verifier_result") or {}).get("rewards") or {}
        exception = result.get("exception_info") or {}
        reported_exception = exception.get("exception_type")
        native = codex_execution_status(directory)
        if not reported_exception and native and native["status"] != "completed":
            exception = {"exception_type": "CodexTurnFailed" if native["status"] == "failed" else "CodexCompletionUnconfirmed",
                         "exception_message": native["message"] or "Codex native log does not confirm successful completion"}
        execution = result.get("agent_execution") or {}
        seconds = None
        owned_calls, attribution = attributed_requests(job, directory, result, config, requests)
        calls = owned_calls if owned_calls is not None else []
        post_agent_calls = []
        if execution.get("started_at") and execution.get("finished_at"):
            start = datetime.datetime.fromisoformat(execution["started_at"])
            finish = datetime.datetime.fromisoformat(execution["finished_at"])
            seconds = (finish - start).total_seconds()
            # Historical serial evidence retains its original teardown window.
            # Signed attempt requests include late provider settlement independently of time.
            trial_finish = datetime.datetime.fromisoformat(result["finished_at"]) if result.get("finished_at") else finish
            if owned_calls is None:
                if any(start < end and begin < trial_finish for begin, end in legacy_windows):
                    raise ValueError("Overlapping legacy trials have ambiguous request attribution")
                legacy_windows.append((start, trial_finish))
                calls = legacy_requests(job, directory, requests, start, trial_finish)
            post_agent_calls = [r for r in calls if datetime.datetime.fromisoformat(r["startedAt"]) > finish]
        context = result.get("agent_result") or {}
        verifier_log = directory / "verifier/test-stdout.txt"
        verifier_output = verifier_log.read_text(errors="replace") if verifier_log.exists() else ""
        infrastructure_issue = trial_infrastructure_issue(result, verifier_output)
        trials.append({
            "task": result["task_name"], "trial": result["trial_name"],
            "reward": rewards.get("reward"), "score": rewards.get("reward", 0),
            "exception": exception.get("exception_type"),
            "error": exception.get("exception_message"),
            "reported_exception": reported_exception,
            "native_execution": native,
            "infrastructure_issue": infrastructure_issue,
            "agent_seconds": seconds,
            "trial_seconds": duration(result),
            "environment_seconds": duration(result.get("environment_setup")),
            "setup_seconds": duration(result.get("agent_setup")),
            "verifier_seconds": duration(result.get("verifier")),
            "metrics": request_metrics(calls),
            "request_attribution": {**attribution, "request_ids": [r["id"] for r in calls if r.get("id")]},
            "agent_metrics": agent_metrics(directory),
            "reported_cost_usd": context.get("cost_usd"),
            "cost_comparison": cost_comparison(context.get("cost_usd"), calls),
            "gateway_requests": len(calls),
            "gateway_known_cost_usd": sum(r["estimatedUsd"] or 0 for r in calls),
            "gateway_unknown_requests": sum(r["estimatedUsd"] is None for r in calls),
            "post_agent_requests": len(post_agent_calls),
            "post_agent_request_ids": [r["id"] for r in post_agent_calls],
            "post_agent_metrics": request_metrics(post_agent_calls),
            "provider_settlement_seconds_after_cleanup": settlement_tail(calls, result.get("finished_at")),
            "agent_version": (result.get("agent_info") or {}).get("version"),
            "runtime_options": ((context.get("metadata") or {}).get("source") or {}).get("runtimeOptions"),
            "environment": environment_evidence(trial_config, trial_log.read_text(errors="replace") if trial_log.exists() else ""),
            "dataset_commit": (result.get("task_id") or {}).get("git_commit_id"),
            "result": str(path.resolve()),
        })
    return finish_summary({"job": job.name, "models": sorted({a["model_name"] for a in config.get("agents", []) if a.get("model_name")}),
            "scope_tasks": sorted(tasks) if tasks else None,
            "agent_names": [a.get("name") for a in config.get("agents", [])],
            "configurations": [{"options": {k: v for k, v in a.get("kwargs", {}).items()
                                             if k in ("bundle", "version", "reasoning_effort", "config", "use_responses_api", "model_info")},
                                "dependency_index": a.get("env", {}).get("UV_INDEX_URL")}
                               for a in config.get("agents", [])],
            "concurrency": config.get("n_concurrent_trials")}, planned, trials, pending)


def summarize_cohort(manifest, jobs_root, requests):
    """Apply fixed single-attempt sources; never replace a failed trial based on its score."""
    declared = manifest["tasks"]
    if not declared or len(set(declared)) != len(declared):
        raise ValueError("Cohort tasks must be a nonempty unique list")
    if not manifest["participants"]:
        raise ValueError("Cohort participants must be nonempty")
    summaries = []
    for participant in manifest["participants"]:
        selected = [task for source in participant["sources"] for task in source["tasks"]]
        if len(selected) != len(declared) or set(selected) != set(declared):
            raise ValueError("Each participant must declare exactly one source for each cohort task")
        sources, trials, pending, configs, agents, models = [], [], [], [], set(), set()
        for source in participant["sources"]:
            name = source["job"]
            if not name or name in (".", "..") or Path(name).name != name:
                raise ValueError("Cohort source must be a job directory name")
            job = jobs_root / name
            if not (job / "config.json").exists() or not (job / "lock.json").exists():
                sources.append({"job": name, "tasks": source["tasks"], "started": False})
                continue
            data = summarize(job, requests, set(source["tasks"]))
            if data["planned"] != len(source["tasks"]):
                raise ValueError("Cohort requires one planned attempt per declared source task")
            observed_tasks = [trial["task"] for trial in data["trials"]]
            if len(set(observed_tasks)) != len(observed_tasks):
                raise ValueError("Cohort source contains duplicate attempts")
            if any(model.split("/")[-1] != manifest["model"] for model in data["models"]):
                raise ValueError("Cohort source model differs from the frozen model")
            for trial in data["trials"]:
                if trial["dataset_commit"] != manifest["dataset_commit"]:
                    raise ValueError("Cohort source dataset revision differs or is unknown")
                trials.append({**trial, "source_job": name})
            pending.extend(name + "/" + trial for trial in data["pending"])
            configs.extend(data["configurations"])
            agents.update(data["agent_names"])
            models.update(data["models"])
            sources.append({"job": name, "tasks": source["tasks"], "started": True,
                            "completed": data["completed"], "planned": data["planned"],
                            "concurrency": data["concurrency"]})
        summaries.append(finish_summary({
            "job": participant["name"], "models": sorted(models), "agent_names": sorted(agents, key=str),
            "configurations": configs, "scope_tasks": sorted(declared),
            "source_jobs": sources, "concurrency": None,
        }, len(declared), trials, pending))
    verify_unique_attribution(summaries)
    return summaries


def pricing_basis_markdown(pricing):
    """Shared first-read explanation for trial reports and live campaign reports."""
    if not pricing:
        return []
    kinds = {group["kind"] for _, basis in pricing for group in basis["groups"]}
    explanation = ("参考价格估算，实际扣费未知。" if "reference_only" in kinds
                   else "按冻结费率估算，实际扣费未知。")
    lines = [explanation + "美元列、缓存净节省及费用比均表示估算。", "",
             "价格依据按来源分列；混合依据的总值不代表实际供应商扣费。", "",
             "| 范围 | 价格依据 | 来源 | 上游 | 请求数 | 已知估算美元 | 未知估算请求 |",
             "|---|---|---|---|---:|---:|---:|"]
    labels = {"reference_only": "参考价格估算", "provider_rates": "供应商费率估算",
              "legacy_unspecified": "历史记录未声明"}
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")
    for name, basis in pricing:
        for group in basis["groups"]:
            lines.append(f'| {cell(name)} | {labels[group["kind"]]} | {cell(group["source"])} | {cell(group.get("upstream_base_url", "—"))} | {group["requests"]} | {group["known_estimated_cost_usd"]:.6f} | {group["unknown_estimate_requests"]} |')
    return lines


def markdown(report):
    models = ", ".join(sorted({model for job in report["jobs"] for model in job["models"]}))
    lines = ["# ScriptAct 评测", "", f"实际模型：{models}。推理档位与并发以原始 config.json、网关请求 metadata 为准。", "",
             "官方判分与运行异常分别保留，无判分的尝试计零。模型请求数、完成耗时和整次任务费用是效率指标，请求数与费用包含失败尝试。缓存命中率为读取缓存 token 总量 / 输入 token 总量，用于诊断。空缺表示数据不足。小样本结果不代表总体领先。", "",
             "| 批次 | 完成/计划 | 通过 | 模型请求总数 | agent 耗时中位数 | 已知费用 | 每次成功总摊销美元 |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    if report.get("scope_tasks"):
        lines.insert(4, "本表限定预先声明的任务组：" + ", ".join(report["scope_tasks"]) + "。其他任务仍保留在全量报告与原始 job 中。")
        lines.insert(5, "")
    if report.get("cohort"):
        lines[4:4] = ["本报告按事先固定的 job/任务来源组成补充对照。原始启动失败及所有尝试的费用继续保留在全量报告中；此表不替代原始整组成绩，也不是官方排行榜提交。", ""]
    protocols = {json.dumps({key: trial["environment"].get(key) for key in (
        "type", "import_path", "setup_sha256", "ca_sha256", "uv_sha256", "cancellation_sha256")}, sort_keys=True)
        for job in report["jobs"] for trial in job["trials"]}
    if len(protocols) > 1:
        lines[4:4] = ["本表包含不同或历史记录不完整的执行环境；逐题环境类与源码哈希见运行配置。环境差异可能影响超时、耗时和后续请求费用，跨协议结果只作补充证据，不能单独归因为 agent 改进。", ""]
    def number(value, precision=3):
        return "—" if value is None else f"{value:.{precision}f}"
    for job in report["jobs"]:
        a = job["aggregate"]
        seconds = (a["agent_seconds_all_attempts"] or {}).get("p50")
        lower_bound = "≥" if not a["all_cost_known"] else ""
        lines.append(f'| {job["job"]} | {job["completed"]}/{job["planned"]} | {a["successes"]} | {a["model_requests"]} | {number(seconds, 1)} s | {lower_bound}${number(a["known_cost_usd"])} | {number(a["spend_per_success_usd"])} |')
    lines += ["", "## 费用构成", "", "费用以归属明确的网关请求账本为准，按每次请求冻结的单价核算，单位为美元；输出包含推理 token。用量或单价缺失时保持未知。适配器自报金额保留在 reported_cost_usd，对账依据与差异保留在 cost_comparison。", "",
              "| 批次 | 普通输入 | 缓存读取 | 缓存写入 | 输出 |", "|---|---:|---:|---:|---:|"]
    for job in report["jobs"]:
        part = job["aggregate"]["cost_components_usd"]
        lines.append(f'| {job["job"]} | {number(part["uncached_input"], 4)} | {number(part["cached_input"], 4)} | {number(part["cache_write"], 4)} | {number(part["output"], 4)} |')
    pricing = [(job["job"], job["aggregate"]["pricing_basis"]) for job in report["jobs"]
               if job["aggregate"].get("pricing_basis")]
    if (report.get("campaign") or {}).get("pricing_basis"):
        pricing.append(("完整账本", report["campaign"]["pricing_basis"]))
    if pricing:
        lines[4:4] = pricing_basis_markdown(pricing) + [""]
    differences = [(job["job"], trial) for job in report["jobs"] for trial in job["trials"]
                   if (trial.get("cost_comparison") or {}).get("matches") is False]
    if differences:
        lines += ["", "| 费用对账 / 任务 | 适配器原值美元 | 网关账本美元 | 原值减网关美元 |", "|---|---:|---:|---:|"]
        for job, trial in differences:
            comparison = trial["cost_comparison"]
            lines.append(f'| {job} / {trial["task"]} | {number(comparison["reported_cost_usd"], 8)} | {number(comparison["gateway_cost_usd"], 8)} | {number(comparison["reported_minus_gateway_usd"], 8)} |')
    lines += ["", "## 逐题证据", "", "| 批次 / 任务 | 分数 | agent 秒 | 已知费用 | 模型调用 | 输入 / 输出 token | 缓存命中率 | 输入峰值 | 异常 |", "|---|---:|---:|---:|---:|---:|---:|---:|---|"]
    for job in report["jobs"]:
        for trial in job["trials"]:
            m = trial["metrics"]
            hit = m["cache_token_hit_rate"]
            issue = trial["infrastructure_issue"] or trial["exception"] or "—"
            if trial["post_agent_requests"]:
                issue += f'; agent 阶段结束后仍有 {trial["post_agent_requests"]} 次请求'
            diagnostics = ((trial.get("agent_metrics") or {}).get("environment_diagnostics") or {}).get("issues", [])
            for diagnostic in diagnostics:
                issue += '; 工具回执观察到 ' + diagnostic["kind"]
            lines.append(f'| {job["job"]} / {trial["task"]} | {trial["score"]} | {number(trial["agent_seconds"], 1)} | ${number(m["known_cost_usd"])} | {m["requests"]} | {m["input_tokens"]} / {m["output_tokens"]} | {number(hit * 100 if hit is not None else None, 1)}% | {m["peak_input_tokens"]} | {issue} |')
    if report.get("comparisons"):
        lines += ["", "## 共同成功任务的效率", "", "只比较双方判分通过且无运行异常的尝试，按任务等权，重复尝试先在题内取均值。比值为后者 / 前者，小于 1 表示后者在该指标上较低；须同时看上面的全部判分、异常、请求数和总成本。请求数、耗时与费用逐项比较，单项下降不能代替整体效率结论。", "",
                  "| 前者 → 后者 | 批次完整 | 共同成功题数 | 请求数比 | 耗时比 | 费用比 |", "|---|---|---:|---:|---:|---:|"]
        for comparison in report["comparisons"]:
            ratios = comparison["candidate_over_reference"]
            lines.append(f'| {comparison["reference"]} → {comparison["candidate"]} | {comparison["complete"]} | {comparison["jointly_solved_tasks"]} | {number(ratios.get("model_requests"))} | {number(ratios["agent_seconds"])} | {number(ratios["cost_usd"])} |')
    lines += ["", "## 缓存与上下文", "", "工作帧记录实际提示中的文本字符数；图片等非文本负载另计块数，字符数不等于 token。各分区原始 JSON 大小保留在 JSON 报告中。", "", "| 批次 / 任务 | 缓存读 / 写 token | 缓存净节省美元 | 实际上下文输入限制 | 工作帧峰值字符 | 维护 / 封段 | 协议修复 | 未知费用请求 |", "|---|---:|---:|---|---:|---:|---:|---:|"]
    for job in report["jobs"]:
        for trial in job["trials"]:
            m, agent = trial["metrics"], trial["agent_metrics"] or {}
            context = agent.get("context") or {}
            limits = ", ".join(map(str, context.get("input_limits", []))) or "—"
            maintenance = context.get("maintenance_model_calls")
            transitions = context.get("observed_segment_transitions")
            frame_chars = ((context.get("prompt_layout") or {}).get("working_frame_text_chars") or {}).get("max")
            lines.append(f'| {job["job"]} / {trial["task"]} | {number(m["cache_read_tokens"], 0)} / {number(m["cache_write_tokens"], 0)} | {number(m["cache_net_savings_usd"])} | {limits} | {number(frame_chars, 0)} | {number(maintenance, 0)} / {number(transitions, 0)} | {number(agent.get("repair_turns"), 0)} | {m["unknown_cost_requests"]} |')
    lines += ["", "工具调用按 JSON 的 tool_call_scope 标明层级：ScriptAct 为底层能力操作，ATIF 为外层模型工具调用；Codex 原生命令及文件修改操作另列 native_operations，各层不直接互比。完整模型请求数由网关计量。", "", "## 运行配置", ""]
    for job in report["jobs"]:
        lines.append(f'- {job["job"]}：`{json.dumps(job["configurations"], ensure_ascii=False)}`')
        if job.get("source_jobs"):
            lines.append(f'  固定来源：`{json.dumps(job["source_jobs"], ensure_ascii=False)}`')
        environments = sorted({json.dumps(t["environment"], ensure_ascii=False, sort_keys=True) for t in job["trials"]})
        for environment in environments:
            lines.append(f'  环境记录：`{environment}`')
    lines += ["", "模型请求耗时、首个正文/推理延迟、缓存写入量、上下文整理、工具错误与异常详情见同名 JSON。首包延迟按流式、非流式及未知传输分别统计；非流式首包通常包含整段生成时间，不能当作流式首 token 延迟比较。各 agent 的上下文策略按真实配置记录；缺失的内部指标不填零。", ""]
    lines += tool_usage_markdown(report["jobs"])
    if pricing:
        lines = [line.replace("已知费用", "已知估算").replace("每次成功总摊销美元", "每次成功估算摊销美元")
                 .replace("缓存净节省美元", "缓存净节省估算美元").replace("| 费用比 |", "| 估算费用比 |") for line in lines]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("jobs", nargs="*", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--task", action="append", help="Report a predeclared task group, preserving its planned/pending counts")
    parser.add_argument("--cohort", type=Path, help="Frozen participant/job/task sources for a supplementary comparison")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    if bool(args.jobs) == bool(args.cohort) or (args.cohort and args.task):
        parser.error("Provide either jobs (with optional --task) or one --cohort manifest")
    cohort = json.loads(args.cohort.read_text()) if args.cohort else None
    budget_file = root / ".velaros-workspace/bench/campaign/budget.json"
    budget = json.loads(budget_file.read_text())
    report = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope_tasks": sorted(cohort["tasks"]) if cohort else sorted(set(args.task)) if args.task else None,
        "cohort": {"manifest": str(args.cohort.resolve()), "definition": cohort} if cohort else None,
        "campaign": {
            **pricing_basis_metrics(budget["requests"]),
            "limit_usd": budget["limitUsd"],
            "estimated_known_cost_usd": sum(r["estimatedUsd"] or 0 for r in budget["requests"]),
            "committed_upper_usd": sum(r["budgetUsd"] for r in budget["requests"]),
            "unknown_requests": sum(r["estimatedUsd"] is None for r in budget["requests"]),
            "requests": len(budget["requests"]),
        },
        "jobs": summarize_cohort(cohort, root / ".velaros-workspace/bench/jobs", budget["requests"]) if cohort
                else [summarize(path, budget["requests"], set(args.task) if args.task else None) for path in args.jobs],
    }
    verify_unique_attribution(report["jobs"])
    report["comparisons"] = [compare_jobs(report["jobs"][0], job) for job in report["jobs"][1:]]
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
        args.output.with_suffix(".md").write_text(markdown(report))
    print(rendered)


if __name__ == "__main__":
    main()
