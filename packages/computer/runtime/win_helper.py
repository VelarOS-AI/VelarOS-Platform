#!/usr/bin/env python3
"""Windows desktop-control helper for VelarOS Computer Use (Phase 1).

Same JSON stdio protocol and command surface as `mac_helper.py`, using
cross-platform pyautogui/mss plus screeninfo for display geometry. Windows needs
no special TCC-style permission, so `check` reports both permission flags true.

Depends on: mss, Pillow, pyautogui, screeninfo.
"""
from __future__ import annotations

import base64
import os
import sys
import zlib
from io import BytesIO
from typing import Any

import mss
from PIL import Image

from computer_helper_common import (
    ScreenSnapshotRegistry,
    parse_click_coordinate_binding,
    run_stdio_loop,
)

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

# The host decodes stdout as UTF-8; redirected Windows stdout defaults to the
# active ANSI code page, which would mangle non-ASCII output. Force UTF-8.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import pyautogui  # noqa: E402

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

SCREEN_SNAPSHOTS = ScreenSnapshotRegistry()

KEY_ALIASES = {
    "cmd": "win",
    "command": "win",
    "meta": "win",
    "super": "win",
    "win": "win",
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "option": "alt",
    "opt": "alt",
    "esc": "esc",
    "escape": "esc",
    "enter": "enter",
    "return": "enter",
    "del": "delete",
    "forwarddelete": "delete",
}


def normalize_key(name: str) -> str:
    key = name.strip().lower()
    if not key:
        raise ValueError("Empty key name")
    return KEY_ALIASES.get(key, key)


def primary_monitor() -> "dict[str, Any]":
    try:
        from screeninfo import get_monitors

        monitors = get_monitors()
        for index, monitor in enumerate(monitors):
            if getattr(monitor, "is_primary", False):
                return {
                    "displayId": stable_monitor_id(monitor, index),
                    "width": int(monitor.width),
                    "height": int(monitor.height),
                    "scaleFactor": 1.0,
                    "originX": int(monitor.x),
                    "originY": int(monitor.y),
                }
        # Some screeninfo enumerators omit is_primary. Windows anchors the
        # primary monitor at (0, 0); list order alone is not a reliable signal.
        for index, monitor in enumerate(monitors):
            if int(monitor.x) == 0 and int(monitor.y) == 0:
                return {
                    "displayId": stable_monitor_id(monitor, index),
                    "width": int(monitor.width),
                    "height": int(monitor.height),
                    "scaleFactor": 1.0,
                    "originX": 0,
                    "originY": 0,
                }
        if monitors:
            monitor = monitors[0]
            return {
                "displayId": stable_monitor_id(monitor, 0),
                "width": int(monitor.width),
                "height": int(monitor.height),
                "scaleFactor": 1.0,
                "originX": int(monitor.x),
                "originY": int(monitor.y),
            }
    except Exception:  # noqa: BLE001 - fall back to mss virtual monitor
        pass

    with mss.mss() as sct:
        monitors = sct.monitors[1:]
        if not monitors:
            raise RuntimeError("No Windows display monitor is available.")
        # EnumDisplayMonitors order is not a primary-display contract. Windows
        # always anchors the primary display at global (0, 0), so prefer that
        # geometry before falling back to the first enumerated monitor.
        monitor = next(
            (
                candidate
                for candidate in monitors
                if int(candidate["left"]) == 0 and int(candidate["top"]) == 0
            ),
            monitors[0],
        )
    # mss exposes geometry but no stable device identity. In this fallback only geometry changes
    # can invalidate a binding; equal-geometry primary swaps require screeninfo above.
    return {
        "displayId": 0,
        "width": int(monitor["width"]),
        "height": int(monitor["height"]),
        "scaleFactor": 1.0,
        "originX": int(monitor["left"]),
        "originY": int(monitor["top"]),
    }


def stable_monitor_id(monitor: Any, index: int) -> int:
    """Combine the OS device name and stable screeninfo order for this process."""
    name = str(getattr(monitor, "name", "") or "").strip()
    identity = f"{name or 'unnamed'}\0{index}"
    return zlib.crc32(identity.encode("utf-8"))


