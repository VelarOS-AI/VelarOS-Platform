#!/usr/bin/env python3
"""macOS desktop-control helper for the VelarOS Computer runtime.

Clean-room provenance: this implementation was written from the VelarOS
JSON-lines protocol, the shared helper module, sibling Linux/Windows helpers,
the TypeScript runtime contracts and tests, and public macOS SDK/manual pages.
The already-declared PyAutoGUI/PyObjC dependencies were additionally checked for
their macOS call conventions. The replaced helper, its history, cc-haha, and
related external source were not accessed.

Screen capture uses the macOS ``screencapture`` command. Display identity,
geometry, permission checks, and Unicode keyboard events use public Quartz
APIs. Mouse movement, clicks, and named key chords use the package's declared
PyAutoGUI dependency.
"""
from __future__ import annotations

import base64
import math
import os
import subprocess
import tempfile
import time
from io import BytesIO
from typing import Any, Iterator, Optional, Tuple

import Quartz
from PIL import Image

from computer_helper_common import (
    ScreenSnapshotRegistry,
    parse_click_coordinate_binding,
    run_stdio_loop,
)

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

SCREEN_CAPTURE_COMMAND = "/usr/sbin/screencapture"
SCREEN_CAPTURE_TIMEOUT_SECONDS = 15
UNICODE_EVENT_CHUNK_UNITS = 256

SCREEN_SNAPSHOTS = ScreenSnapshotRegistry()
_PYAUTOGUI: Optional[Any] = None

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
    "esc": "esc",
    "escape": "esc",
    "enter": "enter",
    "return": "enter",
    "del": "delete",
    "forwarddelete": "delete",
}


def load_pyautogui() -> Any:
    """Import the input backend only when an input command is dispatched."""
    global _PYAUTOGUI
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


def _finite_number(value: Any, label: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise RuntimeError(f"macOS reported a non-finite {label}.")
    return number


def _rounded_coordinate(value: Any, label: str) -> int:
    return int(round(_finite_number(value, label)))


def _backing_pixel_dimensions(display_id: int) -> "Tuple[int, int]":
    """Read backing pixels, preferring the current display-mode metadata."""
    copy_mode = getattr(Quartz, "CGDisplayCopyDisplayMode", None)
    mode_pixel_width = getattr(Quartz, "CGDisplayModeGetPixelWidth", None)
    mode_pixel_height = getattr(Quartz, "CGDisplayModeGetPixelHeight", None)
    if callable(copy_mode) and callable(mode_pixel_width) and callable(mode_pixel_height):
        try:
            mode = copy_mode(display_id)
            if mode is not None:
                width = int(mode_pixel_width(mode))
                height = int(mode_pixel_height(mode))
                if width > 0 and height > 0:
                    return width, height
        except Exception:  # noqa: BLE001 - fall back to display-service dimensions
            pass
    return (
        int(Quartz.CGDisplayPixelsWide(display_id)),
        int(Quartz.CGDisplayPixelsHigh(display_id)),
    )


def primary_display() -> "dict[str, Any]":
    """Return the current main display in global logical coordinates."""
    display_id = int(Quartz.CGMainDisplayID())
    bounds = Quartz.CGDisplayBounds(display_id)
    width = _rounded_coordinate(bounds.size.width, "display width")
    height = _rounded_coordinate(bounds.size.height, "display height")
    if width <= 0 or height <= 0:
        raise RuntimeError("No drawable macOS main display is available.")

    pixel_width, pixel_height = _backing_pixel_dimensions(display_id)
    if pixel_width <= 0 or pixel_height <= 0:
        raise RuntimeError("macOS main display pixel dimensions are unavailable.")

    # The two ratios are normally identical. max() also handles a rounded mode
    # dimension without understating the backing scale used for snapshot binding.
    scale_factor = round(max(pixel_width / width, pixel_height / height), 6)
    return {
        "displayId": display_id,
        "width": width,
        "height": height,
        "scaleFactor": scale_factor,
        "originX": _rounded_coordinate(bounds.origin.x, "display x origin"),
        "originY": _rounded_coordinate(bounds.origin.y, "display y origin"),
    }


def _accessibility_access() -> bool:
    probe = getattr(Quartz, "AXIsProcessTrusted", None)
    if callable(probe):
        try:
            return bool(probe())
        except Exception:  # noqa: BLE001 - a permission probe must fail closed
            return False

    probe_with_options = getattr(Quartz, "AXIsProcessTrustedWithOptions", None)
    prompt_key = getattr(Quartz, "kAXTrustedCheckOptionPrompt", None)
    if callable(probe_with_options) and prompt_key is not None:
        try:
            return bool(probe_with_options({prompt_key: False}))
        except Exception:  # noqa: BLE001 - a permission probe must fail closed
            return False
    return False


def _screen_recording_access() -> "Optional[bool]":
    probe = getattr(Quartz, "CGPreflightScreenCaptureAccess", None)
    if not callable(probe):
        # The API was added in macOS 10.15. A missing probe on an older system is
        # represented as unknown; the actual capture command remains authoritative.
        return None
    try:
        return bool(probe())
    except Exception:  # noqa: BLE001 - a permission probe must fail closed
        return False


def _capture_main_display_image() -> Any:
    """Capture the main display without UI and return a detached Pillow image."""
    access = _screen_recording_access()
    if access is False:
        raise RuntimeError("macOS Screen Recording permission is required.")

    with tempfile.TemporaryDirectory(prefix="velaros-computer-capture-") as temp_dir:
        output_path = os.path.join(temp_dir, "main-display.png")
        completed = subprocess.run(
            [SCREEN_CAPTURE_COMMAND, "-x", "-m", "-t", "png", output_path],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=SCREEN_CAPTURE_TIMEOUT_SECONDS,
        )
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail or "macOS screen capture failed.")
        if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
            raise RuntimeError("macOS screen capture produced no image.")

        with Image.open(output_path) as captured:
            captured.load()
            return captured.convert("RGB")


