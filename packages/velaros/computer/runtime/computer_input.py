"""复用 PyAutoGUI 的输入后端，统一滚动、原子拖拽与有期限的按住状态。"""
from __future__ import annotations

import threading
from typing import Any, Callable

from computer_helper_common import ComputerHelperError

INPUT_LEASE_MS = 5000


class ComputerInput:
    def __init__(self, backend: Callable, resolve_point: Callable, normalize_key: Callable):
        self.backend = backend
        self.resolve_point = resolve_point
        self.normalize_key = normalize_key
        self.lock = threading.RLock()
        self.held: dict[str, threading.Timer] = {}

    def _state(self, released: list[str]) -> dict[str, Any]:
        return {"held": list(self.held), "released": released, "leaseMs": INPUT_LEASE_MS}

    def _release(self, identity: str) -> None:
        kind, name = identity.split(":", 1)
        backend = self.backend()
        if kind == "mouse":
            backend.mouseUp(button=name)
        else:
            backend.keyUp(name)
        timer = self.held.pop(identity, None)
        if timer is not None:
            timer.cancel()

    def _expire(self, identity: str, timer: threading.Timer) -> None:
        with self.lock:
            if self.held.get(identity) is timer:
                try:
                    self._release(identity)
                except Exception as error:
                    # 自动清理失败不能伪装成功；保留状态供显式 releaseInputs 重试。
                    import sys
                    print(f"input lease cleanup failed: {error}", file=sys.stderr)

    def _register(self, kind: str, name: str) -> str:
        identity = f"{kind}:{name}"
        if identity in self.held:
            raise ComputerHelperError("CONFLICT", f"{identity} is already held")
        timer = threading.Timer(INPUT_LEASE_MS / 1000, lambda: self._expire(identity, timer))
        timer.daemon = True
        # 先记账再发按下事件：后端部分成功后抛错也能进入清理。
        self.held[identity] = timer
        try:
            timer.start()
        except BaseException:
            # 此时还没发按下事件，启动租约失败只撤回本次登记。
            self.held.pop(identity, None)
            timer.cancel()
            raise
        return identity

    def _release_after(self, identity: str, failure: BaseException | None = None) -> None:
        try:
            self._release(identity)
        except Exception as cleanup_error:
            if failure is None:
                raise
            if not isinstance(failure, Exception):
                raise failure from cleanup_error
            code = failure.code if isinstance(failure, ComputerHelperError) else "helper_error"
            raise ComputerHelperError(
                code, f"{failure}；释放输入 {identity} 失败：{cleanup_error}"
            ) from failure

    def _hold(self, kind: str, name: str) -> dict[str, Any]:
        identity = self._register(kind, name)
        try:
            if kind == "mouse":
                self.backend().mouseDown(button=name)
            else:
                self.backend().keyDown(name)
        except BaseException as failure:
            self._release_after(identity, failure)
            raise
        return self._state([])

    def mouse_down(self, payload: dict) -> dict:
        with self.lock:
            button = payload.get("button") or "left"
            if "mouse:" + button in self.held:
                raise ComputerHelperError("CONFLICT", f"mouse:{button} is already held")
            x, y, _ = self.resolve_point(payload["at"])
            self.backend().moveTo(x, y)
            self.resolve_point(payload["at"])
            return self._hold("mouse", button)

    def mouse_up(self, payload: dict) -> dict:
        with self.lock:
            identity = "mouse:" + (payload.get("button") or "left")
            released = [identity] if identity in self.held else []
            if released:
                self._release(identity)
            return self._state(released)

    def key_down(self, payload: dict) -> dict:
        with self.lock:
            key = self.normalize_key(payload["key"])
            if key not in self.backend().KEYBOARD_KEYS:
                raise ComputerHelperError("VALIDATION", f"Unsupported key: {key}")
            return self._hold("key", key)

    def key_up(self, payload: dict) -> dict:
        with self.lock:
            identity = "key:" + self.normalize_key(payload["key"])
            released = [identity] if identity in self.held else []
            if released:
                self._release(identity)
            return self._state(released)

    def release_inputs(self, _payload: dict | None = None) -> dict:
        with self.lock:
            released = []
            errors = []
            for identity in list(self.held):
                try:
                    self._release(identity)
                    released.append(identity)
                except Exception as error:
                    errors.append(str(error))
            if errors:
                raise ComputerHelperError("UNAVAILABLE", "; ".join(errors))
            return self._state(released)

    def scroll(self, payload: dict) -> dict:
        with self.lock:
            x, y, _ = self.resolve_point(payload["at"])
            delta_x, delta_y = payload.get("deltaX", 0), payload.get("deltaY", 0)
            if any(type(value) is not int or abs(value) > 100 for value in (delta_x, delta_y)) or not (delta_x or delta_y):
                raise ComputerHelperError("VALIDATION", "Scroll requires non-zero integer ticks, at most 100 per axis")
            backend = self.backend()
            backend.moveTo(x, y)
            # PyAutoGUI 的纵轴正号向上；产品合同的正号统一向下。
            if delta_y:
                backend.scroll(-delta_y)
            if delta_x:
                import sys
                if sys.platform == "win32":
                    # PyAutoGUI Windows 的 hscroll 实际调用纵向滚轮；复用 pywin32 发正确的 HWHEEL。
                    import win32api
                    import win32con
                    win32api.mouse_event(win32con.MOUSEEVENTF_HWHEEL, 0, 0, delta_x * win32con.WHEEL_DELTA, 0)
                else:
                    backend.hscroll(delta_x)
            return {"deltaX": delta_x, "deltaY": delta_y}

    def drag(self, payload: dict) -> dict:
        with self.lock:
            if any(identity.startswith("mouse:") for identity in self.held):
                raise ComputerHelperError("CONFLICT", "Release held mouse buttons before drag")
            start_x, start_y, _ = self.resolve_point(payload["from"])
            end_x, end_y, _ = self.resolve_point(payload["to"])
            backend = self.backend()
            button = payload.get("button") or "left"
            duration = payload.get("durationMs", 500) / 1000
            if not 0.1 <= duration <= 3:
                raise ComputerHelperError("VALIDATION", "Drag duration must be between 100 and 3000 ms")
            backend.moveTo(start_x, start_y)
            self.resolve_point(payload["from"])
            self.resolve_point(payload["to"])
            # dragTo 自己发按下事件，但释放责任仍由同一 held/租约持有。
            identity = self._register("mouse", button)
        # 拖拽期间不持有状态锁，否则会阻止其他已按住键的租约及时释放。
        failure: BaseException | None = None
        try:
            backend.dragTo(end_x, end_y, duration=duration, button=button)
        except BaseException as error:
            failure = error
            raise
        finally:
            with self.lock:
                if identity in self.held:
                    self._release_after(identity, failure)
        return {"dragged": True}
