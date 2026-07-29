#!/usr/bin/env python3
"""Linux desktop-control helper for VelarOS Computer Use (Phase 1).

Implements the same JSON stdio protocol and command surface as the macOS and
Windows helpers. Linux desktop control depends on a graphical session; headless
hosts or locked-down Wayland sessions report unavailable through `check` rather
than making the platform unsupported.

Depends on: mss, Pillow, pyautogui, screeninfo.
"""
from __future__ import annotations

import base64
import os
from io import BytesIO
from typing import Any

import mss
from PIL import Image

from computer_helper_common import run_stdio_loop

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

_PYAUTOGUI: Any | None = None

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


def has_display_session() -> bool:
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def require_display_session() -> None:
    if not has_display_session():
        raise RuntimeError("Linux desktop control requires DISPLAY or WAYLAND_DISPLAY.")


def load_pyautogui() -> Any:
    global _PYAUTOGUI
    require_display_session()
    if _PYAUTOGUI is None:
        import pyautogui  # noqa: PLC0415

        pyautogui.FAILSAFE = False
        pyautogui.PAUSE = 0
        _PYAUTOGUI = pyautogui
    return _PYAUTOGUI


def normalize_key(name: str) -> str:
    key = name.strip().lower()
    if not key:
        raise ValueError("Empty key name")
    return KEY_ALIASES.get(key, key)


def primary_monitor() -> "dict[str, Any]":
    require_display_session()
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
        if len(sct.monitors) <= 1:
            raise RuntimeError("No Linux display monitor is available.")
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
    pyautogui = load_pyautogui()
    x = int(payload["x"])
    y = int(payload["y"])
    pyautogui.moveTo(x, y)
    return {"x": x, "y": y}


def left_click(payload: "dict[str, Any]") -> "dict[str, Any]":
    pyautogui = load_pyautogui()
    x = int(payload["x"])
    y = int(payload["y"])
    button = str(payload.get("button") or "left")
    count = int(payload.get("count") or 1)
    pyautogui.click(x=x, y=y, button=button, clicks=count, interval=0.08)
    return {"x": x, "y": y, "button": button, "count": count}


def type_text(payload: "dict[str, Any]") -> "dict[str, Any]":
    pyautogui = load_pyautogui()
    text = str(payload.get("text") or "")
    pyautogui.write(text, interval=0.008)
    return {"typed": len(text)}


def key_combo(payload: "dict[str, Any]") -> "dict[str, Any]":
    pyautogui = load_pyautogui()
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
    available = False
    if has_display_session():
        try:
            with mss.mss() as sct:
                available = len(sct.monitors) > 1
        except Exception:  # noqa: BLE001 - fail closed when capture is blocked
            available = False

    return {"platform": "linux", "accessibility": available, "screenRecording": available}


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
