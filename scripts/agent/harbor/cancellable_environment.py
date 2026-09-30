"""Docker execution cancellation that reaches the container before verification."""

import asyncio
import hashlib
import json
import os
import shlex
import time
import urllib.request
import uuid
from pathlib import Path

from .environment import BenchmarkDocker


def execution_commands(command, directory):
    """A separate process group contains the foreground command and its pipeline."""
    quoted = shlex.quote(directory)
    body = f"""
set -eu
umask 077
mkdir -p {quoted}
printf '%s\\n' "$$" > {quoted}/pid
test ! -e {quoted}/cancelled || exit 125
trap 'rm -f {quoted}/pid' EXIT
bash -c {shlex.quote(command)}
"""
    cleanup = f"""
set -eu
mkdir -p {quoted}
touch {quoted}/cancelled
# The marker also stops a delayed Docker exec that has not written its PID yet.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  test ! -s {quoted}/pid || break
  sleep 0.1
done
if test -s {quoted}/pid; then
  read -r benchmark_pid < {quoted}/pid
  case "$benchmark_pid" in ''|*[!0-9]*) exit 1 ;; esac
  test "$benchmark_pid" -gt 1
  kill -TERM -- "-$benchmark_pid" 2>/dev/null || true
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 -- "-$benchmark_pid" 2>/dev/null || exit 0
    sleep 0.1
  done
  kill -KILL -- "-$benchmark_pid" 2>/dev/null || true
fi
"""
    return "setsid --wait bash -c " + shlex.quote(body), cleanup


async def cancellable_exec(execute, command, **kwargs):
    directory = "/tmp/harbor-exec-" + uuid.uuid4().hex
    wrapped, cleanup = execution_commands(command, directory)
    try:
        return await execute(command=wrapped, **kwargs)
    except (asyncio.CancelledError, Exception):
        # Harbor waits for cancellation to complete before invoking its verifier.
        # Its Docker transport also wraps command deadlines in RuntimeError.
        # Any failed transport leaves execution uncertain; reclaim this command's
        # process group before propagating the original exception.
        # Use the underlying executor so cleanup does not recursively wrap itself.
        result = await asyncio.wait_for(execute(command=cleanup, user="root", timeout_sec=8), timeout=10)
        if result.return_code:
            raise RuntimeError("Container process cancellation failed")
        raise


class CancellableBenchmarkDocker(BenchmarkDocker):
    async def start(self, force_build):
        await super().start(force_build)
        probe = await super().exec(command="command -v setsid && command -v bash", timeout_sec=10)
        if probe.return_code:
            raise RuntimeError("Container cancellation requires Linux setsid and bash")
        self.logger.info("Campaign cancellation adapter SHA-256: %s", hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
        token_file = os.environ.get("SCRIPTACT_BENCH_TOKEN_FILE")
        if not token_file:
            raise RuntimeError("Campaign gateway is required for the execution barrier")
        token = Path(token_file).read_text().strip()
        def health():
            request = urllib.request.Request("http://127.0.0.1:48761/health", headers={"Authorization": "Bearer " + token})
            with urllib.request.urlopen(request, timeout=5) as response:
                return json.load(response)
        started = time.monotonic()
        while True:
            status = await asyncio.to_thread(health)
            active = status.get("activeUpstreamRequests")
            if not isinstance(active, int) or active < 0:
                raise RuntimeError("Gateway must report active upstream requests")
            if not active:
                break
            if time.monotonic() - started >= 300:
                raise RuntimeError("Previous trial provider accounting did not finish within 300 seconds")
            await asyncio.sleep(0.25)
        self.logger.info("Campaign provider idle barrier seconds: %.6f", time.monotonic() - started)

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        return await cancellable_exec(super().exec, command, cwd=cwd, env=env, timeout_sec=timeout_sec, user=user)
