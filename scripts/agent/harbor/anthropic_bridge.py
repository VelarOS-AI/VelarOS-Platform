"""Campaign-only Anthropic HTTP facade for the bounded GPT Responses gateway.

LiteLLM supplies the pinned content translation; this service owns the HTTP
transport so disconnects close sockets, including while waiting for headers.
"""

import argparse
import asyncio
import hashlib
import hmac
import importlib.metadata
import json
import os
import time
from pathlib import Path

from request_identity import authenticate_attempt

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["LITELLM_TELEMETRY"] = "False"

import httpx
import uvicorn
from fastapi import FastAPI, Request
from openai import AsyncOpenAI, APIStatusError
from starlette.responses import JSONResponse, StreamingResponse
from litellm.llms.anthropic.experimental_pass_through.responses_adapters.transformation import LiteLLMAnthropicToResponsesAPIAdapter
from litellm.llms.anthropic.experimental_pass_through.responses_adapters.streaming_iterator import AnthropicResponsesStreamWrapper
from litellm.types.llms.openai import ResponsesAPIResponse

MODEL = "gpt-6-sol"
MAX_BODY = 16 * 1024 * 1024
FIELDS = {"model", "messages", "max_tokens", "stream", "system", "tools", "tool_choice", "metadata",
    "thinking", "output_config", "context_management"}
KEEP_THINKING = {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]}
ADAPTER = LiteLLMAnthropicToResponsesAPIAdapter()


def translate(body, diagnostics=None):
    if not isinstance(body, dict) or set(body) - FIELDS:
        raise ValueError("Unsupported request fields")
    if body.get("model") != MODEL or not isinstance(body.get("messages"), list):
        raise ValueError("Expected gpt-6-sol and messages")
    limit = body.get("max_tokens")
    if type(limit) is not int or not 1 <= limit <= 32768:
        raise ValueError("max_tokens must be in 1..32768")
    if type(body.get("stream", False)) is not bool:
        raise ValueError("stream must be boolean")
    if body.get("context_management") not in (None, KEEP_THINKING):
        raise ValueError("Unsupported context edits")
    config = body.get("output_config") or {}
    if not isinstance(config, dict) or set(config) - {"effort"} or config.get("effort", "high") != "high":
        raise ValueError("This campaign requires high reasoning effort")
    if body.get("thinking") not in (None, {"type": "adaptive"}):
        raise ValueError("Unsupported thinking configuration")
    # Native Claude Code places ephemeral boundaries on system/history blocks.
    # The pinned generic adapter otherwise silently discards those boundaries.
    request = json.loads(json.dumps({key: value for key, value in body.items() if key not in ("stream", "context_management")}))
    boundaries = 0
    implicit_boundaries = []
    def map_cache(blocks):
        nonlocal boundaries
        if not isinstance(blocks, list):
            return
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if "cache_control" in block:
                if block["cache_control"] != {"type": "ephemeral"}:
                    raise ValueError("Unsupported cache boundary")
                block.pop("cache_control")
                if block.get("type") in ("tool_use", "tool_result", "thinking", "redacted_thinking"):
                    # Responses explicit markers apply to content parts, not
                    # top-level function/reasoning items. Retain those items and
                    # let the provider's enabled implicit cache handle the prefix.
                    implicit_boundaries.append(block["type"])
                elif block.get("type") in ("text", "image", "document"):
                    block["prompt_cache_breakpoint"] = {"mode": "explicit"}
                    boundaries += 1
                else:
                    raise ValueError("Unsupported cache boundary")
            if block.get("type") == "tool_result":
                map_cache(block.get("content"))
    map_cache(request.get("system"))
    for message in request["messages"]:
        map_cache(message.get("content"))
    if any("cache_control" in tool for tool in request.get("tools", [])):
        raise ValueError("Unsupported tool-definition cache boundary")
    if boundaries > 3:
        raise ValueError("GPT supports at most three explicit cache boundaries")
    result = ADAPTER.translate_request(request, include_encrypted_reasoning=True)
    if json.dumps(result).count('"prompt_cache_breakpoint":') != boundaries:
        raise ValueError("Cache boundaries could not be preserved")
    if diagnostics is not None:
        diagnostics.update({"mapped_explicit_cache_boundaries": boundaries,
            "cache_boundaries_using_implicit_matching": implicit_boundaries})
    result.update({"model": MODEL, "reasoning": {"effort": "high"}, "store": False,
        "stream": body.get("stream", False)})
    return result


def error_response(status, message, kind="invalid_request_error"):
    return JSONResponse({"type": "error", "error": {"type": kind, "message": message}}, status_code=status)


async def until_disconnect(request, operation):
    async def disconnected():
        while (await request.receive())["type"] != "http.disconnect":
            pass
    task = asyncio.create_task(operation)
    watcher = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait((task, watcher), return_when=asyncio.FIRST_COMPLETED)
        if watcher in done:
            raise asyncio.CancelledError()
        return await task
    finally:
        for pending in (task, watcher):
            if not pending.done():
                pending.cancel()
        await asyncio.gather(task, watcher, return_exceptions=True)


