#!/usr/bin/env python3
"""macOS desktop-control helper for VelarOS Computer Use (Phase 1).

Implements the Phase 1 command surface only:
    check        -> {accessibility, screenRecording, platform}
    screen_size  -> {width, height, scaleFactor, displayId, originX, originY}
    screenshot   -> {base64, format, width, height, displayWidth, displayHeight, ...}
    mouse_move   -> {x, y}
    left_click   -> {x, y, button, count}  (button/count configurable)
    type         -> {typed}
    key          -> {pressed}

Adapted from the cc-haha reference helper but trimmed to the Phase 1 surface and
wired to the shared stdio JSON-RPC loop. Deferred (Phase 2): drag, scroll,
double/triple click, clipboard, window/app management, multi-display selection.

Depends on: mss, Pillow, pyautogui, pyobjc (Cocoa + Quartz).
"""
from __future__ import annotations

import base64
import ctypes
import os
from io import BytesIO
from typing import Any

import mss
from PIL import Image
from Quartz import (
    CGDisplayBounds,
    CGDisplayPixelsHigh,
    CGDisplayPixelsWide,
    CGMainDisplayID,
    CGPreflightScreenCaptureAccess,
)

from computer_helper_common import run_stdio_loop

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

import pyautogui  # noqa: E402

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

# macOS pyautogui key vocabulary. Modifier aliases normalize cross-platform names
# coming from the model (cmd/meta/super -> command, alt/opt -> option, etc.).
KEY_ALIASES = {
    "cmd": "command",
    "command": "command",
    "meta": "command",
    "super": "command",
    "win": "command",
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "option",
    "option": "option",
    "opt": "option",
    "fn": "fn",
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


def main_display() -> "dict[str, Any]":
    display_id = CGMainDisplayID()
    bounds = CGDisplayBounds(display_id)
    logical_width = int(bounds.size.width)
    logical_height = int(bounds.size.height)
    physical_width = int(CGDisplayPixelsWide(display_id))
    physical_height = int(CGDisplayPixelsHigh(display_id))
    scale = physical_width / logical_width if logical_width else 1.0
    return {
        "displayId": int(display_id),
        "width": logical_width,
        "height": logical_height,
        "scaleFactor": scale,
        "originX": int(bounds.origin.x),
        "originY": int(bounds.origin.y),
    }


def screen_size(_payload: "dict[str, Any]") -> "dict[str, Any]":
    return main_display()


def screenshot(payload: "dict[str, Any]") -> "dict[str, Any]":
    display = main_display()
    monitor = {
        "left": display["originX"],
        "top": display["originY"],
        "width": display["width"],
        "height": display["height"],
    }
    with mss.mss() as sct:
        raw = sct.grab(monitor)
        image = Image.frombytes("RGB", raw.size, raw.rgb)

    # 统一到逻辑坐标空间：mss 在 Retina/缩放屏上抓的是物理像素，这里缩放到逻辑宽高，
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
    pyautogui.moveTo(x, y)
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


def detect_accessibility() -> bool:
    framework = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    try:
        services = ctypes.CDLL(framework)
        services.AXIsProcessTrusted.restype = ctypes.c_bool
        services.AXIsProcessTrusted.argtypes = []
        return bool(services.AXIsProcessTrusted())
    except Exception:  # noqa: BLE001 - fail closed on probe error
        return False


def detect_screen_recording() -> "bool | None":
    try:
        return bool(CGPreflightScreenCaptureAccess())
    except Exception:  # noqa: BLE001
        return None


def check(_payload: "dict[str, Any]") -> "dict[str, Any]":
    return {
        "platform": "darwin",
        "accessibility": detect_accessibility(),
        "screenRecording": detect_screen_recording(),
    }


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
