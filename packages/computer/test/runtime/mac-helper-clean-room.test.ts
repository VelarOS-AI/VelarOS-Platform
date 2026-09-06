import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { expect, test } from 'bun:test'

const PythonCommand = ['python3', 'python'].find((command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
)
const pythonTest = PythonCommand ? test : test.skip

pythonTest('clean-room mac helper preserves geometry, snapshot, and input contracts', () => {
  const runtimeDir = resolve(import.meta.dir, '../../runtime')
  const script = String.raw`
import base64
import importlib.util
import sys
import types

display_state = {
    "display_id": 42,
    "width": 1500,
    "height": 1000,
    "origin_x": -1500,
    "origin_y": 80,
    "pixel_width": 3000,
    "pixel_height": 2000,
}

quartz = types.ModuleType("Quartz")
quartz.kCGHIDEventTap = 7
quartz.CGMainDisplayID = lambda: display_state["display_id"]
quartz.CGDisplayBounds = lambda _display_id: types.SimpleNamespace(
    origin=types.SimpleNamespace(
        x=display_state["origin_x"],
        y=display_state["origin_y"],
    ),
    size=types.SimpleNamespace(
        width=display_state["width"],
        height=display_state["height"],
    ),
)
quartz.CGDisplayPixelsWide = lambda _display_id: display_state["pixel_width"]
quartz.CGDisplayPixelsHigh = lambda _display_id: display_state["pixel_height"]
quartz.CGDisplayCopyDisplayMode = lambda _display_id: "current-mode"
quartz.CGDisplayModeGetPixelWidth = lambda _mode: display_state["pixel_width"]
quartz.CGDisplayModeGetPixelHeight = lambda _mode: display_state["pixel_height"]
quartz.AXIsProcessTrusted = lambda: True
quartz.CGPreflightScreenCaptureAccess = lambda: True

posted_events = []
quartz.CGEventCreateKeyboardEvent = lambda _source, key_code, is_down: {
    "key_code": key_code,
    "is_down": is_down,
}
def set_unicode(event, length, units):
    event["unicode_length"] = length
    event["unicode_units"] = tuple(ord(unit) for unit in units)
quartz.CGEventKeyboardSetUnicodeString = set_unicode
quartz.CGEventPost = lambda tap, event: posted_events.append((tap, dict(event)))
sys.modules["Quartz"] = quartz

image_module = types.ModuleType("PIL.Image")
image_module.Resampling = types.SimpleNamespace(LANCZOS="lanczos")
pil_module = types.ModuleType("PIL")
pil_module.Image = image_module
sys.modules["PIL"] = pil_module
sys.modules["PIL.Image"] = image_module

input_calls = []
pyautogui = types.ModuleType("pyautogui")
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 1
pyautogui.moveTo = lambda x, y, duration: input_calls.append(
    ("move", x, y, duration)
)
pyautogui.click = lambda **kwargs: input_calls.append(("click", kwargs))
pyautogui.press = lambda key: input_calls.append(("press", key))
pyautogui.hotkey = lambda *keys, **kwargs: input_calls.append(
    ("hotkey", keys, kwargs)
)
sys.modules["pyautogui"] = pyautogui

spec = importlib.util.spec_from_file_location("velaros_mac_helper", "mac_helper.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

display = module.primary_display()
assert display == {
    "displayId": 42,
    "width": 1500,
    "height": 1000,
    "scaleFactor": 2.0,
    "originX": -1500,
    "originY": 80,
}
assert module.check({}) == {
    "platform": "darwin",
    "accessibility": True,
    "screenRecording": True,
}

class FakeImage:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.saved = None

    @property
    def size(self):
        return (self.width, self.height)

    def resize(self, size, resample):
        assert resample == "lanczos"
        self.width, self.height = size
        return self

    def save(self, buffer, **options):
        self.saved = options
        buffer.write(b"clean-room-jpeg")

captured_image = FakeImage(3000, 2000)
module._capture_main_display_image = lambda: captured_image
shot = module.screenshot({"quality": 200})
assert shot["base64"] == base64.b64encode(b"clean-room-jpeg").decode("ascii")
assert shot["format"] == "jpeg"
assert shot["width"] == shot["displayWidth"] == 1500
assert shot["height"] == shot["displayHeight"] == 1000
assert shot["snapshotId"].startswith("screen_")
assert captured_image.saved == {"format": "JPEG", "quality": 95, "optimize": True}

clicked = module.left_click({
    "x": 25,
    "y": 30,
    "coordinateSpace": "primary-display",
    "snapshotId": shot["snapshotId"],
    "button": "right",
    "count": 2,
})
assert clicked == {
    "x": -1475,
    "y": 110,
    "button": "right",
    "count": 2,
    "coordinateSpace": "primary-display",
    "displayId": 42,
    "snapshotId": shot["snapshotId"],
}
assert input_calls[-1] == (
    "click",
    {"x": -1475, "y": 110, "button": "right", "clicks": 2, "interval": 0.08},
)

click_count = len(input_calls)
display_state["width"] = 1499
try:
    module.left_click({
        "x": 25,
        "y": 30,
        "coordinateSpace": "primary-display",
        "snapshotId": shot["snapshotId"],
    })
except Exception as error:
    assert getattr(error, "code", None) == "screen_snapshot_stale"
else:
    raise AssertionError("stale screenshot binding reached the input backend")
assert len(input_calls) == click_count

try:
    module.left_click({
        "x": 1,
        "y": 2,
        "coordinateSpace": "global",
        "snapshotId": shot["snapshotId"],
    })
except Exception as error:
    assert getattr(error, "code", None) == "screen_snapshot_unexpected"
else:
    raise AssertionError("global click accepted a screenshot binding")
assert len(input_calls) == click_count

assert module.mouse_move({"x": -10, "y": 15, "durationMs": 5000}) == {
    "x": -10,
    "y": 15,
}
assert input_calls[-1] == ("move", -10, 15, 0.8)

assert module.key_combo({"keys": "cmd+opt+A"}) == {
    "pressed": ["command", "option", "a"],
}
assert input_calls[-1] == (
    "hotkey",
    ("command", "option", "a"),
    {"interval": 0.02},
)

unicode_text = "A" + chr(0x4E2D) + chr(0x1F642)
assert module.type_text({"text": unicode_text}) == {"typed": 3}
assert posted_events[0] == (
    7,
    {
        "key_code": 0,
        "is_down": True,
        "unicode_length": 4,
        "unicode_units": (65, 20013, 55357, 56898),
    },
)
assert posted_events[1] == (7, {"key_code": 0, "is_down": False})

try:
    module.dispatch("unknown", {})
except ValueError as error:
    assert str(error) == "Unknown command: unknown"
else:
    raise AssertionError("unknown command was accepted")
`
  const result = spawnSync(PythonCommand, ['-c', script], {
    cwd: runtimeDir,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  expect(result.status, result.stderr || result.stdout).toBe(0)
})