def create_app(token, upstream, *, upstream_token=None, evidence_path=None, require_identity=False):
    if not token:
        raise ValueError("A nonempty scoped token is required")
    if importlib.metadata.version("litellm") != "1.103.0":
        raise RuntimeError("Revalidate the adapter before changing LiteLLM 1.103.0")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    state = {"active": 0, "requests": 0}

    def authorized(request):
        candidate = request.headers.get("x-api-key", "")
        if not candidate and request.headers.get("authorization", "").startswith("Bearer "):
            candidate = request.headers["authorization"][7:]
        identity = authenticate_attempt(candidate, token)
        if identity:
            request.state.attempt_identity = identity
            request.state.upstream_credential = candidate
            return True
        return (not require_identity or request.url.path == "/health") and hmac.compare_digest(candidate.encode(), token.encode())

    def record(item):
        if evidence_path:
            with Path(evidence_path).open("a") as output:
                output.write(json.dumps(item) + "\n")

    @app.get("/health")
    async def health(request: Request):
        if not authorized(request):
            return error_response(401, "Authentication required", "authentication_error")
        return {"model": MODEL, "reasoning_effort": "high", **state,
            "bridge_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}

    @app.post("/v1/messages/count_tokens")
    async def count_tokens(request: Request):
        if not authorized(request):
            return error_response(401, "Authentication required", "authentication_error")
        return error_response(501, "Exact Anthropic token counting is unavailable for this GPT bridge")

    @app.post("/v1/messages")
    async def messages(request: Request):
        if not authorized(request):
            return error_response(401, "Authentication required", "authentication_error")
        identity = getattr(request.state, "attempt_identity", None)
        # The gateway enforces phase policy and records rejected attempts without provider dispatch.
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                return error_response(413, "Request exceeds the 16 MiB limit")
        try:
            diagnostics = {}
            params = translate(json.loads(raw), diagnostics)
        except (ValueError, TypeError, KeyError):
            return error_response(400, "Unsupported or malformed campaign request")
        state["requests"] += 1
        request_id = state["requests"]
        started = time.monotonic()
        record({"request": request_id, "identity": identity, "input_items": len(params["input"]),
            "explicit_cache_boundaries": json.dumps(params).count('"prompt_cache_breakpoint":'),
            "max_output_tokens": params["max_output_tokens"], **diagnostics})

        async def perform():
            state["active"] += 1
            outcome = "cancelled"
            try:
                async with AsyncOpenAI(api_key=getattr(request.state, "upstream_credential", None) or upstream_token or token, base_url=upstream, max_retries=0,
                    timeout=httpx.Timeout(900, connect=15), http_client=httpx.AsyncClient(trust_env=False)) as client:
                    response = await client.responses.create(**params)
                    if not params["stream"]:
                        if response.status not in ("completed", "incomplete"):
                            raise RuntimeError("Upstream response did not complete")
                        result = ADAPTER.translate_response(ResponsesAPIResponse(**response.model_dump()))
                        outcome = "completed"
                        yield result
                        return
                    complete = False
                    async def events():
                        nonlocal complete
                        try:
                            async for event in response:
                                if event.type in ("response.failed", "error"):
                                    raise RuntimeError("Upstream stream failed")
                                if event.type in ("response.completed", "response.incomplete"):
                                    complete = True
                                yield event
                        except Exception:
                            # The pinned wrapper logs exceptions before ending iteration.
                            # Do not let arbitrary provider text reach that logger.
                            raise RuntimeError("Upstream stream failed") from None
                    try:
                        wrapper = AnthropicResponsesStreamWrapper(events(), MODEL)
                        async for chunk in wrapper.async_anthropic_sse_wrapper():
                            yield chunk
                        if not complete:
                            raise RuntimeError("Responses stream ended without a terminal response")
                        outcome = "completed"
                    finally:
                        await response.close()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                outcome = "failed"
                # Provider errors may embed headers or input; log bounded classifications only.
                status = error.status_code if isinstance(error, APIStatusError) else 502
                record({"request": request_id, "error_type": type(error).__name__, "upstream_status": status})
                raise
            finally:
                state["active"] -= 1
                record({"request": request_id, "outcome": outcome,
                    "elapsed_seconds": time.monotonic() - started, "stream": params["stream"]})

        if params["stream"]:
            async def stream():
                generator = perform()
                try:
                    async for chunk in generator:
                        yield chunk
                except Exception:
                    yield b'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Upstream response failed; inspect the campaign evidence"}}\n\n'
                finally:
                    await generator.aclose()
            return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
        async def nonstream():
            generator = perform()
            try:
                return await anext(generator)
            finally:
                await generator.aclose()
        try:
            return JSONResponse(await until_disconnect(request, nonstream()))
        except asyncio.CancelledError:
            return error_response(499, "Client disconnected")
        except Exception:
            return error_response(502, "Upstream response failed; inspect the campaign evidence", "api_error")

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--port", type=int, default=48762)
    args = parser.parse_args()
    token = (args.directory / "gateway-token").read_text().strip()
    app = create_app(token, "http://127.0.0.1:48761/v1", evidence_path=args.directory / "anthropic-bridge.jsonl", require_identity=True)
    uvicorn.run(app, host="0.0.0.0", port=args.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
