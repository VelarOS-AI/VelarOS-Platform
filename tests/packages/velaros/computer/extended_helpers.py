"""不操作用户桌面的 Computer Use 行为回归：注入输入/窗口后端并验证真实共享编排。"""
import importlib
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "packages/velaros/computer/runtime"))

from computer_desktop import ComputerDesktop
from computer_helper_common import ComputerHelperError, ScreenSnapshotRegistry
from computer_input import ComputerInput


DISPLAY = {"displayId": 1, "width": 200, "height": 100, "scaleFactor": 1, "originX": -200, "originY": 10}


class InputBackend:
    KEYBOARD_KEYS = ["ctrl", "shift", "a"]

    def __init__(self):
        self.calls = []
        self.fail_drag = False

    def moveTo(self, *args, **kwargs): self.calls.append(("move", args, kwargs))
    def mouseDown(self, **kwargs): self.calls.append(("down", kwargs))
    def mouseUp(self, **kwargs): self.calls.append(("up", kwargs))
    def keyDown(self, key): self.calls.append(("key-down", key))
    def keyUp(self, key): self.calls.append(("key-up", key))
    def scroll(self, value): self.calls.append(("scroll", value))
    def hscroll(self, value): self.calls.append(("hscroll", value))

    def dragTo(self, *args, **kwargs):
        self.calls.append(("drag", args, kwargs))
        if self.fail_drag:
            raise RuntimeError("input injection failed")


class DesktopBackend:
    capture_mode = "visible-region"
    supports_tree = True

    def __init__(self):
        self.bounds = {"x": -50, "y": 10, "width": 100, "height": 80}
        self.current_id = (1, 42)
        self.invoked = []
        self.values = []

    def windows(self): return ["window"]
    def identity(self, window): return self.current_id
    def describe(self, window): return {"title": "fixture", "processId": 42, "bounds": dict(self.bounds)}
    def children(self, element): return ["a", "b", "c"] if element == "window" else []
    def describe_element(self, element):
        if element == "b": raise RuntimeError("stale child")
        return {"role": "Button", "name": element, "automationId": element, "enabled": True, "bounds": dict(self.bounds)}
    def invoke(self, element): self.invoked.append(element)
    def set_value(self, element, value): self.values.append((element, value))


