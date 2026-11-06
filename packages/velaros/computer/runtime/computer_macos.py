"""macOS 窗口与控件语义适配，使用系统 Quartz 和 PyObjC 的 Accessibility API。"""
from __future__ import annotations

from typing import Any

from computer_helper_common import ComputerHelperError


class MacDesktop:
    capture_mode = "window"
    supports_tree = True

    def __init__(self):
        import Quartz
        import ApplicationServices
        self.quartz = Quartz
        self.ax = ApplicationServices

    def windows(self) -> list:
        q = self.quartz
        options = q.kCGWindowListOptionOnScreenOnly | q.kCGWindowListExcludeDesktopElements
        return [item for item in q.CGWindowListCopyWindowInfo(options, q.kCGNullWindowID)
                if item.get(q.kCGWindowLayer) == 0 and item.get(q.kCGWindowOwnerPID)]

    def identity(self, window: dict) -> tuple:
        q = self.quartz
        return int(window[q.kCGWindowNumber]), int(window[q.kCGWindowOwnerPID])

    def _current(self, window: dict) -> dict:
        identity = self.identity(window)
        for current in self.windows():
            if self.identity(current) == identity:
                return current
        raise ComputerHelperError("NOT_FOUND", "Window closed; enumerate windows again")

    def describe(self, window: dict) -> dict:
        q = self.quartz
        current = self._current(window)
        bounds = current[q.kCGWindowBounds]
        return {"title": str(current.get(q.kCGWindowName, "")), "processId": self.identity(current)[1],
                "bounds": {"x": round(bounds["X"]), "y": round(bounds["Y"]),
                           "width": round(bounds["Width"]), "height": round(bounds["Height"])}}

    def _attribute(self, element: Any, name: str, default: Any = None) -> Any:
        error, value = self.ax.AXUIElementCopyAttributeValue(element, name, None)
        return value if error == 0 else default

    def root(self, window: dict) -> Any:
        info = self.describe(window)
        app = self.ax.AXUIElementCreateApplication(info["processId"])
        # AX 的窗口没有公开的 CGWindowID 映射；只接受标题与几何均唯一匹配的窗口。
        matches = []
        for candidate in self._attribute(app, "AXWindows", []):
            description = self.describe_element(candidate)
            if description["name"] == info["title"] and description["bounds"] == info["bounds"]:
                matches.append(candidate)
        if len(matches) != 1:
            raise ComputerHelperError("UNAVAILABLE", "Cannot uniquely bind CG window to an AX window")
        return matches[0]

    def focus(self, window: dict) -> None:
        self._perform(self.root(window), "AXRaise")
        from AppKit import NSRunningApplication, NSApplicationActivateIgnoringOtherApps
        application = NSRunningApplication.runningApplicationWithProcessIdentifier_(self.identity(window)[1])
        if application is None or not application.activateWithOptions_(NSApplicationActivateIgnoringOtherApps):
            raise ComputerHelperError("UNAVAILABLE", "macOS refused to focus the window")

    def children(self, element: Any) -> list:
        return self._attribute(element, "AXChildren", [])

    def describe_element(self, element: Any) -> dict:
        ax = self.ax
        point = self._attribute(element, "AXPosition")
        size = self._attribute(element, "AXSize")
        point_ok, position = ax.AXValueGetValue(point, ax.kAXValueCGPointType, None) if point else (False, None)
        size_ok, dimensions = ax.AXValueGetValue(size, ax.kAXValueCGSizeType, None) if size else (False, None)
        bounds = {"x": 0, "y": 0, "width": 0, "height": 0}
        if point_ok and size_ok:
            bounds = {"x": round(position[0]), "y": round(position[1]),
                      "width": round(dimensions[0]), "height": round(dimensions[1])}
        return {"role": str(self._attribute(element, "AXRole", "")),
                "name": str(self._attribute(element, "AXTitle", self._attribute(element, "AXDescription", "")))[:512],
                "automationId": str(self._attribute(element, "AXIdentifier", ""))[:256],
                "enabled": bool(self._attribute(element, "AXEnabled", False)), "bounds": bounds}

    def _perform(self, element: Any, action: str) -> None:
        error = self.ax.AXUIElementPerformAction(element, action)
        if error:
            raise ComputerHelperError("UNAVAILABLE", f"Accessibility action {action} failed: {error}")

    def invoke(self, element: Any) -> None:
        self._perform(element, "AXPress")

    def set_value(self, element: Any, value: str) -> None:
        error = self.ax.AXUIElementSetAttributeValue(element, "AXValue", value)
        if error:
            raise ComputerHelperError("UNAVAILABLE", f"Accessibility value update failed: {error}")
