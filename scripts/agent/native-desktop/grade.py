"""用途：在独立 macOS 工作树中用公开测试判分；参考补丁只供零模型 Oracle 机械重放。"""
import argparse
import ast
from collections import Counter
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import xml.etree.ElementTree as ET

from prepare import prepare_workspace


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def command(args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def native_input_identity(task_dir, harness_dir=None):
    """零模型验收绑定实际输入及执行代码，配置变化必须重新验收。"""
    harness_dir = harness_dir or Path(__file__).resolve().parent
    inputs = {
        "taskSha256": task_dir / "task.json",
        "profileSha256": task_dir / "native-test-profile.json",
        "testPatchSha256": task_dir / "test.patch",
        "graderSha256": harness_dir / "grade.py",
        "preparerSha256": harness_dir / "prepare.py",
    }
    profile = json.loads(inputs["profileSha256"].read_bytes())
    if profile.get("official_parser"):
        inputs.update(parserSourceSha256=Path(profile["official_parser"]["source"]), parserConstantsSha256=Path(profile["official_parser"]["constants"]))
    identity = {"schema": 1, **{name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in inputs.items()}}
    lock = task_dir / "native-environment-lock.json"
    identity["environmentLockSha256"] = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None
    return identity


def expected_case(node_id):
    # 参数 ID 中也可出现 ::（例如 IPv6），只拆分参数区之前的 pytest 路径。
    prefix, bracket, parameters = node_id.partition("[")
    parts = prefix.split("::")
    if len(parts) < 2 or not parts[0].endswith(".py"):
        raise ValueError("Native pytest protocol requires explicit pytest node IDs")
    return (".".join([parts[0][:-3].replace("/", "."), *parts[1:-1]]), parts[-1] + bracket + parameters)


def pytest_results(path):
    cases = {}
    for item in ET.parse(path).getroot().iter("testcase"):
        key = (item.attrib.get("classname", ""), item.attrib.get("name", ""))
        if key in cases:
            raise ValueError("Duplicate pytest case identity")
        outcome = "passed"
        for tag in ["error", "failure", "skipped"]:
            if item.find(tag) is not None:
                outcome = tag
                break
        cases[key] = outcome
    return cases


def unittest_case_key(label):
    """Python 3.11 的显示类名末尾附带方法；仅移除与前面方法字段完全一致的后缀。"""
    match = re.fullmatch(r"([^\s()]+) \(([^\s()=,]+)\)", label)
    if not match:
        raise ValueError("Expected a complete official unittest label")
    method, classname = match[1], match[2]
    suffix = "." + method
    if classname.endswith(suffix):
        classname = classname[:-len(suffix)]
    return classname, method


def unittest_results(log, official_statuses, exit_code, reader):
    """按真实 case 头与终态规范化显示，正文完整保留，状态仍经冻结的官方 parser 读取。"""
    summaries = re.findall(r"^Ran (\d+) tests? in .+$", log, re.MULTILINE)
    terminals = re.findall(r"^(OK(?: \([^\n]+\))?|FAILED \([^\n]+\))$", log, re.MULTILINE)
    if len(summaries) != 1 or len(terminals) != 1:
        raise ValueError("Native unittest run did not produce one complete summary")
    failed = terminals[0].startswith("FAILED")
    if exit_code not in [0, 1] or failed != (exit_code == 1):
        raise ValueError("Native unittest terminal status disagrees with exit code")
    status_names = {"PASSED": "passed", "FAILED": "failure", "ERROR": "error", "SKIPPED": "skipped"}
    cases = {}
    aliases = {}
    pending = None
    for line in log.splitlines():
        header = re.fullmatch(r"([^\s()]+ \([^\s()=,]+\))(?: \.\.\. (.*))?", line)
        if header:
            if pending:
                raise ValueError("Native unittest case has no terminal status")
            pending = header[1]
            line = header[2] or ""
        if not pending:
            continue
        terminal = re.search(r"(?:^| \.\.\. )(ok|OK|FAIL|ERROR|skipped(?: .*)?)$", line)
        if not terminal:
            continue
        key = unittest_case_key(pending)
        if key in cases:
            raise ValueError("Duplicate native unittest case identity")
        canonical_label = key[1] + " (" + key[0] + ")"
        status = reader(canonical_label + " ... " + terminal[1], None).get(canonical_label)
        if status not in status_names:
            raise ValueError("Unknown official unittest case status")
        outcomes = {status_names[status]}
        if pending in official_statuses:
            raw_status = official_statuses[pending]
            if raw_status not in status_names:
                raise ValueError("Unknown original official unittest case status")
            outcomes.add(status_names[raw_status])
        cases[key] = next(value for value in ("error", "failure", "skipped", "passed") if value in outcomes)
        # 官方历史标签可能使用 unittest 的说明文本；把真实输出的别名绑定到全部实际 case，不能最后一项覆盖。
        description = line[:terminal.start()].strip()
        if description and description in reader(line, None):
            aliases.setdefault(description, []).append(key)
        pending = None
    if pending:
        raise ValueError("Native unittest case has no terminal status")
    for kind, label in re.findall(r"^(FAIL|ERROR): (.+)$", log, re.MULTILINE):
        key = unittest_case_key(label)
        if key not in cases:
            raise ValueError("Native unittest failure summary lacks its official case")
        if cases[key] != "error":
            cases[key] = "failure" if kind == "FAIL" else "error"
    if len(cases) != int(summaries[0]):
        raise ValueError("Native unittest case count disagrees with summary")
    if not failed and any(status in ["failure", "error"] for status in cases.values()):
        raise ValueError("Native unittest successful summary contains failed cases")
    if failed and not any(status in ["failure", "error"] for status in cases.values()):
        raise ValueError("Native unittest failed summary lacks failed cases")
    return cases, aliases


def native_test_invocation(profile, xml):
    """源任务与重放使用同一 runner；pytest 的 XML 参数不污染 Django 原生测试命令。"""
    python = str(Path(profile["python"]).absolute())
    if profile["runner"] == "pytest":
        plugins = [arg for plugin in profile.get("pytest_plugins", []) for arg in ("-p", plugin)]
        return [python, "-m", "pytest", "-rA", *plugins, *profile["args"], "--junitxml=" + str(xml)]
    if profile["runner"] == "django":
        return [python, "tests/runtests.py", *profile["args"]]
    if profile["runner"] == "sympy":
        return [python, "bin/test", *profile["args"]]
    raise ValueError("Unsupported native grading runner")


def sympy_results(log, exit_code, reader):
    """原生 verbose 日志逐文件绑定 case；官方短名称别名保留全部匹配，核对报告计数及退出状态。"""
    summary = re.findall(r"^=+ tests finished: (.*?) seconds =+$", log, re.MULTILINE | re.DOTALL)
    if len(summary) != 1 or len(re.findall(r"^=+ test process starts =+$", log, re.MULTILINE)) != 1:
        raise ValueError("Native SymPy run did not produce one complete summary")
    body = re.sub(r"\s+", " ", summary[0])
    kinds = "passed|failed|skipped|expected to fail but passed|expected to fail|exceptions"
    if not re.fullmatch(r"(?:\d+ (?:" + kinds + r"), )+in \d+(?:\.\d+)?", body):
        raise ValueError("Native SymPy summary contains unknown outcomes")
    reported = Counter()
    for count, kind in re.findall(r"(\d+) (" + kinds + r"), ", body):
        if kind in reported:
            raise ValueError("Duplicate native SymPy summary outcome")
        reported[kind] = int(count)
    seen, cases, aliases = Counter(), {}, {}
    active = None
    declared = observed = 0
    file_failed = False
    for line in log.splitlines():
        header = re.fullmatch(r"([^\s\[\]]+\.py)\[(\d+)\]\s*(\[OK\])?", line)
        if header:
            if active:
                raise ValueError("Native SymPy file has no terminal status")
            active, declared, observed, file_failed = header[1], int(header[2]), 0, False
            if header[3]:
                if declared:
                    raise ValueError("Native SymPy file did not execute its cases")
                active = None
            continue
        if not active:
            continue
        trailer = re.search(r"\s+\[(OK|FAIL)\]$", line)
        clean = line[:trailer.start()] if trailer else line
        if clean.strip():
            match = re.fullmatch(r"(test_\S+) (.*?)(ok|F|E|f|X|s|w|K|T)\s*", clean)
            if not match:
                raise ValueError("Native SymPy verbose case has no known terminal status")
            name, reason, raw_status = match.groups()
            if raw_status == "T" and not reason:
                kind, outcome = "exceptions", "error"
            elif raw_status in ["s", "w", "K", "T"]:
                kind, outcome = "skipped", "skipped"
            else:
                kind, outcome = {
                    "ok": ("passed", "passed"), "F": ("failed", "failure"),
                    "E": ("exceptions", "error"), "f": ("expected to fail", "skipped"),
                    "X": ("expected to fail but passed", "skipped"),
                }[raw_status]
            # 标准 pass/fail/error 仍由冻结的官方规则识别；跳过与预期失败不能成为通过。
            if raw_status in ["ok", "F", "E"]:
                expected = {"ok": "PASSED", "F": "FAILED", "E": "ERROR"}[raw_status]
                if reader(clean.strip(), None).get(name) != expected:
                    raise ValueError("Native SymPy case disagrees with official parser")
            key = (active, name)
            if key in cases:
                raise ValueError("Duplicate native SymPy case identity")
            cases[key] = outcome
            aliases.setdefault(name, []).append(key)
            aliases.setdefault(active + ":" + name, []).append(key)
            seen[kind] += 1
            observed += 1
            file_failed = file_failed or outcome in ["failure", "error"]
        if trailer:
            if observed != declared or file_failed != (trailer[1] == "FAIL"):
                raise ValueError("Native SymPy file summary disagrees with its cases")
            active = None
    if active or seen != reported:
        raise ValueError("Native SymPy case count disagrees with summary")
    failed = bool(seen["failed"] or seen["exceptions"])
    if exit_code not in [0, 1] or failed != (exit_code == 1):
        raise ValueError("Native SymPy terminal status disagrees with exit code")
    return cases, aliases


def baseline_expected(assessment):
    """官方 fail-to-pass 允许断言失败或测试抛错，缺失和跳过均不构成问题复现。"""
    return all(value == "passed" for value in assessment["groups"]["PASS_TO_PASS"].values()) and any(value in ["failure", "error"] for value in assessment["groups"]["FAIL_TO_PASS"].values())


def official_reader(profile):
    config = profile.get("official_parser")
    if not config:
        return None, None
    source = Path(config["source"]).read_bytes()
    constants = Path(config["constants"]).read_bytes()
    namespace = {"re": re, "Enum": Enum, "TestSpec": object}
    status = next(node for node in ast.parse(constants).body if isinstance(node, ast.ClassDef) and node.name == "TestStatus")
    exec(compile(ast.Module(body=[status], type_ignores=[]), config["constants"], "exec"), namespace)
    # 正式读取规则逐字加载；常量和类型依赖只取必要声明，不引入 Docker 运行依赖。
    body = [node for node in ast.parse(source).body if not isinstance(node, (ast.Import, ast.ImportFrom))]
    exec(compile(ast.Module(body=body, type_ignores=[]), config["source"], "exec"), namespace)
    reader = namespace[config["function"]]
    return reader, {"revision": config["revision"], "function": config["function"], "sourceSha256": hashlib.sha256(source).hexdigest(), "constantsSha256": hashlib.sha256(constants).hexdigest()}


def grade_cases(task, cases, reader=None, label_format="pytest", aliases=None):
    if label_format not in ["pytest", "unittest", "sympy"]:
        raise ValueError("Unsupported native test label format")
    groups = {}
    matches = {}
    for group in ["FAIL_TO_PASS", "PASS_TO_PASS"]:
        groups[group] = {}
        for item in task[group]:
            if label_format in ["unittest", "sympy"]:
                keys = [unittest_case_key(item)] if label_format == "unittest" and re.fullmatch(r"([^\s()]+) \(([^\s()=,]+)\)", item) else (aliases or {}).get(item, [])
                found = [{"classname": key[0], "name": key[1], "outcome": cases[key]} for key in keys if key in cases]
                matches[item] = found
                outcomes = {row["outcome"] for row in found}
                groups[group][item] = next((status for status in ("error", "failure", "skipped", "passed") if status in outcomes), "missing")
                continue
            if reader is None:
                groups[group][item] = cases.get(expected_case(item), "missing")
                continue
            classname, method = expected_case(item)
            family = method.partition("[")[0]
            prefix = item.partition("[")[0].rsplit("::", 1)[0] + "::"
            found = []
            for (raw_class, raw_name), outcome in cases.items():
                if raw_class != classname or raw_name.partition("[")[0] != family:
                    continue
                # 用正式 parser 归一化真实 JUnit 名称，不猜路径或截断参数。
                status = {"passed": "PASSED", "failure": "FAILED", "error": "ERROR", "skipped": "SKIPPED"}[outcome]
                normalized = reader(status + " " + prefix + raw_name, None)
                if item in normalized:
                    found.append({"classname": raw_class, "name": raw_name, "outcome": outcome})
            matches[item] = found
            # 官方标签可能合并多个参数；所有真实用例都通过才判通过，避免最后一项覆盖失败。
            outcomes = {row["outcome"] for row in found}
            groups[group][item] = next((status for status in ("error", "failure", "skipped", "passed") if status in outcomes), "missing")
    return {
        "groups": groups,
        "officialLabelCases": matches,
        "caseCount": len(cases),
        "missing": sum(value == "missing" for group in groups.values() for value in group.values()),
        "resolved": all(group and all(value == "passed" for value in group.values()) for group in groups.values()),
    }


def run(args):
    task_dir = args.task.resolve()
    input_identity = native_input_identity(task_dir)
    task = json.loads((task_dir / "task.json").read_text())
    profile = json.loads((task_dir / "native-test-profile.json").read_text())
    out = args.directory.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    campaign = task_dir.parent.parent
    repository = campaign / "repositories" / task["repo"].replace("/", "__")
    workspace = out / "workspace"
    started = time.time()
    outcome = {"schema": 1, "kind": args.kind, "taskId": task["instance_id"], "nativeInputIdentity": input_identity, "status": "preparing", "modelCalls": 0, "startedAt": started}
    try:
        command(["git", "--git-dir", str(repository), "worktree", "add", "--detach", str(workspace), task["base_commit"]])
        if args.kind == "source":
            if not args.source_patch:
                raise ValueError("Source grade requires a captured patch")
            patch = args.source_patch.read_bytes()
            outcome["sourcePatchSha256"] = hashlib.sha256(patch).hexdigest()
            if patch:
                command(["git", "apply", "--binary", str(args.source_patch.resolve())], workspace)
        elif args.kind == "oracle":
            # 不打印、解释或把参考补丁交给参赛进程；只核对环境能否重放官方预期。
            import pyarrow.parquet as pq
            dataset = campaign / "datasets" / profile["dataset_file"]
            rows = pq.read_table(dataset, columns=["instance_id", "patch"]).to_pylist()
            gold = next(item["patch"] for item in rows if item["instance_id"] == task["instance_id"])
            path = out / "oracle-private.patch"
            path.write_text(gold)
            path.chmod(0o600)
            command(["git", "apply", "--binary", str(path)], workspace)

        test_patch = task_dir / "test.patch"
        text = test_patch.read_text()
        paths = sorted(set(re.findall(r"^\+\+\+ b/(.+)$", text, re.MULTILINE)))
        for path in paths:
            if Path(path).is_absolute() or ".." in Path(path).parts or ".git" in Path(path).parts:
                raise ValueError("Test patch escapes the grading workspace")
            existing = command(["git", "ls-tree", "--name-only", task["base_commit"], "--", path], workspace).stdout
            if existing:
                command(["git", "restore", "--source=" + task["base_commit"], "--worktree", "--", path], workspace)
            else:
                (workspace / path).unlink(missing_ok=True)
        command(["git", "apply", "--binary", str(test_patch)], workspace)
        outcome["testPatchSha256"] = hashlib.sha256(test_patch.read_bytes()).hexdigest()
        outcome["sourcePreparation"] = prepare_workspace(profile, workspace, out / "preparation")
        xml = out / "pytest.xml"
        python = str(Path(profile["python"]).absolute())
        environment = {**os.environ, "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}
        environment["PYTHONPATH"] = os.pathsep.join(str(workspace / path) for path in profile.get("python_path", []))
        environment["PATH"] = str(Path(python).parent) + os.pathsep + environment["PATH"]
        invocation = native_test_invocation(profile, xml)
        outcome["testCommand"] = invocation
        with (out / "test.log").open("wb") as log:
            process = subprocess.Popen(invocation, cwd=workspace, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=profile.get("timeout_seconds", 300))
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                raise ValueError("Native grader deadline exceeded")
        outcome["exitCode"] = code
        if code not in [0, 1]:
            raise ValueError("Native test environment did not execute its cases")
        reader, parser_evidence = official_reader(profile)
        log_text = (out / "test.log").read_text()
        official_statuses = reader(log_text, None) if reader else None
        if profile["runner"] == "django":
            if not reader or profile["official_parser"]["function"] != "parse_log_django":
                raise ValueError("Django requires the official Django log parser")
            cases, aliases = unittest_results(log_text, official_statuses, code, reader)
            assessment = grade_cases(task, cases, label_format="unittest", aliases=aliases)
            outcome["nativeLabelNormalization"] = "unittest-method-display-suffix-and-multiline-description-v1"
            outcome["nativeLabelAliases"] = {label: [{"classname": classname, "name": method} for classname, method in keys] for label, keys in aliases.items()}
            outcome["officialNormalizedStatuses"] = {method + " (" + classname + ")": status for (classname, method), status in cases.items()}
        elif profile["runner"] == "sympy":
            if not reader or profile["official_parser"]["function"] != "parse_log_sympy":
                raise ValueError("SymPy requires the official SymPy log parser")
            cases, aliases = sympy_results(log_text, code, reader)
            assessment = grade_cases(task, cases, label_format="sympy", aliases=aliases)
            outcome["nativeLabelNormalization"] = "sympy-file-qualified-verbose-status-v1"
            outcome["nativeLabelAliases"] = {label: [{"filename": filename, "name": name} for filename, name in keys] for label, keys in aliases.items()}
            outcome["officialNormalizedStatuses"] = {filename + ":" + name: status for (filename, name), status in cases.items()}
        else:
            if not xml.exists():
                raise ValueError("Native pytest did not produce its JUnit artifact")
            assessment = grade_cases(task, pytest_results(xml), reader)
        if parser_evidence:
            outcome["officialParser"] = parser_evidence
            outcome["officialLogStatuses"] = official_statuses
        outcome.update(assessment)
        if native_input_identity(task_dir) != input_identity:
            raise ValueError("Native grading inputs changed during execution")
        if assessment["missing"]:
            raise ValueError("Required official test cases are missing")
        if args.kind == "baseline":
            if not baseline_expected(assessment):
                raise ValueError("Baseline does not reproduce the official failure and regressions")
            outcome["status"] = "baseline_verified"
        elif args.kind == "oracle":
            if not assessment["resolved"]:
                raise ValueError("Zero-model official Oracle did not pass")
            outcome["status"] = "oracle_verified"
        else:
            outcome["status"] = "graded"
    except Exception as error:
        outcome.update(status="infrastructure_failure", error=type(error).__name__ + ": " + str(error))
        # git stderr 可能包含补丁正文；原始诊断只保存在私有证据，不进入模型或控制台。
        if isinstance(error, subprocess.CalledProcessError):
            (out / "command.stderr").write_bytes(error.stderr)
    finally:
        outcome["finishedAt"] = time.time()
        outcome["durationSeconds"] = outcome["finishedAt"] - started
        write_json(out / "result.json", outcome)
    print(json.dumps({key: outcome.get(key) for key in ["status", "taskId", "resolved", "caseCount", "missing", "durationSeconds", "error"]}))
    return 0 if outcome["status"] in ["graded", "baseline_verified", "oracle_verified"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--kind", choices=["baseline", "oracle", "source"], required=True)
    parser.add_argument("--source-patch", type=Path)
    raise SystemExit(run(parser.parse_args()))