class Helpers(unittest.TestCase):
    def setUp(self):
        self.backend = InputBackend()
        self.registry = ScreenSnapshotRegistry()
        self.desktop = ComputerDesktop(self.registry, lambda: dict(DISPLAY), lambda: self.backend, str.lower)
        self.native = DesktopBackend()
        self.desktop.desktop = self.native
        self.window = self.desktop.windows({})[0]["id"]

    def tearDown(self):
        self.desktop.inputs.release_inputs()

    def point(self):
        snapshot = self.registry.capture(dict(DISPLAY), dict(DISPLAY))
        return {"x": 10, "y": 20, "snapshotId": snapshot, "coordinateSpace": "primary-display"}

    def test_scroll_and_horizontal_windows_event(self):
        win32api = types.SimpleNamespace(mouse_event=lambda *args: self.backend.calls.append(("horizontal", args)))
        win32con = types.SimpleNamespace(MOUSEEVENTF_HWHEEL=0x1000, WHEEL_DELTA=120)
        with patch.object(sys, "platform", "win32"), patch.dict(sys.modules, {"win32api": win32api, "win32con": win32con}):
            result = self.desktop.inputs.scroll({"at": self.point(), "deltaX": 2, "deltaY": 3})
        self.assertEqual(result, {"deltaX": 2, "deltaY": 3})
        self.assertEqual(self.backend.calls[0][1], (-190, 30))
        self.assertIn(("scroll", -3), self.backend.calls)
        self.assertIn(("horizontal", (0x1000, 0, 0, 240, 0)), self.backend.calls)

    def test_drag_validates_both_ends_before_moving_and_releases_on_error(self):
        point = self.point()
        invalid = {**point, "snapshotId": "screen_unknown"}
        with self.assertRaises(ComputerHelperError):
            self.desktop.inputs.drag({"from": point, "to": invalid})
        self.assertEqual(self.backend.calls, [])
        self.backend.fail_drag = True
        with self.assertRaisesRegex(RuntimeError, "injection"):
            self.desktop.inputs.drag({"from": point, "to": point, "durationMs": 100})
        self.assertEqual(self.backend.calls[-1], ("up", {"button": "left"}))

    def test_hold_leases_release_on_expiry_and_explicit_cleanup(self):
        with patch("computer_input.INPUT_LEASE_MS", 30):
            self.desktop.inputs.key_down({"key": "ctrl"})
            deadline = time.monotonic() + 1
            while self.desktop.inputs.held and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertIn(("key-up", "ctrl"), self.backend.calls)
        self.assertFalse(self.desktop.inputs.held)
        self.desktop.inputs.mouse_down({"at": self.point()})
        with self.assertRaises(ComputerHelperError):
            self.desktop.inputs.mouse_down({"at": self.point()})
        result = self.desktop.inputs.release_inputs()
        self.assertEqual(result["released"], ["mouse:left"])
        self.assertEqual(self.desktop.inputs.mouse_up({})["released"], [])

    def test_window_binding_rejects_moves_and_identity_reuse(self):
        display = self.desktop._window_display(self.window)
        token = self.registry.capture(display, dict(display))
        point = {"x": 10, "y": 20, "snapshotId": token, "coordinateSpace": "window"}
        self.assertEqual(self.desktop.resolve_point(point)[:2], (-40, 30))
        self.native.bounds["x"] += 1
        with self.assertRaises(ComputerHelperError): self.desktop.resolve_point(point)
        self.native.bounds["x"] -= 1
        with self.assertRaises(ComputerHelperError): self.desktop.resolve_point(point)
        self.native.current_id = (2, 42)
        with self.assertRaises(ComputerHelperError): self.desktop._window(self.window)

    def test_tree_is_bounded_reports_partial_failure_and_expires(self):
        tree = self.desktop.ui_tree({"windowId": self.window, "maxNodes": 3, "maxDepth": 4})
        self.assertLessEqual(len(tree["nodes"]), 3)
        self.assertTrue(tree["truncated"])
        self.assertIn("stale child", tree["warnings"])
        action = {"treeId": tree["treeId"], "elementId": "element_1"}
        self.desktop.invoke_element(action)
        self.assertEqual(self.native.invoked, ["a"])
        self.desktop.set_element_value({**action, "value": "中文 +{}😀"})
        self.assertEqual(self.native.values, [("a", "中文 +{}😀")])
        self.assertNotIn("value", tree["nodes"][1])
        changed = self.native.describe_element("a")
        changed["name"] = "different action"
        with patch.object(self.native, "describe_element", return_value=changed):
            with self.assertRaises(ComputerHelperError): self.desktop.invoke_element(action)
        created, window, elements = self.desktop.trees[tree["treeId"]]
        self.desktop.trees[tree["treeId"]] = (created - 31, window, elements)
        with self.assertRaises(ComputerHelperError): self.desktop.invoke_element(action)

    def test_unicode_uses_literal_key_actions(self):
        actions = []
        keyboard = types.ModuleType("pywinauto.keyboard")
        class Action:
            def __init__(self, value): self.value = value
            def run(self): actions.append(self.value)
        keyboard.KeyAction = keyboard.VirtualKeyAction = Action
        with patch.dict(sys.modules, {"pywinauto.keyboard": keyboard}):
            from computer_windows import type_unicode
            type_unicode("中文 +{}%😀\n\t")
        self.assertEqual(actions, list("中文 +{}%😀") + [13, 9])

    def test_recording_streams_real_codec_and_never_overwrites(self):
        try:
            import av
            from PIL import Image
        except ImportError:
            self.skipTest("run with bundled Python for real PyAV acceptance")
        from computer_recording import record
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "video.mp4"
            request = {"path": str(output), "durationMs": 250, "fps": 4}
            result = record(request, lambda: Image.new("RGB", (63, 47), "red"))
            self.assertEqual((result["width"], result["height"]), (64, 48))
            self.assertGreater(result["frames"], 0)
            with av.open(output) as container:
                frames = list(container.decode(video=0))
                self.assertEqual(len(frames), result["frames"])
            original = output.read_bytes()
            with self.assertRaises(ComputerHelperError): record(request, lambda: None)
            self.assertEqual(output.read_bytes(), original)
            output.unlink()
            with self.assertRaisesRegex(RuntimeError, "capture failed"):
                record(request, lambda: (_ for _ in ()).throw(RuntimeError("capture failed")))
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
