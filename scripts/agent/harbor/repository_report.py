"""Join source-run efficiency to the official fresh-sandbox replay score."""

import argparse
import datetime
import hashlib
import json
import re
from pathlib import Path

from metrics import compare_jobs, trial_infrastructure_issue
from report import duration, finish_summary, summarize


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
    return {**source, "reward": reward, "score": reward if reward is not None else 0,
        "exception": source["exception"] or exception.get("exception_type"),
        "error": source["error"] or exception.get("exception_message"),
        "infrastructure_issue": source["infrastructure_issue"] or infrastructure,
        "source_exception": source["exception"], "source_verifier_reward": source["reward"],
        "patch_capture": capture,
        "source_trial_seconds": source["trial_seconds"],
        "replay_trial_seconds": duration(replay), "replay_verifier_seconds": duration(replay.get("verifier")),
        "end_to_end_seconds": end_to_end,
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
            calls_by_attempt.append({"source_job": row["source_job"], "metrics": source["metrics"]})
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
            "ungraded_sources": ungraded, "unstarted_sources": unstarted, "completed_source_usage": calls_by_attempt},
            len(planned), trials, pending))
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
    coverage = image_selection_coverage(manifest)
    jobs = summarize_repository(selected, root / "jobs", budget["requests"])
    report = {"generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "analysis_implementation": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                    for name in ("repository_report.py", "report.py", "metrics.py")},
        "manifest": str(args.manifest.resolve()), "definition": manifest, "selected_attempts": selected["attempts"], "jobs": jobs,
        "validation_coverage": coverage,
        "campaign": {"limit_usd": budget["limitUsd"], "requests": len(budget["requests"]),
            "estimated_known_cost_usd": sum(row["estimatedUsd"] or 0 for row in budget["requests"]),
            "committed_upper_usd": sum(row["budgetUsd"] for row in budget["requests"]),
            "unknown_requests": sum(row["estimatedUsd"] is None for row in budget["requests"])},
        "comparisons": [compare_jobs(jobs[0], job) for job in jobs[1:]]}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# SWE-bench Pro 仓库对照", "",
        "成绩来自官方补丁重放器在全新容器中的判分。源任务的模型费用、运行异常和解题时间单独保留；重放未结束时成绩待定。完成时间另列源运行、重放及含间隔的端到端时间。"]
    if coverage:
        lines += ["", f'冻结验证组共 {coverage["validation_task_count"]} 题，本清单安排 {coverage["scheduled_task_count"]} 题。已检查 {coverage["checked_image_count"]} 个镜像清单，发现 {len(coverage["image_issues"])} 个获取问题；其余 {len(coverage["unchecked_tasks"])} 题尚未检查。镜像缺口单独保留，不计作 Agent 的成功或失败；本报告成绩仅覆盖当前安排的任务。']
        for issue in coverage["image_issues"]:
            lines += ["", f'镜像问题：`{issue["task"]}`，状态 `{issue["status"]}`，HTTP `{issue.get("http_status", "未知")}`，注册表错误 `{", ".join(issue.get("registry_error_codes", [])) or "未提供"}`。']
    lines += ["", "| Agent | 判分完成/计划 | 通过 | 无异常通过 | 已结束源任务请求数 | 已结束源任务已知费用 | 未知费用请求 |", "|---|---:|---:|---:|---:|---:|---:|"]
    for job in jobs:
        cost = sum(row["metrics"]["known_cost_usd"] for row in job["completed_source_usage"])
        unknown = sum(row["metrics"]["unknown_cost_requests"] for row in job["completed_source_usage"])
        requests = sum(row["metrics"]["requests"] for row in job["completed_source_usage"])
        lines.append(f'| {job["job"]} | {job["completed"]}/{job["planned"]} | {job["aggregate"]["successes"]} | {job["aggregate"]["clean_successes"]} | {requests} | ${cost:.6f} | {unknown} |')
    lines += ["", "请求数和费用包含已结束但仍待判分的源任务，包括拒绝、修复和失败的调用；执行中的源任务尚未归入这两列，实时预算占用见 JSON campaign。", "",
        "| Agent / 已判分任务 | 官方 reward | 异常 | 模型请求数 | 解题秒数 | 模型费用美元 | 重放 verifier 秒数 | 端到端秒数 |",
        "|---|---:|---|---:|---:|---:|---:|---:|"]
    def shown(value, digits=2):
        return f"{value:.{digits}f}" if value is not None else "待定"
    for job in jobs:
        for trial in job["trials"]:
            task = re.sub(r"-[0-9a-f]{40}.*$", "", Path(trial["task"]).name.removeprefix("instance_"))
            label = job["job"] + " / " + task
            cost = trial["metrics"]["known_cost_usd"] if trial["metrics"]["unknown_cost_requests"] == 0 else None
            lines.append(f'| {label} | {shown(trial["reward"], 0)} | {trial["exception"] or "无"} | {trial["metrics"]["requests"]} | {shown(trial["agent_seconds"])} | {shown(cost, 6)} | {shown(trial["replay_verifier_seconds"])} | {shown(trial["end_to_end_seconds"])} |')
    lines += ["", "| Agent / 已判分任务 | 请求数 | 模型阶段秒数 | 实际输入峰值 token | 缓存命中率 | 缓存写入费用 |",
        "|---|---:|---:|---:|---:|---:|"]
    for job in jobs:
        for trial in job["trials"]:
            task = re.sub(r"-[0-9a-f]{40}.*$", "", Path(trial["task"]).name.removeprefix("instance_"))
            metrics = trial["metrics"]
            hit = metrics["cache_token_hit_rate"]
            hit_text = f"{hit:.2%}" if hit is not None else "待定"
            lines.append(f'| {job["job"]} / {task} | {metrics["requests"]} | {shown(metrics["model_request_seconds_sum"])} | {shown(metrics["peak_input_tokens"], 0)} | {hit_text} | {shown(metrics["cost_components_usd"]["cache_write"], 6)} |')
    lines += ["", "模型阶段、工具执行与轨迹导出采用不同测量边界，不能直接相加为解题时间。任务完整 ID、原始结果路径和所有费用分项保存在 JSON。", "",
        "| 固定参考 → 候选 | 两组完成 | 共同正常成功题数 | 候选/参考模型请求数 | 候选/参考解题耗时 | 候选/参考模型费用 |",
        "|---|---|---:|---:|---:|---:|"]
    for comparison in report["comparisons"]:
        ratios = comparison["candidate_over_reference"]
        shown = [f'{ratios[key]:.4f}' if ratios[key] is not None else "待定" for key in ("model_requests", "agent_seconds", "cost_usd")]
        lines.append(f'| {comparison["reference"]} → {comparison["candidate"]} | {"是" if comparison["complete"] else "否"} | {comparison["jointly_solved_tasks"]} | {shown[0]} | {shown[1]} | {shown[2]} |')
    lines += ["", "完整请求数和费用含失败尝试，缺失用量保持未知。效率比仅取双方均正常成功的同题，按题等权；小于 1 表示候选在该指标上较低。请求数、完成耗时与总费用逐项比较，单项下降不能代替整体效率结论。缓存、输入/输出/推理、工具错误及上下文指标见 JSON。工具调用按 tool_call_scope 标明层级：ScriptAct 是底层能力操作，ATIF 是外层模型工具调用；Codex 原生命令及文件修改操作另列 native_operations，各层不直接互比。单次任务不能确立总体领先。", ""]
    args.output.with_suffix(".md").write_text("\n".join(lines))
    print(json.dumps({"report": str(args.output), "completed": sum(job["completed"] for job in jobs)}))


if __name__ == "__main__":
    main()