def screen_size(_payload: "dict[str, Any]") -> "dict[str, Any]":
    return primary_monitor()


def screenshot(payload: "dict[str, Any]") -> "dict[str, Any]":
    display = primary_monitor()
    region = {
        "left": display["originX"],
        "top": display["originY"],
        "width": display["width"],
        "height": display["height"],
    }
    with mss.mss() as sct:
        raw = sct.grab(region)
        image = Image.frombytes("RGB", raw.size, raw.rgb)

    # 统一到逻辑坐标空间：mss 在缩放屏上抓的是物理像素，这里缩放到逻辑宽高，
    # 使「图片像素 = 逻辑点 = pyautogui 点击坐标」三者 1:1，避免模型按物理像素挑坐标导致点击错位。
    if image.width != display["width"] or image.height != display["height"]:
        image = image.resize((display["width"], display["height"]), Image.Resampling.LANCZOS)

    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=int(payload.get("quality") or 75), optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    snapshot_id = SCREEN_SNAPSHOTS.capture(display, primary_monitor())
    return {
        "base64": encoded,
        "format": "jpeg",
        "snapshotId": snapshot_id,
        "width": image.width,
        "height": image.height,
        "displayWidth": display["width"],
        "displayHeight": display["height"],
        "displayId": display["displayId"],
        "originX": display["originX"],
        "originY": display["originY"],
        "scaleFactor": display["scaleFactor"],
    }


def mouse_move(payload: "dict[str, Any]") -> "dict[str, Any]":
    x = int(payload["x"])
    y = int(payload["y"])
    duration = max(0.0, min(float(payload.get("durationMs") or 0) / 1000.0, 0.8))
    pyautogui.moveTo(x, y, duration=duration)
    return {"x": x, "y": y}


def left_click(payload: "dict[str, Any]") -> "dict[str, Any]":
    x = int(payload["x"])
    y = int(payload["y"])
    coordinate_space, snapshot_id = parse_click_coordinate_binding(payload)
    button = str(payload.get("button") or "left")
    count = int(payload.get("count") or 1)
    display = None
    if coordinate_space == "primary-display":
        x, y, display = SCREEN_SNAPSHOTS.resolve_primary_point(
            snapshot_id, x, y, primary_monitor()
        )
    # Keep the display lookup and validation directly adjacent to the input call.
    pyautogui.click(x=x, y=y, button=button, clicks=count, interval=0.08)
    result = {
        "x": x,
        "y": y,
        "button": button,
        "count": count,
        "coordinateSpace": coordinate_space,
    }
    if display is not None:
        result["displayId"] = display["displayId"]
        result["snapshotId"] = snapshot_id
    return result


def type_text(payload: "dict[str, Any]") -> "dict[str, Any]":
    text = str(payload.get("text") or "")
    pyautogui.write(text, interval=0.008)
    return {"typed": len(text)}


def key_combo(payload: "dict[str, Any]") -> "dict[str, Any]":
    sequence = str(payload.get("keys") or payload.get("keySequence") or "")
    parts = [normalize_key(part) for part in sequence.split("+") if part.strip()]
    if not parts:
        raise ValueError("No keys provided")
    if len(parts) == 1:
        pyautogui.press(parts[0])
    else:
        pyautogui.hotkey(*parts, interval=0.02)
    return {"pressed": parts}


def check(_payload: "dict[str, Any]") -> "dict[str, Any]":
    # Windows does not gate input/capture behind a TCC-style permission system.
    return {"platform": "win32", "accessibility": True, "screenRecording": True}


COMMANDS = {
    "check": check,
    "screen_size": screen_size,
    "screenshot": screenshot,
    "mouse_move": mouse_move,
    "left_click": left_click,
    "type": type_text,
    "key": key_combo,
}


def dispatch(command: str, payload: "dict[str, Any]") -> Any:
    handler = COMMANDS.get(command)
    if handler is None:
        raise ValueError(f"Unknown command: {command}")
    return handler(payload)


if __name__ == "__main__":
    raise SystemExit(run_stdio_loop(dispatch))
