"""Run trusted repair checks once and reuse only matching, intact terminal evidence.

The reviewed plan declares non-imported fixtures and external dependencies. Local
Python imports and unittest discovery membership are added automatically. This
runner does not certify that a caller's declared dependency scope is complete.
"""

import argparse
import ast
import datetime
import fnmatch
import hashlib
import json
import math
import os
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


def inside(root, value):
    path = Path(value)
    path = (root / path).resolve() if not path.is_absolute() else path.resolve()
    if not path.is_relative_to(root):
        raise ValueError("Validation path leaves its declared workspace")
    return path


def import_inputs(root, seeds, search_paths=()):
    """Bind local static imports, including package initializers and from children."""
    pending, seen = list(seeds), set()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        if not path.is_file():
            raise ValueError("Validation input is not a regular file")
        seen.add(path)
        if path.suffix != ".py":
            continue
        tree = ast.parse(path.read_bytes(), filename=str(path))
        modules = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.extend((name.name, 0) for name in node.names)
            elif isinstance(node, ast.ImportFrom):
                modules.append((node.module or "", node.level))
                modules.extend(((node.module + "." if node.module else "") + name.name,
                                node.level) for name in node.names if name.name != "*")
        for module, level in modules:
            bases = [path.parent, *search_paths, root]
            if level:
                base = path.parent
                for _ in range(level - 1):
                    base = base.parent
                bases = [base]
            for base in bases:
                target = base.joinpath(*module.split(".")) if module else base
                options = [target.with_suffix(".py"), target / "__init__.py"]
                found = next((item for item in options if item.is_file()), None)
                if found is None:
                    continue
                found = inside(root, found)
                pending.append(found)
                parent = found.parent
                while parent.is_relative_to(root):
                    initializer = parent / "__init__.py"
                    if initializer.is_file():
                        pending.append(inside(root, initializer))
                    if parent == root:
                        break
                    parent = parent.parent
    return sorted(seen)


