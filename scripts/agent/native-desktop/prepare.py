"""用途：执行冻结原生配置的正常源码构建步骤，模型运行与判分共用同一准备流程。"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def prepare_workspace(profile, workspace, directory):
    commands = profile.get("prepare_commands", [])
    if not commands:
        return []
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    python = str(Path(profile["python"]).absolute())
    environment = {**os.environ, **profile.get("prepare_environment", {})}
    environment["PATH"] = str(Path(python).parent) + os.pathsep + environment["PATH"]
    receipts = []
    try:
        for index, values in enumerate(commands):
            if not values or not all(isinstance(value, str) for value in values):
                raise ValueError("Native prepare command must be a nonempty argument list")
            args = [python if value == "{python}" else value for value in values]
            row = {"args": args, "startedAt": time.time()}
            receipts.append(row)
            with (directory / (str(index) + ".log")).open("wb") as log:
                process = subprocess.Popen(args, cwd=workspace, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    row["exitCode"] = process.wait(timeout=profile.get("prepare_timeout_seconds", 120))
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    row["timedOut"] = True
                    raise ValueError("Native source preparation deadline exceeded")
                finally:
                    row["finishedAt"] = time.time()
            if row["exitCode"]:
                raise ValueError("Native source preparation failed")
    finally:
        path = directory / "receipts.json"
        path.write_text(json.dumps(receipts, indent=2) + "\n")
        path.chmod(0o600)
    return receipts


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--directory", required=True, type=Path)
    values = parser.parse_args()
    prepare_workspace(json.loads(values.profile.read_text()), values.workspace, values.directory)
