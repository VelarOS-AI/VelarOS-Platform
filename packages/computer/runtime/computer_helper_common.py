#!/usr/bin/env python3
"""Shared stdio JSON-RPC loop for the VelarOS computer-use desktop helpers.

The TypeScript sidecar manager (`ComputerSidecarManager`) spawns one of the
platform helpers (`mac_helper.py` / `win_helper.py` / `linux_helper.py`) and
talks to it over a line-delimited JSON protocol on stdin/stdout:

    request  (stdin) : {"id": <number>, "command": <string>, "payload": {...}}\n
    response (stdout): {"id": <number>, "ok": true,  "result": <any>}\n
                       {"id": <number>, "ok": false, "error": {"code","message"}}\n

Each platform helper provides a `dispatch(command, payload) -> Any` callable and
calls `run_stdio_loop(dispatch)`. Keeping the protocol here means both platform
helpers stay tiny and the wire format can never drift between them.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Callable

Dispatch = Callable[[str, "dict[str, Any]"], Any]


def _write(payload: "dict[str, Any]") -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def run_stdio_loop(dispatch: Dispatch) -> int:
    """Read newline-delimited JSON requests until stdin closes."""
    # Announce readiness so the manager can detect a healthy helper without
    # issuing a real command. id=0 is reserved for this handshake.
    _write({"id": 0, "ok": True, "result": {"ready": True}})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            command = str(request.get("command") or "")
            payload = request.get("payload") or {}
            if not isinstance(payload, dict):
                raise ValueError("payload must be an object")
            result = dispatch(command, payload)
            _write({"id": request_id, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001 - report every failure to the host
            _write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "helper_error", "message": str(exc)},
                }
            )
    return 0
