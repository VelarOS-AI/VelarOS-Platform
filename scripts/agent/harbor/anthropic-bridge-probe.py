"""Local-only wire check for a future Claude Code plus GPT bridge experiment."""

import asyncio
import argparse
import datetime
import hashlib
import importlib.metadata
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["LITELLM_TELEMETRY"] = "False"

import litellm
from litellm.llms.anthropic.experimental_pass_through.messages.handler import anthropic_messages


def response_events(response):
    events = [{"type": "response.created", "response": {**response, "status": "in_progress", "output": [], "usage": None}}]
    for index, item in enumerate(response["output"]):
        initial = {**item, "status": "in_progress"}
        if item["type"] == "function_call":
            initial["arguments"] = ""
        elif item["type"] == "message":
            initial["content"] = []
        else:
            initial.pop("encrypted_content", None)
        events.append({"type": "response.output_item.added", "output_index": index, "item": initial})
        if item["type"] == "function_call":
            events += [{"type": "response.function_call_arguments.delta", "output_index": index, "item_id": item["id"], "delta": item["arguments"]},
                       {"type": "response.function_call_arguments.done", "output_index": index, "item_id": item["id"], "arguments": item["arguments"]}]
        elif item["type"] == "message":
            part = item["content"][0]
            location = {"output_index": index, "item_id": item["id"], "content_index": 0}
            events += [{"type": "response.content_part.added", **location, "part": {**part, "text": ""}},
                       {"type": "response.output_text.delta", **location, "delta": part["text"]},
                       {"type": "response.output_text.done", **location, "text": part["text"]},
                       {"type": "response.content_part.done", **location, "part": part}]
        events.append({"type": "response.output_item.done", "output_index": index, "item": item})
    events.append({"type": "response.completed", "response": response})
    return b"".join(("event: " + event["type"] + "\ndata: " + json.dumps({**event, "sequence_number": index}) + "\n\n").encode()
                    for index, event in enumerate(events))


async def read_response(response, streaming):
    if not streaming:
        return response
    chunks = [chunk async for chunk in response]
    events = [json.loads(line[6:]) for line in b"".join(chunks).decode().splitlines() if line.startswith("data: ")]
    message = dict(next(event["message"] for event in events if event["type"] == "message_start"))
    blocks, inputs = {}, {}
    for event in events:
        if event["type"] == "content_block_start":
            blocks[event["index"]] = dict(event["content_block"])
        elif event["type"] == "content_block_delta":
            index, delta = event["index"], event["delta"]
            if delta["type"] == "input_json_delta":
                inputs[index] = inputs.get(index, "") + delta["partial_json"]
            elif delta["type"] == "text_delta":
                blocks[index]["text"] = blocks[index].get("text", "") + delta["text"]
        elif event["type"] == "message_delta":
            message.update(event["delta"])
            message["usage"].update(event.get("usage", {}))
    assert events[-1]["type"] == "message_stop"
    for index, value in inputs.items():
        blocks[index]["input"] = json.loads(value)
    message["content"] = [blocks[index] for index in sorted(blocks)]
    return message


async def probe(streaming=False):
    litellm.telemetry = False
    litellm.register_model({"gpt-6-sol": {"max_input_tokens": 922000, "max_output_tokens": 32768,
        "max_tokens": 1050000, "input_cost_per_token": 0.000002, "output_cost_per_token": 0.00001,
        "cache_creation_input_token_cost": 0.0000025, "cache_read_input_token_cost": 0.0000002,
        "litellm_provider": "openai", "mode": "chat", "supports_reasoning": True}})
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            requests.append({"path": self.path, "body": body})
            index = len(requests)
            output = [{"type": "function_call", "id": "fc_probe_1", "call_id": "call_probe_1",
                "name": "inspect", "arguments": '{"path":"source.txt"}', "status": "completed"}] if index == 1 else [
                {"type": "message", "id": "msg_probe_2", "role": "assistant", "status": "completed",
                 "content": [{"type": "output_text", "text": "done", "annotations": []}]}]
            response = {"id": f"resp_probe_{index}", "object": "response", "created_at": 1,
                "status": "completed", "model": "gpt-6-sol", "output": output,
                "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110,
                    "input_tokens_details": {"cached_tokens": 30, "cache_write_tokens": 40},
                    "output_tokens_details": {"reasoning_tokens": 5}}}
            data = response_events(response) if body.get("stream") else json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    evidence = {"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "litellm_version": importlib.metadata.version("litellm"), "real_model_calls": 0,
        "streaming": streaming,
        "scope": "Local adapter check only; Claude Code CLI and cancellation remain unverified.",
        "status": "running", "requests": requests}
    try:
        messages = [{"role": "user", "content": "Inspect source.txt then finish."}]
        options = {"model": "openai/gpt-6-sol", "max_tokens": 1000,
            "tools": [{"name": "inspect", "description": "Inspect a file", "input_schema": {
                "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}],
            "api_base": f"http://127.0.0.1:{server.server_port}/v1", "api_key": "mock-only",
            "reasoning_effort": "high", "store": False, "stream": streaming,
            "additional_drop_params": ["context_management"], "num_retries": 0}
        first = await read_response(await anthropic_messages(messages=messages, **options), streaming)
        tool = next(block for block in first["content"] if block["type"] == "tool_use")
        assert tool["name"] == "inspect" and tool["input"] == {"path": "source.txt"}
        messages += [{"role": "assistant", "content": first["content"]}, {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool["id"], "content": "source contents"}]}]
        second = await read_response(await anthropic_messages(messages=messages, **options), streaming)
        assert any(block.get("text") == "done" for block in second["content"])
        assert len(requests) == 2
        for request in requests:
            body = request["body"]
            assert request["path"] == "/v1/responses"
            assert body["model"] == "gpt-6-sol" and body["reasoning"]["effort"] == "high"
            assert body["store"] is False and not body.get("previous_response_id")
        history = requests[1]["body"]["input"]
        calls = [item for item in history if item.get("type") == "function_call"]
        results = [item for item in history if item.get("type") == "function_call_output"]
        assert calls and results and calls[0]["call_id"] == results[0]["call_id"]
        assert any(item.get("role") == "user" for item in history)
        assert results[0]["output"] == "source contents"
        for response in (first, second):
            assert response["usage"] == {"input_tokens": 30, "output_tokens": 10,
                "cache_creation_input_tokens": 40, "cache_read_input_tokens": 30}
        evidence.update({"status": "passed", "responses": [first, second]})
    except BaseException as error:
        evidence.update({"status": "failed", "error_type": type(error).__name__, "error": str(error)})
        raise
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        output = Path(__file__).resolve().parents[3] / ".velaros-workspace/bench/campaign" / (
            "anthropic-bridge-wire-probe-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
        with output.open("x") as stream:
            json.dump(evidence, stream, indent=2, default=str)
            stream.write("\n")
        print(json.dumps({"evidence": str(output), "status": evidence["status"], "real_model_calls": 0}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stream", action="store_true")
    asyncio.run(probe(parser.parse_args().stream))
