"""Windows 窗口与 UIA 适配：直接复用 pywinauto，不维护自制 COM 或输入协议。"""
from __future__ import annotations

from typing import Any

from computer_helper_common import ComputerHelperError


class WindowsDesktop:
    capture_mode = "visible-region"
    supports_tree = True

    def __init__(self):
        from pywinauto import Desktop
        self.desktop = Desktop(backend="uia")

    def windows(self) -> list:
        return self.desktop.windows(visible_only=True)

    def identity(self, window: Any) -> tuple:
        return int(window.handle), int(window.element_info.process_id), tuple(window.element_info.runtime_id)

    def describe(self, window: Any) -> dict:
        current = self.desktop.window(handle=window.handle).wrapper_object()
        if self.identity(current) != self.identity(window):
            raise ComputerHelperError("NOT_FOUND", "Window identity changed; enumerate windows again")
        if not current.is_visible() or current.is_minimized():
            raise ComputerHelperError("UNAVAILABLE", "Window is hidden or minimized")
        rectangle = current.rectangle()
        return {"title": current.window_text(), "processId": self.identity(current)[1],
                "bounds": {"x": rectangle.left, "y": rectangle.top,
                           "width": rectangle.width(), "height": rectangle.height()}}

    def focus(self, window: Any) -> None:
        window.set_focus()

    def children(self, element: Any) -> list:
        return element.children()

    def describe_element(self, element: Any) -> dict:
        info = element.element_info
        rect = info.rectangle
        return {"role": info.control_type, "name": info.name[:512],
                "automationId": str(info.automation_id)[:256], "enabled": element.is_enabled(),
                "bounds": {"x": rect.left, "y": rect.top,
                           "width": rect.width(), "height": rect.height()}}

    def invoke(self, element: Any) -> None:
        if not element.is_enabled():
            raise ComputerHelperError("UNAVAILABLE", "Control is disabled")
        element.iface_invoke.Invoke()

    def set_value(self, element: Any, value: str) -> None:
        if not element.is_enabled() or element.iface_value.CurrentIsReadOnly:
            raise ComputerHelperError("PERMISSION", "Control value is read-only or disabled")
        element.iface_value.SetValue(value)


def type_unicode(text: str) -> None:
    from pywinauto.keyboard import KeyAction, VirtualKeyAction
    # KeyAction 直接发送 Unicode，避免 send_keys 将 +、{}、%、换行解析为命令。
    for character in text:
        if character == "\n":
            VirtualKeyAction(0x0D).run()
        elif character == "\t":
            VirtualKeyAction(0x09).run()
        else:
            KeyAction(character).run()