def screen_size(_payload: "dict[str, Any]") -> "dict[str, Any]":
    return primary_display()


def screenshot(payload: "dict[str, Any]") -> "dict[str, Any]":
    display = primary_display()
    image = _capture_main_display_image()

    # screencapture emits backing pixels on scaled displays. Normalize to the
    # logical display bounds so image pixels and subsequent click coordinates
    # have a stable 1:1 relationship.
    logical_size = (display["width"], display["height"])
    if image.size != logical_size:
        image = image.resize(logical_size, Image.Resampling.LANCZOS)

    quality = max(1, min(int(payload.get("quality") or 75), 95))
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    snapshot_id = SCREEN_SNAPSHOTS.capture(display, primary_display())
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
    load_pyautogui().moveTo(x, y, duration=duration)
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
            snapshot_id, x, y, primary_display()
        )

    # Keep snapshot validation and the actual event adjacent so the display
    # state cannot be silently recomputed through a second coordinate path.
    load_pyautogui().click(x=x, y=y, button=button, clicks=count, interval=0.08)
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


def _utf16_units(text: str) -> "Tuple[str, ...]":
    encoded = text.encode("utf-16-le")
    return tuple(
        chr(int.from_bytes(encoded[index:index + 2], "little"))
        for index in range(0, len(encoded), 2)
    )


def _unicode_event_chunks(text: str) -> "Iterator[Tuple[str, ...]]":
    pending = []
    for character in text:
        character_units = _utf16_units(character)
        if pending and len(pending) + len(character_units) > UNICODE_EVENT_CHUNK_UNITS:
            yield tuple(pending)
            pending = []
        pending.extend(character_units)
    if pending:
        yield tuple(pending)


def _post_unicode_text(text: str) -> None:
    """Post literal UTF-16 text without changing the user's pasteboard."""
    for units in _unicode_event_chunks(text):
        key_down = Quartz.CGEventCreateKeyboardEvent(None, 0, True)
        key_up = Quartz.CGEventCreateKeyboardEvent(None, 0, False)
        if key_down is None or key_up is None:
            raise RuntimeError("macOS could not create a keyboard event.")
        Quartz.CGEventKeyboardSetUnicodeString(key_down, len(units), units)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, key_down)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, key_up)
        # Preserve ordering when a long payload is split across events without
        # making ordinary text input visibly slow.
        time.sleep(0.001)


def type_text(payload: "dict[str, Any]") -> "dict[str, Any]":
    text = str(payload.get("text") or "")
    if text:
        _post_unicode_text(text)
    return {"typed": len(text)}


def key_combo(payload: "dict[str, Any]") -> "dict[str, Any]":
    sequence = str(payload.get("keys") or payload.get("keySequence") or "")
    parts = [normalize_key(part) for part in sequence.split("+") if part.strip()]
    if not parts:
        raise ValueError("No keys provided")

    pyautogui = load_pyautogui()
    if len(parts) == 1:
        pyautogui.press(parts[0])
    else:
        pyautogui.hotkey(*parts, interval=0.02)
    return {"pressed": parts}


def check(_payload: "dict[str, Any]") -> "dict[str, Any]":
    return {
        "platform": "darwin",
        "accessibility": _accessibility_access(),
        "screenRecording": _screen_recording_access(),
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
