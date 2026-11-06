"""扩展桌面操作的共享编排：窗口身份、截图绑定、有界控件树与录像。"""
from __future__ import annotations

import base64
import importlib
import secrets
import sys
import time
from collections import OrderedDict, deque
from io import BytesIO
from typing import Any, Callable

from computer_helper_common import ComputerHelperError, parse_pointer_coordinate_binding
from computer_input import ComputerInput


class ComputerDesktop:
    def __init__(self, snapshots: Any, display: Callable, backend: Callable, normalize_key: Callable,
                 capture_main: Callable | None = None):
        self.snapshots = snapshots
        self.display = display
        self.capture_main = capture_main
        self.desktop = None
        self.window_cache: OrderedDict[str, tuple] = OrderedDict()
        self.trees: OrderedDict[str, tuple] = OrderedDict()
        self.inputs = ComputerInput(backend, self.resolve_point, normalize_key)

    def _desktop(self):
        if self.desktop is None:
            if sys.platform == "win32":
                from computer_windows import WindowsDesktop
                self.desktop = WindowsDesktop()
            elif sys.platform == "darwin":
                from computer_macos import MacDesktop
                self.desktop = MacDesktop()
            else:
                from computer_x11 import X11Desktop
                self.desktop = X11Desktop()
        return self.desktop

    def capabilities(self, _payload: dict) -> dict:
        limitations = []
        supports_windows = False
        supports_tree = False
        mode = "visible-region"
        try:
            desktop = self._desktop()
            supports_windows = True
            supports_tree = desktop.supports_tree
            mode = desktop.capture_mode
        except Exception as error:
            limitations.append(str(error))
        if not supports_tree:
            limitations.append("No bundled accessibility tree backend for this session")
        if mode == "visible-region":
            limitations.append("Window captures include visible screen pixels; occluded areas may contain other windows")
        try:
            av = importlib.import_module("av")
            av.Codec("mpeg4", "w")
            supports_recording = True
        except Exception as error:
            supports_recording = False
            limitations.append(f"Recording backend unavailable: {error}")
        return {"platform": sys.platform, "windows": supports_windows, "uiTree": supports_tree,
                "recording": supports_recording, "captureMode": mode,
                "limitations": limitations}

    def windows(self, _payload: dict) -> list:
        desktop = self._desktop()
        result = []
        for window in desktop.windows()[:200]:
            try:
                info = desktop.describe(window)
                if info["bounds"]["width"] <= 0 or info["bounds"]["height"] <= 0:
                    continue
                identity = desktop.identity(window)
                token = next((key for key, value in self.window_cache.items() if value[0] == identity), None)
                token = token or "window_" + secrets.token_urlsafe(18)
                self.window_cache[token] = (identity, window)
                self.window_cache.move_to_end(token)
                result.append({"id": token, **info})
            except Exception as error:
                print(f"Skipping inaccessible window: {error}", file=sys.stderr)
        while len(self.window_cache) > 200:
            self.window_cache.popitem(last=False)
        return result

    def _window(self, token: str) -> tuple:
        cached = self.window_cache.get(token)
        if cached is None:
            raise ComputerHelperError("NOT_FOUND", "Unknown window id; call windows again")
        identity, window = cached
        desktop = self._desktop()
        info = desktop.describe(window)
        if desktop.identity(window) != identity or info["processId"] != identity[1]:
            self.window_cache.pop(token, None)
            raise ComputerHelperError("NOT_FOUND", "Window identity changed; call windows again")
        return window, info

    def _window_display(self, token: str) -> dict:
        _, info = self._window(token)
        bounds = info["bounds"]
        return {"windowId": token, "processId": info["processId"], "displayId": 0,
                "width": bounds["width"], "height": bounds["height"],
                "originX": bounds["x"], "originY": bounds["y"], "scaleFactor": 1}

    def resolve_point(self, payload: dict) -> tuple:
        space, snapshot = parse_pointer_coordinate_binding(payload)
        x, y = payload["x"], payload["y"]
        if space == "global":
            return x, y, None
        if space == "window":
            captured = self.snapshots.binding(snapshot)
            token = captured.get("windowId")
            if not token:
                raise ComputerHelperError("screen_coordinate_space_invalid", "A window point requires a window screenshot")
            current = self._window_display(token)
        else:
            current = self.display()
        return self.snapshots.resolve_primary_point(snapshot, x, y, current)

    def _grab(self, display: dict):
        import mss
        from PIL import Image
        region = {"left": display["originX"], "top": display["originY"],
                  "width": display["width"], "height": display["height"]}
        with mss.mss() as capture:
            raw = capture.grab(region)
            return Image.frombytes("RGB", raw.size, raw.rgb)

    def _capture_window(self, token: str):
        from PIL import Image
        display = self._window_display(token)
        if self._desktop().capture_mode == "window":
            import os
            import subprocess
            import tempfile
            window, _ = self._window(token)
            with tempfile.TemporaryDirectory(prefix="velaros-window-") as directory:
                path = os.path.join(directory, "capture.png")
                subprocess.run(["/usr/sbin/screencapture", "-x", "-o", "-l",
                                str(self._desktop().identity(window)[0]), "-t", "png", path],
                               check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                with Image.open(path) as image:
                    result = image.convert("RGB")
        else:
            result = self._grab(display)
        if display != self._window_display(token):
            raise ComputerHelperError("screen_snapshot_stale", "Window changed while capturing")
        return result.resize((display["width"], display["height"]), Image.Resampling.LANCZOS)

    def screenshot_window(self, payload: dict) -> dict:
        token = payload["windowId"]
        display = self._window_display(token)
        image = self._capture_window(token)
        snapshot = self.snapshots.capture(display, self._window_display(token))
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=75, optimize=True)
        return {**display, "displayWidth": display["width"], "displayHeight": display["height"],
                "snapshotId": snapshot, "base64": base64.b64encode(buffer.getvalue()).decode("ascii"), "format": "jpeg"}

    def focus_window(self, payload: dict) -> dict:
        window, _ = self._window(payload["windowId"])
        self._desktop().focus(window)
        _, info = self._window(payload["windowId"])
        return {"id": payload["windowId"], **info}

    def ui_tree(self, payload: dict) -> dict:
        window, _ = self._window(payload["windowId"])
        desktop = self._desktop()
        root = desktop.root(window) if hasattr(desktop, "root") else window
        queue = deque([(root, None, 0)])
        nodes, warnings, elements = [], [], {}
        max_nodes, max_depth = payload.get("maxNodes", 200), payload.get("maxDepth", 6)
        if not 1 <= max_nodes <= 500 or not 1 <= max_depth <= 12:
            raise ComputerHelperError("VALIDATION", "UI tree query exceeds limits")
        deadline = time.monotonic() + 3
        truncated = False
        while queue and len(nodes) < max_nodes and time.monotonic() < deadline:
            element, parent, depth = queue.popleft()
            try:
                node = desktop.describe_element(element)
                identity = f"element_{len(nodes)}"
                node["id"] = identity
                if parent is not None:
                    node["parentId"] = parent
                nodes.append(node)
                elements[identity] = (element, (node["role"], node["name"], node["automationId"]))
                children = desktop.children(element)
                if depth + 1 >= max_depth:
                    truncated = truncated or bool(children)
                else:
                    remaining = max_nodes - len(nodes) - len(queue)
                    truncated = truncated or len(children) > remaining
                    queue.extend((child, identity, depth + 1) for child in children[:max(0, remaining)])
            except Exception as error:
                warnings.append(str(error)[:256])
        truncated = truncated or bool(queue)
        self._window(payload["windowId"])
        tree_id = "tree_" + secrets.token_urlsafe(18)
        self.trees[tree_id] = (time.monotonic(), payload["windowId"], elements)
        while len(self.trees) > 8:
            self.trees.popitem(last=False)
        return {"treeId": tree_id, "windowId": payload["windowId"], "nodes": nodes,
                "truncated": truncated, "warnings": warnings[:20]}

    def _element(self, payload: dict):
        tree = self.trees.get(payload["treeId"])
        if tree is None or time.monotonic() - tree[0] > 30:
            self.trees.pop(payload["treeId"], None)
            raise ComputerHelperError("CONFLICT", "Control tree expired; query uiTree again")
        self._window(tree[1])
        cached = tree[2].get(payload["elementId"])
        if cached is None:
            raise ComputerHelperError("NOT_FOUND", "Unknown control in this tree")
        element, fingerprint = cached
        current = self._desktop().describe_element(element)
        if (current["role"], current["name"], current["automationId"]) != fingerprint:
            raise ComputerHelperError("CONFLICT", "Control identity or label changed; query uiTree again")
        if not current["enabled"]:
            raise ComputerHelperError("UNAVAILABLE", "Control is disabled")
        return element

    def invoke_element(self, payload: dict) -> dict:
        self._desktop().invoke(self._element(payload))
        return {**payload, "action": "invoke"}

    def set_element_value(self, payload: dict) -> dict:
        self._desktop().set_value(self._element(payload), payload["value"])
        return {"treeId": payload["treeId"], "elementId": payload["elementId"], "action": "set-value"}

    def record(self, payload: dict) -> dict:
        from computer_recording import record
        token = payload.get("windowId")
        display = self._window_display(token) if token else self.display()

        def capture():
            if token:
                current = self._window_display(token)
                image = self._capture_window(token)
            else:
                current = self.display()
                image = self.capture_main() if self.capture_main else self._grab(current)
            if display != current:
                raise ComputerHelperError("CONFLICT", "Display/window changed during recording")
            from PIL import Image
            return image.resize((display["width"], display["height"]), Image.Resampling.LANCZOS)

        return record(payload, capture)

    def commands(self) -> dict:
        return {"capabilities": self.capabilities, "windows": self.windows,
                "screenshot_window": self.screenshot_window, "focus_window": self.focus_window,
                "ui_tree": self.ui_tree, "invoke_element": self.invoke_element,
                "set_element_value": self.set_element_value, "record": self.record,
                "scroll": self.inputs.scroll, "drag": self.inputs.drag,
                "mouse_down": self.inputs.mouse_down, "mouse_up": self.inputs.mouse_up,
                "key_down": self.inputs.key_down, "key_up": self.inputs.key_up,
                "release_inputs": self.inputs.release_inputs}