def check_contract(root, check):
    argv = check.get("command")
    if (not isinstance(argv, list) or not argv or
            any(not isinstance(item, str) or not item or "\x00" in item for item in argv)):
        raise ValueError("Freeze a nonempty executable argument list")
    timeout = check.get("timeout_seconds", 120)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Validation timeout must be positive and finite")
    cwd = inside(root, check.get("cwd", "."))
    declared = check.get("inputs")
    if not isinstance(declared, list) or not declared:
        raise ValueError("Declare the reviewed source, fixture and dependency inputs")
    seeds = [inside(root, name) for name in declared]
    discovery = []
    search_paths = [cwd]
    if "unittest" in argv and "discover" in argv:
        parser = argparse.ArgumentParser(add_help=False, exit_on_error=False)
        parser.add_argument("-s", "--start-directory")
        parser.add_argument("-p", "--pattern")
        parser.add_argument("-t", "--top-level-directory")
        parser.add_argument("-k", action="append")
        for flag in ("-v", "-q", "-f", "-c", "-b", "--locals"):
            parser.add_argument(flag, action="store_true")
        parser.add_argument("paths", nargs="*")
        try:
            selected, unknown = parser.parse_known_args(argv[argv.index("discover") + 1:])
        except argparse.ArgumentError as error:
            raise ValueError("Invalid unittest discovery arguments") from error
        if unknown or len(selected.paths) > 3:
            raise ValueError("Unsupported unittest discovery arguments")
        directory_name = selected.start_directory or (selected.paths[0] if selected.paths else ".")
        pattern = selected.pattern or (selected.paths[1] if len(selected.paths) > 1 else "test*.py")
        directory = inside(root, cwd / directory_name)
        top = selected.top_level_directory or (selected.paths[2] if len(selected.paths) > 2 else None)
        search_paths += [directory, inside(root, cwd / top) if top is not None else directory]
        discovery = sorted(inside(root, p) for p in directory.rglob("*.py")
                           if fnmatch.fnmatch(p.name, pattern))
        seeds += discovery
        if not discovery:
            raise ValueError("Discovery selected no tests")
    environment = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT")
                   if name in os.environ}
    environment.update(PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1")
    overrides = check.get("environment", {})
    if not isinstance(overrides, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                              for k, v in overrides.items()):
        raise ValueError("Validation environment must contain string pairs")
    environment.update(overrides)
    if "PYTHONPATH" in environment:
        search_paths += [inside(root, cwd / p) for p in environment["PYTHONPATH"].split(os.pathsep)]
    files = import_inputs(root, seeds, search_paths)
    if (os.sep in argv[0] and not Path(argv[0]).is_absolute()) or (
            os.sep not in argv[0] and any(not Path(p).is_absolute() for p in environment.get("PATH", "").split(os.pathsep))):
        raise ValueError("Freeze an absolute executable path or an absolute search PATH")
    executable = shutil.which(argv[0], path=environment.get("PATH", ""))
    if not executable:
        raise ValueError("Validation executable is unavailable")
    invocation = str(Path(executable).absolute())
    executable = str(Path(invocation).resolve())
    inputs = {str(p.relative_to(root)): digest(p) for p in files}
    value = {"id": check["id"], "workspace": str(root), "command": argv, "cwd": str(cwd.relative_to(root)),
             "timeout_seconds": timeout, "inputs_sha256": inputs,
             "discovery_membership": [str(p.relative_to(root)) for p in discovery],
             "environment_sha256": canonical(environment),
             "executable_invocation": invocation, "executable": executable, "executable_sha256": digest(executable),
             "validator_sha256": digest(__file__), "platform": platform.platform(),
             "validator_python": sys.version}
    return value, environment


def reusable(prior, contract, root):
    if (not isinstance(prior, dict) or prior.get("status") not in ("passed", "reused")
            or prior.get("exit_code") != 0 or prior.get("contract") != contract
            or prior.get("inputs_stable") is not True):
        return False
    try:
        log = inside(root, prior["log"])
        return log.is_file() and digest(log) == prior["log_sha256"]
    except (KeyError, OSError, ValueError, TypeError):
        return False


def terminate_group(process):
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        process.kill()
    try:
        process.wait(timeout=5)
        return True
    except subprocess.TimeoutExpired:
        return False


def cancel_check(_signum, _frame):
    raise KeyboardInterrupt


def run_checks(plan, output, previous=(), execute=False):
    if execute and threading.current_thread() is not threading.main_thread():
        raise ValueError("Run checks on the main thread so cancellation can reap its process group")
    root = Path(plan["root"]).resolve()
    checks = plan.get("checks")
    if (not isinstance(checks, list) or not checks or
            any(not isinstance(c.get("id"), str) or not c["id"] for c in checks)
            or len({c["id"] for c in checks}) != len(checks)):
        raise ValueError("Freeze distinct validation check identities")
    output = inside(root, output)
    output.mkdir(parents=True, exist_ok=False)
    old = [item for receipt in previous if isinstance(receipt, dict)
           and receipt.get("schema") == 1 for item in receipt.get("checks", [])]
    rows = []
    started = time.monotonic()
    for index, check in enumerate(checks):
        contract, environment = check_contract(root, check)
        prior = next((r for r in old if reusable(r, contract, root)), None)
        if prior:
            rows.append({**prior, "status": "reused", "duration_seconds": 0,
                         "original_duration_seconds": prior.get("original_duration_seconds", prior.get("duration_seconds"))})
            continue
        if not execute:
            rows.append({"id": check["id"], "status": "planned", "contract": contract})
            continue
        log = output / f"check-{index + 1}.log"
        began = time.monotonic()
        cleanup, process = None, None
        status, code = "failed", None
        with log.open("xb") as stream:
            prior_handler = signal.signal(signal.SIGTERM, cancel_check)
            try:
                command = [contract["executable_invocation"], *contract["command"][1:]]
                process = subprocess.Popen(command, cwd=inside(root, contract["cwd"]),
                    env=environment, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                code = process.wait(timeout=contract["timeout_seconds"])
                status = "passed" if code == 0 else "failed"
            except subprocess.TimeoutExpired:
                status, cleanup = "timeout", terminate_group(process)
            except KeyboardInterrupt:
                status, cleanup = "cancelled", terminate_group(process) if process else True
            except OSError:
                status = "launch_failed"
            finally:
                signal.signal(signal.SIGTERM, prior_handler)
        try:
            after, _ = check_contract(root, check)
            stable = after == contract
        except (OSError, ValueError, SyntaxError):
            stable = False
        if not stable:
            status = "inputs_changed"
        rows.append({"id": check["id"], "status": status, "contract": contract,
                     "exit_code": code, "inputs_stable": stable,
                     "duration_seconds": time.monotonic() - began,
                     "log": str(log), "log_sha256": digest(log),
                     "timed_out_or_cancelled_parent_reaped": cleanup})
        if status == "cancelled":
            break
    result = {"schema": 1, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "status": "passed" if len(rows) == len(checks) and all(r["status"] in ("passed", "reused") for r in rows)
                        else "planned" if all(r["status"] in ("planned", "reused") for r in rows) else "failed",
              "plan_sha256": canonical(plan), "duration_seconds": time.monotonic() - started,
              "checks": rows, "scope": "reviewed declared dependencies plus local static imports and discovery membership"}
    (output / "validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse", type=Path, action="append", default=[])
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    previous = []
    for path in args.reuse:
        try:
            previous.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            pass
    result = run_checks(json.loads(args.plan.read_text()), args.output, previous, args.run)
    print(json.dumps({"status": result["status"], "duration_seconds": result["duration_seconds"],
                      "checks": [{"id": r["id"], "status": r["status"]} for r in result["checks"]]}))
    return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
