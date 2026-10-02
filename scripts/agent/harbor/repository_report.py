"""Join source-run efficiency to the official fresh-sandbox replay score."""

import argparse
import datetime
import hashlib
import json
import re
from pathlib import Path

from metrics import compare_jobs, trial_infrastructure_issue
from report import complete_attempt_seconds, context_diagnostics_markdown, duration, finish_summary, summarize
from task_exposure import task_exposure
from request_identity import validate_identity, verify_unique_attribution
from tool_metrics import aggregate_tool_usage, tool_usage_markdown


def image_selection_coverage(manifest):
    """Keep unavailable images and unchecked tasks visible outside agent score denominators."""
    evidence = manifest.get("image_selection_evidence")
    if not evidence:
        return None
    raw = Path(evidence["file"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != evidence["sha256"]:
        raise ValueError("Image selection evidence changed")
    checks = json.loads(raw)
    selection_raw = Path(checks["source_manifest"]).read_bytes()
    identity = hashlib.sha256(selection_raw).hexdigest()
    if identity != checks["source_sha256"] or identity != manifest["selection_sha256"]:
        raise ValueError("Validation selection changed")
    tasks = json.loads(selection_raw)["validation_tasks"]
    rows = checks["rows"]
    checked = [row["task"] for row in rows]
    if len(set(checked)) != len(checked) or any(task not in tasks for task in checked):
        raise ValueError("Image checks do not match the validation selection")
    if any(row["selection_position"] != tasks.index(row["task"]) for row in rows):
        raise ValueError("Image selection position differs")
    resolved = [row["task"] for row in rows if row["status"] == "resolved"]
    scheduled = list(dict.fromkeys(row["task"] for row in manifest["attempts"]))
    if any(task not in resolved for task in scheduled):
        raise ValueError("Scheduled task has no resolved image manifest")
    issues = [{key: row[key] for key in ("task", "status", "http_status", "registry_error_codes") if key in row}
        for row in rows if row["status"] != "resolved"]
    return {"validation_task_count": len(tasks), "scheduled_task_count": len(scheduled),
        "checked_image_count": len(checked), "resolved_image_manifest_count": len(resolved),
        "image_issues": issues, "unchecked_tasks": [task for task in tasks if task not in checked],
        "interpretation": "Image availability checks are separate from agent results. Resolved registry metadata does not prove the full image is installed. Scores cover only the scheduled tasks."}


def comparison_manifest(manifest):
    """Use the predeclared reference attempts, never select sources by their score."""
    if not manifest.get("reference_manifest"):
        return manifest
    raw = Path(manifest["reference_manifest"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest["reference_manifest_sha256"]:
        raise ValueError("Reference manifest changed")
    reference = json.loads(raw)
    for key in ("model", "reasoning_effort", "dataset_revision", "trial_concurrency",
                "source_phase_seconds", "agent_budget_seconds", "dependencies", "vm",
                "files_sha256", "official_replay_sha256", "network_helper", "execution_env"):
        if manifest.get(key) != reference.get(key):
            raise ValueError("Reference protocol differs: " + key)
    sources = manifest["reference_sources"]
    if not sources or any(row not in reference["attempts"] for row in sources):
        raise ValueError("Selected source is not a frozen reference attempt")
    names = list(dict.fromkeys(row["participant"] for row in sources))
    if set(names) & set(manifest["participants"]):
        raise ValueError("Reference and candidate participant names overlap")
    participants = {**{name: reference["participants"][name] for name in names}, **manifest["participants"]}
    attempts = sources + manifest["attempts"]
    for key in ("source_job", "replay_job"):
        values = [row[key] for row in attempts]
        if len(values) != len(set(values)):
            raise ValueError("Duplicate comparison " + key)
    task_set = sorted(row["task"] for row in sources if row["participant"] == names[0])
    for participant in participants:
        if sorted(row["task"] for row in attempts if row["participant"] == participant) != task_set:
            raise ValueError("Comparison participants must use the same task set")
    for task in task_set:
        if manifest["tasks"][task] != reference["tasks"][task]:
            raise ValueError("Reference task identity differs: " + task)
    return {**manifest, "participants": participants, "attempts": attempts}


def timing_seconds(start, finish):
    """Receipt wall time requires ordered, timezone-aware clocks; unknown stays unknown."""
    try:
        first, last = datetime.datetime.fromisoformat(start), datetime.datetime.fromisoformat(finish)
        if first.utcoffset() is None or last.utcoffset() is None or last < first:
            return None
        return (last - first).total_seconds()
    except (TypeError, ValueError):
        return None


def dispatch_timing(result_path, result, phase):
    """Read only the phase receipt bound to this exact job, identity and result."""
    result_path = Path(result_path).resolve()
    job = result_path.parent.parent
    path = job.parent.parent / "campaign" / (job.name + "-dispatch.json")
    timing = {"receipt": str(path), "status": None, "started_at": None, "finished_at": None,
              "wall_seconds": None, "cleanup_confirmed": False, "issue": "receipt_missing"}
    if not path.exists():
        return timing, None, None
    try:
        receipt = json.loads(path.read_text())
    except json.JSONDecodeError:
        timing["issue"] = "receipt_incomplete"
        return timing, None, None
    identity_path = job / "request-identity.json"
    if (not identity_path.exists() or not receipt.get("trial_result") or not receipt.get("phase")
            or type(receipt.get("attempt")) is not int or receipt["attempt"] < 1):
        timing["issue"] = "receipt_binding_missing"
        return timing, None, None
    identity = validate_identity(json.loads(identity_path.read_text()))
    if (receipt.get("request_identity") != identity or identity["jobId"] != job.name
            or identity["phase"] != phase or receipt.get("phase") != phase
            or Path(identity["taskId"]).name != Path(result["task_name"]).name
            or Path(receipt["trial_result"]).resolve() != result_path):
        raise ValueError("Dispatch timing identity or result differs from trial")
    timing.update({key: receipt.get(key) for key in ("status", "started_at", "finished_at")})
    elapsed = timing_seconds(timing["started_at"], timing["finished_at"])
    if receipt.get("status") == "blocked" or receipt.get("cleanup_error_code"):
        timing["issue"] = "cleanup_unconfirmed"
    elif receipt.get("status") not in ("finished", "failed") or not timing["finished_at"]:
        timing["issue"] = "dispatch_incomplete"
    elif (elapsed is None or timing_seconds(timing["started_at"], result.get("started_at")) is None
          or timing_seconds(result.get("finished_at"), timing["finished_at"]) is None):
        timing["issue"] = "invalid_or_inconsistent_timestamps"
    else:
        timing.update({"wall_seconds": elapsed, "cleanup_confirmed": True, "issue": None})
    return timing, identity, receipt.get("attempt")


def attempt_timing(source_path, source, replay_path, replay):
    source_time, source_id, source_attempt = dispatch_timing(source_path, source, "source")
    replay_time, replay_id, replay_attempt = dispatch_timing(replay_path, replay, "replay")
    if source_id and replay_id:
        if (any(source_id[key] != replay_id[key] for key in ("campaignId", "candidateId", "participantId", "taskId"))
                or source_attempt != replay_attempt):
            raise ValueError("Dispatch timing phases belong to different attempts")
    complete = source_time["cleanup_confirmed"] and replay_time["cleanup_confirmed"]
    gap = timing_seconds(source_time["finished_at"], replay_time["started_at"]) if complete else None
    issue = (source_time["issue"] or replay_time["issue"] or
             ("overlapping_or_inconsistent_phases" if gap is None else None))
    wall = timing_seconds(source_time["started_at"], replay_time["finished_at"]) if not issue else None
    return {"source": source_time, "replay": replay_time, "wall_seconds": wall, "issue": issue,
        "between_phases_seconds": gap,
        "before_source_trial_seconds": timing_seconds(source_time["started_at"], source.get("started_at")) if complete else None,
        "after_replay_trial_seconds": timing_seconds(replay.get("finished_at"), replay_time["finished_at"]) if complete else None,
        "definitions": {
            "trial_lifecycle_seconds": "Source trial started_at through replay trial finished_at, including the intervening gap. Legacy end_to_end_seconds is an alias of this boundary.",
            "attempt_wall_seconds": "Source dispatch receipt started_at through replay receipt finished_at after confirmed cleanup/settlement, including capacity wait and all phase gaps. Excludes controller process startup before the source receipt and report writing after the replay receipt. Unknown unless both receipts match their jobs/results and confirm cleanup.",
            "phase_wall_seconds": "Each phase receipt started_at through finished_at after confirmed cleanup/settlement. Failed execution with confirmed cleanup remains measurable. Phase spans are not summed across concurrent attempts."}}


def merge_trial(source, replay, replay_directory):
    if Path(source["task"]).name != Path(replay["task_name"]).name:
        raise ValueError("Source and replay tasks differ")
    reward = ((replay.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    exception = replay.get("exception_info") or {}
    log = replay_directory / "verifier/test-stdout.txt"
    infrastructure = trial_infrastructure_issue(replay, log.read_text(errors="replace") if log.exists() else "")
    info = replay_directory / "agent/replay.json"
    replay_info = json.loads(info.read_text()) if info.exists() else None
    end_to_end = None
    raw_source = json.loads(Path(source["result"]).read_text())
    capture_path = Path(source["result"]).parent / "agent/patch-capture.json"
    capture = json.loads(capture_path.read_text()) if capture_path.exists() else None
    if raw_source.get("started_at") and replay.get("finished_at"):
        end_to_end = (datetime.datetime.fromisoformat(replay["finished_at"]) -
                      datetime.datetime.fromisoformat(raw_source["started_at"])).total_seconds()
    timing = attempt_timing(source["result"], raw_source, replay_directory / "result.json", replay)
    return {**source, "reward": reward, "score": reward if reward is not None else 0,
        "exception": source["exception"] or exception.get("exception_type"),
        "error": source["error"] or exception.get("exception_message"),
        "infrastructure_issue": source["infrastructure_issue"] or infrastructure,
        "source_exception": source["exception"], "source_verifier_reward": source["reward"],
        "patch_capture": capture,
        "source_trial_seconds": source["trial_seconds"],
        "replay_trial_seconds": duration(replay), "replay_verifier_seconds": duration(replay.get("verifier")),
        "end_to_end_seconds": end_to_end,
        "trial_lifecycle_seconds": end_to_end,
        "attempt_wall_seconds": timing["wall_seconds"], "attempt_timing": timing,
        "replay": {"result": str((replay_directory / "result.json").resolve()), "details": replay_info,
            "exception": exception.get("exception_type"), "infrastructure_issue": infrastructure},
        "score_authority": "unmodified official PatchReplayAgent and verifier in a fresh sandbox"}


def summarize_repository(manifest, jobs_root, requests):
    summaries = []
    for participant in manifest["participants"]:
        planned = [row for row in manifest["attempts"] if row["participant"] == participant]
        trials, pending, ungraded, calls_by_attempt, unstarted = [], [], [], [], []
        for row in planned:
            source_job = jobs_root / row["source_job"]
            if not (source_job / "lock.json").exists():
                unstarted.append(row["source_job"])
                continue
            data = summarize(source_job, requests)
            if data["planned"] != 1 or data["completed"] > 1:
                raise ValueError("Repository sources require exactly one frozen trial")
            if any(name.split("/")[-1] != manifest["model"] for name in data["models"]):
                raise ValueError("Source model differs from frozen model")
            if not data["trials"]:
                pending.append(row["source_job"] + ":source-running")
                continue
            source = data["trials"][0]
            if Path(source["task"]).name != row["task"]:
                raise ValueError("Source task differs from frozen task")
            calls_by_attempt.append({"source_job": row["source_job"], "metrics": source["metrics"], "agent_seconds": source["agent_seconds"]})
            replay_job = jobs_root / row["replay_job"]
            replay_results = list(replay_job.glob("*/result.json"))
            if len(replay_results) > 1:
                raise ValueError("Replay contains duplicate attempts")
            if not replay_results:
                ungraded.append({"source_job": row["source_job"], "source": source})
                pending.append(row["replay_job"] + ":replay-pending")
                continue
            replay = json.loads(replay_results[0].read_text())
            merged = merge_trial(source, replay, replay_results[0].parent)
            merged.update({"source_job": row["source_job"], "replay_job": row["replay_job"]})
            trials.append(merged)
        summaries.append(finish_summary({"job": participant, "models": [manifest["model"]],
            "ungraded_sources": ungraded, "unstarted_sources": unstarted, "completed_source_usage": calls_by_attempt,
            "source_tool_usage": aggregate_tool_usage(trials + [item["source"] for item in ungraded])},
            len(planned), trials, pending))
    verify_unique_attribution(summaries)
    return summaries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench"
    budget = json.loads((root / "campaign/budget.json").read_text())
    manifest = json.loads(args.manifest.read_text())
    selected = comparison_manifest(manifest)
    exposure = task_exposure(manifest, root / "jobs")
    coverage = image_selection_coverage(manifest)
    jobs = summarize_repository(selected, root / "jobs", budget["requests"])
    report = {"generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "analysis_implementation": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                    for name in ("repository_report.py", "report.py", "metrics.py", "task_exposure.py", "request_identity.py", "tool_metrics.py")},
        "manifest": str(args.manifest.resolve()), "definition": manifest, "selected_attempts": selected["attempts"], "jobs": jobs,
        "validation_coverage": coverage,
        "task_exposure": exposure,
        "campaign": {"limit_usd": budget["limitUsd"], "requests": len(budget["requests"]),
            "estimated_known_cost_usd": sum(row["estimatedUsd"] or 0 for row in budget["requests"]),
            "committed_upper_usd": sum(row["budgetUsd"] for row in budget["requests"]),
            "unknown_requests": sum(row["estimatedUsd"] is None for row in budget["requests"])},
        "comparisons": [compare_jobs(jobs[0], job) for job in jobs[1:]]}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# SWE-bench Pro 仓库对照", "",
        "成绩来自官方补丁重放器在全新容器中的判分。源任务的模型费用、运行异常和解题时间单独保留；重放未结束时成绩待定。trial 跨阶段耗时从源 trial 开始到 replay trial 结束（含中间空隙）；attempt 完整耗时从源 dispatch receipt 开始到 replay receipt 确认清理结算完成，含排队及阶段空隙。旧 end_to_end_seconds 保留为 trial 跨阶段耗时别名。"]
    lines += ["", f'任务归属校验：{exposure["status"]}。独立留出题 {len(exposure["independent_held_out_tasks"])}，开发题 {len(exposure["development_tasks"])}，归属未知题 {len(exposure["unknown_tasks"])}。开发题和未知题的结果用于描述与诊断，不计入独立泛化证据。']
    if coverage:
        lines += ["", f'冻结验证组共 {coverage["validation_task_count"]} 题，本清单安排 {coverage["scheduled_task_count"]} 题。已检查 {coverage["checked_image_count"]} 个镜像清单，发现 {len(coverage["image_issues"])} 个获取问题；其余 {len(coverage["unchecked_tasks"])} 题尚未检查。镜像缺口单独保留，不计作 Agent 的成功或失败；本报告成绩仅覆盖当前安排的任务。']
        for issue in coverage["image_issues"]:
            lines += ["", f'镜像问题：`{issue["task"]}`，状态 `{issue["status"]}`，HTTP `{issue.get("http_status", "未知")}`，注册表错误 `{", ".join(issue.get("registry_error_codes", [])) or "未提供"}`。']
    def shown(value, digits=2):
        return f"{value:.{digits}f}" if value is not None else "待定"

    lines += ["", "| Agent | 判分完成/计划 | 官方通过 | 正常通过 | 已判分 agent 秒中位数 | 已判分完整 attempt 秒中位数 | 已结束源任务已知模型费估算美元 | 未知估算请求 | 实际完整费用美元 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for job in jobs:
        cost = sum(row["metrics"]["known_cost_usd"] for row in job["completed_source_usage"])
        unknown = sum(row["metrics"]["unknown_cost_requests"] for row in job["completed_source_usage"])
        seconds = (job["aggregate"]["agent_seconds_all_attempts"] or {}).get("p50")
        wall = (complete_attempt_seconds(job["trials"]) or {}).get("p50")
        lines.append(f'| {job["job"]} | {job["completed"]}/{job["planned"]} | {job["aggregate"]["successes"]} | {job["aggregate"]["clean_successes"]} | {shown(seconds)} | {shown(wall)} | {cost:.6f} | {unknown} | {shown(job["aggregate"].get("complete_task_cost_usd"), 6)} |')
    lines += ["", "先看官方质量与运行稳定性，再看完整耗时和费用。已知模型费估算包含已结束但仍待判分的源任务及失败调用，未知用量不补零；实际完整扣费未获证据时保持未知。执行中的源任务和实时预算占用见 JSON campaign。", "",
        "| Agent / 已判分任务 | 官方 reward | 异常 | 解题秒数 | 模型费估算美元 | 实际完整费用美元 | 重放 verifier 秒数 | trial 跨阶段秒数 | attempt 完整秒数 |",
        "|---|---:|---|---:|---:|---:|---:|---:|---:|"]
    for job in jobs:
        for trial in job["trials"]:
            task = re.sub(r"-[0-9a-f]{40}.*$", "", Path(trial["task"]).name.removeprefix("instance_"))
            label = job["job"] + " / " + task
            cost = trial["metrics"]["known_cost_usd"] if trial["metrics"]["unknown_cost_requests"] == 0 else None
            lines.append(f'| {label} | {shown(trial["reward"], 0)} | {trial["exception"] or trial["infrastructure_issue"] or "无"} | {shown(trial["agent_seconds"])} | {shown(cost, 6)} | {shown(trial.get("complete_task_cost_usd"), 6)} | {shown(trial["replay_verifier_seconds"])} | {shown(trial["trial_lifecycle_seconds"])} | {shown(trial["attempt_wall_seconds"])} |')
    lines += context_diagnostics_markdown(jobs)
    lines += ["", "模型阶段、工具执行与轨迹导出采用不同测量边界，不能直接相加为解题时间。任务完整 ID、原始结果路径和所有费用分项保存在 JSON。", "",
        "| 固定参考 → 候选 | 两组完成 | 共同正常成功题数 | 候选/参考解题耗时 | 候选/参考完整 attempt 耗时 | 候选/参考模型费估算 |",
        "|---|---|---:|---:|---:|---:|"]
    for comparison in report["comparisons"]:
        ratios = comparison["candidate_over_reference"]
        values = [f'{ratios[key]:.4f}' if ratios[key] is not None else "待定" for key in ("agent_seconds", "attempt_wall_seconds", "cost_usd")]
        lines.append(f'| {comparison["reference"]} → {comparison["candidate"]} | {"是" if comparison["complete"] else "否"} | {comparison["jointly_solved_tasks"]} | {values[0]} | {values[1]} | {values[2]} |')
    lines += ["", "费用含失败尝试，缺失用量保持未知。效率比仅取双方均正常成功且无基础设施异常的同题，按题等权；完整 attempt 耗时缺失时不以 agent 耗时代替。模型费估算比不代表实际完整扣费。原始请求、身份和重试计数仅用于 JSON 归账及故障审计。工具调用按 tool_call_scope 标明层级：ScriptAct 是底层能力操作，ATIF 是外层模型工具调用；Codex 原生命令及文件修改操作另列 native_operations，各层不直接互比。单次任务不能确立总体领先。", ""]
    lines += tool_usage_markdown(jobs)
    args.output.with_suffix(".md").write_text("\n".join(lines))
    print(json.dumps({"report": str(args.output), "completed": sum(job["completed"] for job in jobs)}))


if __name__ == "__main__":
    main()
