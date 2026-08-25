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
from io import BytesIO
from typing import Any

import mss
from PIL import Image

from computer_helper_common import run_stdio_loop

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

        for monitor in get_monitors():
            if getattr(monitor, "is_primary", False):
                return {
                    "displayId": 0,
                    "width": int(monitor.width),
                    "height": int(monitor.height),
                    "scaleFactor": 1.0,
                    "originX": int(monitor.x),
                    "originY": int(monitor.y),
                }
        monitors = get_monitors()
        if monitors:
            monitor = monitors[0]
            return {
                "displayId": 0,
                "width": int(monitor.width),
                "height": int(monitor.height),
                "scaleFactor": 1.0,
                "originX": int(monitor.x),
                "originY": int(monitor.y),
            }
    except Exception:  # noqa: BLE001 - fall back to mss virtual monitor
        pass

    with mss.mss() as sct:
        monitor = sct.monitors[1]
    return {
        "displayId": 0,
        "width": int(monitor["width"]),
        "height": int(monitor["height"]),
        "scaleFactor": 1.0,
        "originX": int(monitor["left"]),
        "originY": int(monitor["top"]),
    }


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
    return {
        "base64": encoded,
        "format": "jpeg",
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
    button = str(payload.get("button") or "left")
    count = int(payload.get("count") or 1)
    pyautogui.click(x=x, y=y, button=button, clicks=count, interval=0.08)
    return {"x": x, "y": y, "button": button, "count": count}


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
