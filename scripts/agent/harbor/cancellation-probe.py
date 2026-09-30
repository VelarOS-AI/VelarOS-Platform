"""No-model Docker check for cancellation, force-kill, and detached service survival."""

import asyncio
import datetime
import hashlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from scripts.agent.harbor.cancellable_environment import cancellable_exec


async def probe():
    root = Path(__file__).resolve().parents[3]
    work = root / ".velaros-workspace/bench"
    env = {**os.environ, "DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
           "DOCKER_CONFIG": str(work / "docker-config")}
    image = "ubuntu:24.04"
    image_id = subprocess.check_output(["docker", "image", "inspect", image, "--format", "{{.Id}}"], env=env, text=True).strip()
    report = {"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "image": image_id,
              "adapter_sha256": hashlib.sha256(Path(__file__).with_name("cancellable_environment.py").read_bytes()).hexdigest()}
    for mode in ("native", "protected", "transport_timeout"):
        protected = mode != "native"
        name = "scriptact-cancel-probe-" + uuid.uuid4().hex[:12]
        subprocess.run(["docker", "run", "--pull=never", "-d", "--name", name, image, "sleep", "120"], env=env, check=True, stdout=subprocess.DEVNULL)
        processes = []
        async def execute(command, **kwargs):
            process = await asyncio.create_subprocess_exec("docker", "exec", name, "bash", "-c", command,
                        env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            processes.append(process)
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), kwargs.get("timeout_sec"))
            except TimeoutError as error:
                # Harbor 0.23.0's Docker collector translates its deadline into
                # RuntimeError; losing the Docker client does not stop the child.
                process.kill()
                await process.wait()
                raise RuntimeError(f'Command timed out after {kwargs["timeout_sec"]} seconds') from error
            return SimpleNamespace(return_code=process.returncode, stdout=stdout.decode(), stderr=stderr.decode())
        async def lines(path):
            result = await execute("wc -l < " + path)
            if result.return_code:
                raise RuntimeError("Probe heartbeat missing")
            return int(result.stdout.strip())
        try:
            # A previously completed command intentionally leaves a detached service.
            await cancellable_exec(execute, "setsid bash -c 'while :; do echo service >> /tmp/service; sleep 0.1; done' >/dev/null 2>&1 &")
            command = "trap '' TERM; (trap '' TERM; while :; do echo work >> /tmp/work; sleep 0.1; done) & wait"
            started = asyncio.get_running_loop().time()
            timed_out = False
            try:
                if mode == "transport_timeout":
                    await cancellable_exec(execute, command, timeout_sec=0.8)
                else:
                    run = cancellable_exec(execute, command) if protected else execute(command)
                    await asyncio.wait_for(run, 0.8)
            except (TimeoutError, RuntimeError) as error:
                if isinstance(error, RuntimeError) and str(error) != "Command timed out after 0.8 seconds":
                    raise
                timed_out = True
            elapsed = asyncio.get_running_loop().time() - started
            before, service_before = await lines("/tmp/work"), await lines("/tmp/service")
            await asyncio.sleep(0.4)
            after, service_after = await lines("/tmp/work"), await lines("/tmp/service")
            evidence = {"timed_out": timed_out, "elapsed_seconds": elapsed, "work_before": before,
                        "work_after": after, "service_before": service_before, "service_after": service_after}
            report[mode] = evidence
            assert timed_out and service_after > service_before, evidence
            assert (after == before) if protected else (after > before), evidence
            assert elapsed < 10, evidence
        finally:
            subprocess.run(["docker", "rm", "-f", name], env=env, check=True, stdout=subprocess.DEVNULL)
            await asyncio.gather(*(process.wait() for process in processes))
    output = work / "campaign" / ("cancellation-probe-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json")
    with output.open("x") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"evidence": str(output), **report}, indent=2))


if __name__ == "__main__":
    asyncio.run(probe())
