"""Real local HTTP checks; no real provider credentials or paid API requests."""

import asyncio
import contextlib
import importlib.util
import json
import socket
import unittest
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse, StreamingResponse

from scripts.agent.harbor.anthropic_bridge import create_app, translate, until_disconnect

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("wire_probe", Path(__file__).with_name("anthropic-bridge-probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@contextlib.asynccontextmanager
async def serve(app):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        while not server.started:
            if task.done():
                await task
            await asyncio.sleep(0.01)
        yield "http://127.0.0.1:" + str(sock.getsockname()[1])
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 5)
        sock.close()


def response(index=1):
    output = [{"type": "function_call", "id": "fc_native_probe", "call_id": "toolu_native_probe", "name": "Bash",
        "arguments": json.dumps({"command": "printf 'native-claude-tool-loop\\n' > /app/probe.txt; cat /app/probe.txt",
            "description": "Write the probe marker", "timeout": 1000}), "status": "completed"}] if index == 1 else [
        {"type": "message", "id": "msg_done", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": "done", "annotations": []}]}]
    return {"id": "resp_probe_" + str(index), "object": "response", "created_at": 1,
        "status": "completed", "model": "gpt-6-sol", "output": output,
        "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110,
            "input_tokens_details": {"cached_tokens": 30, "cache_write_tokens": 40},
            "output_tokens_details": {"reasoning_tokens": 5}}}


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = contextlib.AsyncExitStack()
        self.requests = []
        self.started = asyncio.Event()
        self.closed = asyncio.Event()
        self.mode = "normal"
        upstream = FastAPI()

        @upstream.post("/v1/responses")
        async def responses(request: Request):
            body = await request.json()
            self.requests.append(body)
            self.started.set()
            if self.mode == "headers":
                try:
                    await until_disconnect(request, asyncio.sleep(60))
                except asyncio.CancelledError:
                    self.closed.set()
                return JSONResponse({}, status_code=499)
            if self.mode == "error":
                return JSONResponse({"error": {"message": "sensitive-mock-secret", "type": "api_error"}}, status_code=429)
            value = response(len(self.requests))
            if body.get("stream"):
                async def chunks():
                    try:
                        if self.mode == "stall":
                            yield b'event: response.created\ndata: {"type":"response.created"}\n\n'
                            await asyncio.sleep(60)
                        elif self.mode == "truncated":
                            yield b'event: response.created\ndata: {"type":"response.created"}\n\n'
                        elif self.mode == "failed_event":
                            yield ("event: response.failed\ndata: " + json.dumps({"type": "response.failed", "response": {
                                **value, "status": "failed", "output": [], "error": {"code": "server_error", "message": "sensitive-mock-secret"}}}) + "\n\n").encode()
                        else:
                            yield probe.response_events(value)
                    finally:
                        self.closed.set()
                return StreamingResponse(chunks(), media_type="text/event-stream")
            return value

        upstream_url = await self.stack.enter_async_context(serve(upstream))
        self.url = await self.stack.enter_async_context(serve(create_app("test-scoped-token", upstream_url + "/v1")))
        self.client = await self.stack.enter_async_context(httpx.AsyncClient(base_url=self.url,
            headers={"x-api-key": "test-scoped-token"}, trust_env=False, timeout=10))
        self.body = {"model": "gpt-6-sol", "max_tokens": 32000, "messages": [{"role": "user", "content": "Run the probe"}],
            "thinking": {"type": "adaptive"}, "output_config": {"effort": "high"}}

    async def asyncTearDown(self):
        await self.stack.aclose()

    async def test_native_corpus_stream_and_nonstream(self):
        corpus = ROOT / ".velaros-workspace/bench/probes/claude-cli-probe-e00def54f969/requests.jsonl"
        if not corpus.exists():
            self.skipTest("Pinned native CLI corpus is not present")
        bodies = [json.loads(line)["body"] for line in corpus.read_text().splitlines()]
        for streaming in (False, True):
            self.requests.clear()
            for index, body in enumerate(bodies):
                result = await self.client.post("/v1/messages?beta=true", json={**body, "stream": streaming})
                self.assertEqual(result.status_code, 200)
                if streaming:
                    async def chunks():
                        yield result.content
                    value = await probe.read_response(chunks(), True)
                else:
                    value = result.json()
                self.assertEqual(value["usage"], {"input_tokens": 30, "output_tokens": 10,
                    "cache_creation_input_tokens": 40, "cache_read_input_tokens": 30})
                self.assertEqual(value["stop_reason"], "tool_use" if index == 0 else "end_turn")
            first, second = self.requests
            for body in self.requests:
                self.assertEqual(body["model"], "gpt-6-sol")
                self.assertEqual(body["reasoning"], {"effort": "high"})
                self.assertFalse(body["store"])
                self.assertNotIn("previous_response_id", body)
                self.assertIn("reasoning.encrypted_content", body["include"])
                self.assertEqual(json.dumps(body).count('"prompt_cache_breakpoint":'), 3)
            calls = [item for item in second["input"] if item.get("type") == "function_call"]
            results = [item for item in second["input"] if item.get("type") == "function_call_output"]
            self.assertEqual(calls[0]["call_id"], results[0]["call_id"])
            self.assertIn("native-claude-tool-loop", json.dumps(results[0]["output"]))
            self.assertEqual(len(first["tools"]), len(bodies[0]["tools"]))

    async def test_auth_validation_and_no_provider_routing_override(self):
        result = await self.client.post("/v1/messages", json=self.body, headers={"x-api-key": "wrong"})
        self.assertEqual(result.status_code, 401)
        for update in ({"model": "other"}, {"api_base": "https://untrusted.invalid"}, {"max_tokens": 32769},
            {"output_config": {"effort": "low"}}, {"context_management": {"edits": [{"type": "clear_tool_uses_20250919"}]}}):
            result = await self.client.post("/v1/messages", json={**self.body, **update})
            self.assertEqual(result.status_code, 400)
        result = await self.client.post("/v1/messages/count_tokens", json=self.body)
        self.assertEqual(result.status_code, 501)
        self.assertEqual(self.requests, [])

    async def test_disconnect_before_upstream_headers(self):
        for streaming in (False, True):
            self.mode = "headers"
            self.started.clear()
            self.closed.clear()
            pending = asyncio.create_task(self.client.post("/v1/messages", json={**self.body, "stream": streaming}))
            await asyncio.wait_for(self.started.wait(), 5)
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            await asyncio.wait_for(self.closed.wait(), 5)
            for _ in range(100):
                health = (await self.client.get("/health")).json()
                if health["active"] == 0:
                    break
                await asyncio.sleep(.01)
            self.assertEqual(health["active"], 0)

    async def test_disconnect_during_stream_closes_upstream(self):
        self.mode = "stall"
        async with self.client.stream("POST", "/v1/messages", json={**self.body, "stream": True}) as result:
            async for chunk in result.aiter_bytes():
                if chunk:
                    break
        await asyncio.wait_for(self.closed.wait(), 5)

    async def test_error_redaction_and_truncated_stream(self):
        self.mode = "error"
        for streaming in (False, True):
            result = await self.client.post("/v1/messages", json={**self.body, "stream": streaming})
            self.assertNotIn("sensitive-mock-secret", result.text)
            self.assertIn("Upstream response failed", result.text)
        self.mode = "truncated"
        result = await self.client.post("/v1/messages", json={**self.body, "stream": True})
        self.assertIn("event: error", result.text)
        self.assertNotIn("event: message_stop", result.text)
        self.mode = "failed_event"
        result = await self.client.post("/v1/messages", json={**self.body, "stream": True})
        self.assertIn("event: error", result.text)
        self.assertNotIn("event: message_stop", result.text)
        self.assertNotIn("sensitive-mock-secret", result.text)

    async def test_encrypted_reasoning_roundtrip(self):
        from scripts.agent.harbor.anthropic_bridge import ADAPTER
        from litellm.types.llms.openai import ResponsesAPIResponse
        value = response()
        value["output"].insert(0, {"type": "reasoning", "id": "rs_probe", "summary": [], "encrypted_content": "synthetic-encrypted-content"})
        translated = ADAPTER.translate_response(ResponsesAPIResponse(**value))
        request = translate({**self.body, "messages": self.body["messages"] + [{"role": "assistant", "content": translated["content"]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_native_probe", "content": "done"}]}]})
        reasoning = [item for item in request["input"] if item.get("type") == "reasoning"]
        self.assertEqual(reasoning[0]["encrypted_content"], "synthetic-encrypted-content")

    async def test_native_compaction_tool_boundary_uses_implicit_cache_without_losing_history(self):
        corpus = ROOT / ".velaros-workspace/bench/probes/claude-cli-probe-805588f7eb01/frontend-requests.jsonl"
        if not corpus.exists():
            self.skipTest("Pinned native compaction request is not present")
        body = json.loads(corpus.read_text().splitlines()[8])["body"]
        diagnostics = {}
        mapped = translate(body, diagnostics)
        self.assertEqual(diagnostics["mapped_explicit_cache_boundaries"], 2)
        self.assertEqual(diagnostics["cache_boundaries_using_implicit_matching"], ["tool_use"])
        native_calls = [block["id"] for message in body["messages"] for block in message.get("content", [])
            if isinstance(block, dict) and block.get("type") == "tool_use"]
        self.assertEqual([item["call_id"] for item in mapped["input"] if item.get("type") == "function_call"], native_calls)
        result = await self.client.post("/v1/messages", json=body)
        self.assertEqual(result.status_code, 200)
        self.assertIn("event: message_stop", result.text)


if __name__ == "__main__":
    unittest.main()


class ScopedBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_signed_attempt_is_forwarded_without_substitution_by_controller_token(self):
        from request_identity import attempt_credential
        identity = dict(campaignId='campaign', candidateId='candidate', participantId='bridge',
            taskId='task', attemptId='attempt', jobId='job', phase='source')
        token = attempt_credential(identity, 'controller-fixture')
        seen = []
        app = FastAPI()

        @app.post('/v1/responses')
        async def upstream(request: Request):
            seen.append(request.headers.get('authorization'))
            await request.json()
            return response(2)

        async with serve(app) as upstream_url:
            bridge = create_app('controller-fixture', upstream_url + '/v1', require_identity=True)
            async with serve(bridge) as bridge_url:
                async with httpx.AsyncClient(base_url=bridge_url, trust_env=False) as client:
                    body = {'model': 'gpt-6-sol', 'max_tokens': 200, 'messages': [{'role': 'user', 'content': 'fixture'}]}
                    self.assertEqual((await client.post('/v1/messages', headers={'x-api-key': token}, json=body)).status_code, 200)
                    self.assertEqual(seen, ['Bearer ' + token])
                    for credential in ('controller-fixture',):
                        result = await client.post('/v1/messages', headers={'x-api-key': credential}, json=body)
                        self.assertIn(result.status_code, (401, 403))
                    self.assertEqual(len(seen), 1)
