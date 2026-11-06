"""X11 窗口查询复用 python-xlib；Wayland 不伪装为可全局控制的 X11 会话。"""
from __future__ import annotations

import os

from computer_helper_common import ComputerHelperError


class X11Desktop:
    capture_mode = "visible-region"
    supports_tree = False

    def __init__(self):
        if not os.environ.get("DISPLAY") or os.environ.get("XDG_SESSION_TYPE") == "wayland":
            raise ComputerHelperError("UNAVAILABLE", "Window automation requires an X11 session; Wayland is not supported")
        from Xlib.display import Display
        self.display = Display()

    def _property(self, window, name):
        from Xlib import X
        result = window.get_full_property(self.display.intern_atom(name), X.AnyPropertyType)
        return result.value if result is not None else None

    def windows(self) -> list:
        ids = self._property(self.display.screen().root, "_NET_CLIENT_LIST")
        return [self.display.create_resource_object("window", int(identity)) for identity in ([] if ids is None else ids)]

    def identity(self, window) -> tuple:
        pid = self._property(window, "_NET_WM_PID")
        return window.id, int(pid[0]) if pid is not None and len(pid) else 0

    def describe(self, window) -> dict:
        from Xlib import X
        if window.get_attributes().map_state != X.IsViewable:
            raise ComputerHelperError("UNAVAILABLE", "Window is not visible")
        geometry = window.get_geometry()
        translated = self.display.screen().root.translate_coords(window, 0, 0)
        title = self._property(window, "_NET_WM_NAME")
        if isinstance(title, bytes):
            title = title.decode("utf-8", errors="replace")
        return {"title": str(title or window.get_wm_name() or ""), "processId": self.identity(window)[1],
                "bounds": {"x": translated.x, "y": translated.y,
                           "width": geometry.width, "height": geometry.height}}

    def focus(self, window) -> None:
        from Xlib import X, protocol
        event = protocol.event.ClientMessage(window=window, client_type=self.display.intern_atom("_NET_ACTIVE_WINDOW"),
                                             data=(32, [2, X.CurrentTime, 0, 0, 0]))
        self.display.screen().root.send_event(event, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        self.display.sync()

    def root(self, _window):
        raise ComputerHelperError("UNAVAILABLE", "UI control trees require a supported accessibility backend; X11 has no bundled AT-SPI backend")
