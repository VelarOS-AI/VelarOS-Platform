"""Check the unmodified task emulator before interpreting an agent's timeout."""

import datetime
import json
import os
import subprocess
import tomllib
import uuid
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench"
    env = {**os.environ, "DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
           "DOCKER_CONFIG": str(root / "docker-config")}
    if subprocess.check_output(["docker", "ps", "--quiet"], env=env, text=True).strip():
        raise RuntimeError("Run the emulator preflight between paid trials")
    task = root / "datasets/terminal-bench-sample/qemu-startup/task.toml"
    image = tomllib.loads(task.read_text())["environment"]["docker_image"]
    inspection = json.loads(subprocess.check_output(["docker", "image", "inspect", image], env=env, text=True))[0]
    name = "scriptact-qemu-preflight-" + uuid.uuid4().hex[:12]
    command = "ulimit -c 0; qemu-system-x86_64 --version; timeout -k 1 2 qemu-system-x86_64 -machine none -nodefaults -S -display none -monitor none -serial none"
    result = {"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "image": image,
              "image_id": inspection["Id"], "platform": inspection["Os"] + "/" + inspection["Architecture"],
              "command": command, "expected_healthy_exit": 124, "model_calls": 0}
    try:
        completed = subprocess.run(["docker", "run", "--rm", "--pull=never", "--platform=linux/amd64", "--name", name,
            image, "bash", "-c", command], env=env, text=True, capture_output=True, timeout=30)
        result.update({"exit_code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr,
                       "healthy": completed.returncode == 124})
    finally:
        # Only the uniquely named container from this probe is eligible for cleanup.
        subprocess.run(["docker", "rm", "-f", name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        output = root / "campaign" / (name + ".json")
        with output.open("x") as stream:
            json.dump(result, stream, indent=2)
            stream.write("\n")
        print(json.dumps({"evidence": str(output), **result}, indent=2))


if __name__ == "__main__":
    main()
