"""Exercise the pinned native CLI and Harbor adapter using a local fake model."""

import argparse
import datetime
import hashlib
import http.server
import importlib.util
import json
import os
import socket
import subprocess
import threading
import time
import tomllib
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / ".velaros-workspace/bench"
MARKER = "native-claude-tool-loop"


def stream_message(message):
    events = [{"type": "message_start", "message": {**message, "content": [], "stop_reason": None,
        "usage": {**message["usage"], "output_tokens": 0}}}]
    for index, block in enumerate(message["content"]):
        tool = block["type"] == "tool_use"
        events += [{"type": "content_block_start", "index": index, "content_block": {
            **block, **({"input": {}} if tool else {"text": ""})}},
            {"type": "content_block_delta", "index": index, "delta": {
                "type": "input_json_delta", "partial_json": json.dumps(block["input"])} if tool else {
                "type": "text_delta", "text": block["text"]}},
            {"type": "content_block_stop", "index": index}]
    events += [{"type": "message_delta", "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
        "usage": {"output_tokens": 10}}, {"type": "message_stop"}]
    return b"".join(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode() for event in events)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--through-bridge", action="store_true")
    parser.add_argument("--context-preflight", action="store_true", help="Declare the actual model window and force native compaction with synthetic usage")
    args = parser.parse_args()
    if args.context_preflight and not args.through_bridge:
        parser.error("--context-preflight requires --through-bridge")
    if args.through_bridge:
        import uvicorn
        from scripts.agent.harbor.anthropic_bridge import create_app
        spec = importlib.util.spec_from_file_location("wire_probe", Path(__file__).with_name("anthropic-bridge-probe.py"))
        wire_probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(wire_probe)
    token = (BENCH / "campaign/gateway-token").read_text().strip()
    def health():
        request = urllib.request.Request("http://127.0.0.1:48761/health", headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    # Do not expose host provider credentials to this fixture's child process.
    env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR")}
    env.update({"DOCKER_HOST": "unix://" + str(Path.home() / ".colima/scriptact-bench/docker.sock"),
        "DOCKER_CONFIG": str(BENCH / "docker-config"), "PYTHONPATH": str(ROOT), "HARBOR_TELEMETRY": "0",
        "SCRIPTACT_BENCH_TOKEN_FILE": str(BENCH / "campaign/gateway-token"), "ANTHROPIC_API_KEY": "mock-preflight-only"})
    before = health()
    if before["activeUpstreamRequests"] or subprocess.check_output(["docker", "ps", "--quiet"], env=env, text=True).strip():
        raise RuntimeError("Run the CLI fixture between paid trials on the empty dedicated VM")
    name = "claude-cli-probe-" + uuid.uuid4().hex[:12]
    directory = BENCH / "probes" / name
    task = directory / "task" / "native-cli-tool-loop"
    (task / "environment").mkdir(parents=True)
    (task / "tests").mkdir()
    source = BENCH / "datasets/terminal-bench-sample/regex-log/task.toml"
    image = tomllib.loads(source.read_text())["environment"]["docker_image"]
    (task / "task.toml").write_text(f'''version = "1.0"
[metadata]
category = "fixture"
difficulty = "easy"
[agent]
timeout_sec = 180.0
[verifier]
timeout_sec = 30.0
[environment]
docker_image = "{image}"
build_timeout_sec = 120.0
''')
    (task / "instruction.md").write_text("Use Bash to write " + MARKER + " followed by a newline to /app/probe.txt, then finish.\n")
    (task / "tests/test.sh").write_text('''#!/bin/bash
set -eu
mkdir -p /logs/verifier
printf '0\n' > /logs/verifier/reward.txt
test "$(cat /app/probe.txt)" = "native-claude-tool-loop"
printf '1\n' > /logs/verifier/reward.txt
''')
    requests, lock = [], threading.Lock()
    synthetic_state = {"tools_sent": 0}
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with lock:
                requests.append({"path": self.path, "body": body})
                index = len(requests)
                with (directory / "requests.jsonl").open("a") as log:
                    log.write(json.dumps(requests[-1]) + "\n")
            expected_auth = self.headers.get("Authorization") == "Bearer mock-preflight-only" if args.through_bridge else self.headers.get("x-api-key") == "mock-preflight-only"
            if not expected_auth:
                self.send_error(401)
                return
            if args.through_bridge:
                if self.path != "/v1/responses" or index > (32 if args.context_preflight else 12):
                    self.send_error(400)
                    return
                results = [item for item in body.get("input", []) if item.get("type") == "function_call_output"
                    and item.get("call_id") == "toolu_native_probe"]
                finished = synthetic_state["tools_sent"] >= 8 if args.context_preflight else bool(results)
                tool_id = "toolu_native_probe" if synthetic_state["tools_sent"] == 0 else "toolu_native_probe_" + str(index)
                output = [{"type": "message", "id": "msg_native_probe", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "The task is complete. Bash wrote native-claude-tool-loop to /app/probe.txt and verified it. No more tools are needed.", "annotations": []}]}] if finished else [
                    {"type": "reasoning", "id": "rs_native_probe_" + str(index), "summary": [], "encrypted_content": "synthetic-native-reasoning"},
                    {"type": "function_call", "id": "fc_native_probe_" + str(index), "call_id": tool_id, "name": "Bash",
                        "arguments": json.dumps({"command": "printf '" + MARKER + "\\n' > /app/probe.txt; cat /app/probe.txt",
                            "description": "Write the native CLI probe marker", "timeout": 1000}), "status": "completed"}]
                response = {"id": "resp_native_probe_" + str(index), "object": "response", "created_at": 1,
                    "status": "completed", "model": "gpt-6-sol", "output": output,
                    "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110,
                        "input_tokens_details": {"cached_tokens": 30, "cache_write_tokens": 40},
                        "output_tokens_details": {"reasoning_tokens": 5}}}
                if not finished:
                    synthetic_state["tools_sent"] += 1
                if args.context_preflight and index == 8:
                    response["usage"].update({"input_tokens": 915000, "total_tokens": 915010})
            elif self.path.startswith("/v1/messages/count_tokens"):
                response = {"input_tokens": 100}
            elif not self.path.startswith("/v1/messages") or index > 12:
                self.send_error(400)
                return
            else:
                results = [block for message in body.get("messages", [])
                    for block in (message.get("content") if isinstance(message.get("content"), list) else [])
                    if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") == "toolu_native_probe"]
                content = [{"type": "text", "text": "probe-complete"}] if results else [{"type": "tool_use",
                    "id": "toolu_native_probe", "name": "Bash", "input": {
                        "command": "printf '" + MARKER + "\\n' > /app/probe.txt; cat /app/probe.txt",
                        "description": "Write and read the native CLI probe marker", "timeout": 1000}}]
                response = {"id": "msg_native_probe_" + str(index), "type": "message", "role": "assistant",
                    "model": "gpt-6-sol", "content": content, "stop_reason": "end_turn" if results else "tool_use",
                    "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 10,
                        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}
            streaming = bool(body.get("stream")) and ("content" in response or "output" in response)
            data = (wire_probe.response_events(response) if args.through_bridge else stream_message(response)) if streaming else json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if streaming else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env["ANTHROPIC_BASE_URL"] = f"http://host.docker.internal:{server.server_port}"
    bridge = bridge_thread = bridge_socket = None
    if args.through_bridge:
        bridge_socket = socket.socket()
        bridge_socket.bind(("0.0.0.0", 0))
        bridge_socket.listen()
        app = create_app("mock-preflight-only", f"http://127.0.0.1:{server.server_port}/v1",
            evidence_path=directory / "bridge.jsonl")
        @app.middleware("http")
        async def capture_fixture_body(request, call_next):
            if request.method == "POST":
                body = await request.body()
                with (directory / "frontend-requests.jsonl").open("a") as log:
                    log.write(json.dumps({"path": request.url.path, "body": json.loads(body)}) + "\n")
            return await call_next(request)
        bridge = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="warning"))
        bridge_thread = threading.Thread(target=lambda: bridge.run(sockets=[bridge_socket]), daemon=True)
        bridge_thread.start()
        deadline = time.monotonic() + 10
        while not bridge.started:
            if not bridge_thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("Local bridge did not start")
            time.sleep(.01)
        env["ANTHROPIC_BASE_URL"] = f"http://host.docker.internal:{bridge_socket.getsockname()[1]}"
    evidence = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "running",
        "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "model_calls": 0,
        "scope": "Native Claude Code and Harbor integration with synthetic HTTP responses, not benchmark performance.",
        "gateway_requests_before": before["requests"], "task_image": image, "through_bridge": args.through_bridge}
    if args.through_bridge:
        evidence["bridge_sha256"] = hashlib.sha256(Path(__file__).with_name("anthropic_bridge.py").read_bytes()).hexdigest()
        evidence["scope"] = "Native Claude Code through the GPT Responses bridge, with a synthetic upstream; no performance claim."
    if args.context_preflight:
        evidence["synthetic_context_stress"] = {"context_window": 1050000, "auto_compact_window": 900000,
            "max_output_tokens": 32768, "stress_response_index": 8, "stress_input_tokens": 915000}
        env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "32768"
    try:
        command = [str(BENCH / "venv/bin/harbor"), "run", "--path", str(task), "--job-name", name,
            "--jobs-dir", str(directory / "jobs"), "--max-retries", "0", "-n", "1", "-k", "1",
            "-e", "scripts.agent.harbor.cancellable_environment:CancellableBenchmarkDocker",
            "-a", "scripts.agent.harbor.portable_claude_code:PortableClaudeCode", "-m", "gpt-6-sol",
            "--ak", "version=2.1.283", "--ak", "reasoning_effort=high", "--ak", "max_turns=" + ("20" if args.context_preflight else "4"),
            "--ak", "allowed_tools=Bash", "--ak", "disallowed_tools=WebSearch",
            "--ak", "bundle=" + str(BENCH / "comparison/claude-code-2.1.283-linux-x64.tgz")]
        if args.context_preflight:
            for value in ("CLAUDE_CODE_MAX_CONTEXT_TOKENS=1050000", "CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000", "CLAUDE_CODE_MAX_OUTPUT_TOKENS=32768"):
                command += ["--ae", value]
        with (directory / "harbor.log").open("x") as log:
            completed = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=600)
        evidence["return_code"] = completed.returncode
        results = list((directory / "jobs" / name).glob("*/result.json"))
        if completed.returncode or len(results) != 1:
            raise RuntimeError("Native CLI fixture did not produce one completed Harbor trial")
        result = json.loads(results[0].read_text())
        evidence.update({"trial_result": str(results[0]), "agent_info": result.get("agent_info"),
            "reward": (result.get("verifier_result") or {}).get("rewards", {}).get("reward"),
            "exception_type": (result.get("exception_info") or {}).get("exception_type")})
        if evidence["reward"] != 1 or evidence["exception_type"]:
            raise AssertionError("The actual CLI did not complete the synthetic tool loop")
        if args.context_preflight:
            agent_directory = results[0].parent / "agent"
            events = [json.loads(line) for line in (agent_directory / "claude-code.txt").read_text().splitlines() if line.startswith("{")]
            final = next(event for event in reversed(events) if event.get("type") == "result")
            evidence["native_model_usage"] = final["modelUsage"]
            usage = final["modelUsage"]["gpt-6-sol"]
            assert usage["contextWindow"] == 1050000
            # modelUsage reports the model's built-in output default; inspect the
            # real HTTP body to verify the launch-specific output override.
            assert requests[0]["body"]["max_output_tokens"] == 32768
            boundaries = [event for event in events if event.get("subtype") == "compact_boundary"]
            evidence["compaction_boundaries"] = boundaries
            assert boundaries, "Synthetic high usage did not exercise native compaction"
        messages = [r["body"] for r in requests if not r["path"].startswith("/v1/messages/count_tokens")]
        assert len(messages) >= 2 and all(m.get("model") == "gpt-6-sol" for m in messages)
        if args.through_bridge:
            assert all(m.get("reasoning", {}).get("effort") == "high" and m.get("store") is False for m in messages)
            assert any(item.get("type") == "function_call_output" and item.get("call_id") == "toolu_native_probe"
                and MARKER in json.dumps(item.get("output")) for m in messages[1:] for item in m["input"])
            assert any(item.get("type") == "reasoning" and item.get("encrypted_content") == "synthetic-native-reasoning"
                for m in messages[1:] for item in m["input"])
        else:
            assert any(block.get("tool_use_id") == "toolu_native_probe" and MARKER in json.dumps(block.get("content"))
                for message in messages[1:] for item in message.get("messages", [])
                for block in (item.get("content") if isinstance(item.get("content"), list) else [])
                if isinstance(block, dict) and block.get("type") == "tool_result")
        evidence["status"] = "passed"
    except BaseException as error:
        evidence.update({"status": "failed", "error_type": type(error).__name__, "error": str(error)})
        raise
    finally:
        if bridge:
            bridge.should_exit = True
            bridge_thread.join(timeout=10)
            bridge_socket.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        evidence.update({"finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "http_requests": len(requests)})
        after = health()
        evidence["gateway_requests_after"] = after["requests"]
        if after["requests"] != before["requests"]:
            evidence.update({"status": "failed", "error": "Gateway request count changed during the isolated fixture"})
        (directory / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps({"evidence": str(directory / "result.json"), "status": evidence["status"]}))


if __name__ == "__main__":
    main()
