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
import secrets
import sys
from collections import OrderedDict
from typing import Any, Callable

Dispatch = Callable[[str, "dict[str, Any]"], Any]

SCREEN_STATE_FIELDS = (
    "displayId",
    "width",
    "height",
    "scaleFactor",
    "originX",
    "originY",
)


class ComputerHelperError(Exception):
    """An expected helper failure with a machine-readable wire error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def parse_click_coordinate_binding(
    payload: "dict[str, Any]",
) -> "tuple[str, Any]":
    """Validate the coordinate-space/snapshot discriminant shared by every helper."""
    # Only omission preserves the legacy global-coordinate behavior. Treating other
    # falsy values (None, False, 0, or "") as global would let a malformed request
    # bypass the screenshot binding and turn local screenshot coordinates into a
    # real global click.
    coordinate_space = payload.get("coordinateSpace", "global")
    if not isinstance(coordinate_space, str):
        raise ComputerHelperError(
            "screen_coordinate_space_invalid",
            "coordinateSpace must be primary-display or global",
        )
    if coordinate_space == "global":
        if "snapshotId" in payload:
            raise ComputerHelperError(
                "screen_snapshot_unexpected",
                "global coordinates must not carry snapshotId",
            )
        return coordinate_space, None
    if coordinate_space == "primary-display":
        return coordinate_space, payload.get("snapshotId")
    raise ComputerHelperError(
        "screen_coordinate_space_invalid",
        f"Unknown coordinateSpace: {coordinate_space}",
    )


class ScreenSnapshotRegistry:
    """Bounded screenshot-to-display-state bindings for coordinate actions."""

    def __init__(self, max_entries: int = 32) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be at least 1")
        self._max_entries = max_entries
        self._snapshots: "OrderedDict[str, dict[str, Any]]" = OrderedDict()

    def capture(
        self,
        display: "dict[str, Any]",
        current_display: "dict[str, Any]",
    ) -> str:
        state = self._screen_state(display)
        if state != self._screen_state(current_display):
            raise ComputerHelperError(
                "screen_snapshot_stale",
                "The primary display changed while the screenshot was captured; take another screenshot",
            )
        snapshot_id = f"screen_{secrets.token_urlsafe(18)}"
        self._snapshots[snapshot_id] = state
        while len(self._snapshots) > self._max_entries:
            self._snapshots.popitem(last=False)
        return snapshot_id

    def resolve_primary_point(
        self,
        snapshot_id: Any,
        x: int,
        y: int,
        current_display: "dict[str, Any]",
    ) -> "tuple[int, int, dict[str, Any]]":
        if not isinstance(snapshot_id, str) or not snapshot_id:
            raise ComputerHelperError(
                "screen_snapshot_required",
                "primary-display coordinates require snapshotId from computer:screenshot",
            )

        captured = self._snapshots.get(snapshot_id)
        if captured is None:
            raise ComputerHelperError(
                "screen_snapshot_stale",
                "The screenshot is unknown or expired; take a new computer:screenshot before clicking",
            )

        current = self._screen_state(current_display)
        if captured != current:
            # Once a binding is stale it can never become trustworthy again. Removing it also
            # avoids accepting an old screenshot if the user later restores the same layout.
            self._snapshots.pop(snapshot_id, None)
            raise ComputerHelperError(
                "screen_snapshot_stale",
                "The primary display or its layout changed; take a new computer:screenshot before clicking",
            )

        if x < 0 or y < 0 or x >= captured["width"] or y >= captured["height"]:
            raise ComputerHelperError(
                "screen_coordinate_out_of_bounds",
                f"Screenshot-local coordinate ({x}, {y}) is outside "
                f"0-{captured['width'] - 1} x 0-{captured['height'] - 1}",
            )

        # Mark a valid binding as recently used so active screenshots survive bounded eviction.
        self._snapshots.move_to_end(snapshot_id)
        return captured["originX"] + x, captured["originY"] + y, captured

    @staticmethod
    def _screen_state(display: "dict[str, Any]") -> "dict[str, Any]":
        try:
            return {field: display[field] for field in SCREEN_STATE_FIELDS}
        except KeyError as exc:
            raise ComputerHelperError(
                "screen_state_invalid",
                f"Display state is missing {exc.args[0]}",
            ) from exc


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
            code = exc.code if isinstance(exc, ComputerHelperError) else "helper_error"
            _write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": code, "message": str(exc)},
                }
            )
    return 0
