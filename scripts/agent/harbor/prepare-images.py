"""Prefetch a declared task block before paid runs; retain image identities and failures."""

import argparse
import datetime
import json
import os
import subprocess
import tomllib
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks-root", required=True, type=Path)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--all", action="store_true")
    selection.add_argument("--task", action="append")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--pull-timeout", type=int, default=1800)
    args = parser.parse_args()
    if args.pull_timeout < 30:
        parser.error("--pull-timeout must be at least 30 seconds")
    root = Path(__file__).resolve().parents[3]
    files = sorted(args.tasks_root.rglob("task.toml"))
    selected = [f for f in files if args.all or f.parent.name in args.task]
    if not selected or (args.task and set(args.task) - {f.parent.name for f in selected}):
        parser.error("Requested task block is empty or contains unknown task IDs")
    environment = dict(os.environ)
    environment.update({
        "DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(root / ".velaros-workspace/bench/docker-config"),
    })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    evidence = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "tasks_root": str(args.tasks_root.resolve()), "platform": "linux/amd64",
                "pull_timeout_seconds": args.pull_timeout,
                "complete": False, "images": []}
    with args.output.open("x") as stream:
        json.dump(evidence, stream, indent=2)
    for file in selected:
        image = tomllib.loads(file.read_text()).get("environment", {}).get("docker_image")
        if not image:
            raise RuntimeError(f"{file.parent.name}: no prebuilt image; needs a separate build preflight")
        row = {"task": file.parent.name, "image": image, "status": "checking"}
        evidence["images"].append(row)
        args.output.write_text(json.dumps(evidence, indent=2) + "\n")
        try:
            inspection = subprocess.run(["docker", "image", "inspect", image], env=environment,
                                        capture_output=True, text=True, timeout=30)
            if inspection.returncode:
                print(f"Pulling {file.parent.name}", flush=True)
                subprocess.run(["docker", "pull", "--platform", "linux/amd64", image],
                               env=environment, check=True, timeout=args.pull_timeout)
                inspection = subprocess.run(["docker", "image", "inspect", image], env=environment,
                                            capture_output=True, text=True, timeout=30, check=True)
            info = json.loads(inspection.stdout)[0]
            if info.get("Architecture") != "amd64" or info.get("Os") != "linux":
                raise RuntimeError("Campaign bundles require a linux/amd64 image")
            row.update({"status": "ready", "id": info["Id"], "repo_digests": info.get("RepoDigests", []),
                        "size_bytes": info.get("Size"), "architecture": info["Architecture"]})
            print(f"Ready {file.parent.name}: {info['Id']}", flush=True)
        except Exception as error:
            row.update({"status": "failed", "error_type": type(error).__name__, "error": str(error)})
            raise
        finally:
            args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    evidence.update({"complete": True, "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
