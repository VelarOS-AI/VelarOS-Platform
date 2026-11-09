import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { expect, test } from 'bun:test'

const PythonCommand = ['python3', 'python'].find(
  (command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
)
const pythonTest = PythonCommand ? test : test.skip

pythonTest(
  'all platform key handlers consume keys and reject the removed keySequence alias',
  () => {
    const runtimeDir = resolve(import.meta.dir, '../../runtime')
    const script = String.raw`
import ast
from pathlib import Path
from types import SimpleNamespace

# 只装载真实按键函数与其别名表；不导入图形依赖，也不接触用户的桌面。
for filename in ("mac_helper.py", "win_helper.py", "linux_helper.py"):
    tree = ast.parse(Path(filename).read_text(encoding="utf-8"), filename)
    nodes = [node for node in tree.body if (
        isinstance(node, ast.FunctionDef) and node.name in ("normalize_key", "key_combo")
    ) or (
        isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "KEY_ALIASES" for target in node.targets
        )
    )]
    calls = []
    backend = SimpleNamespace(
        press=lambda key: calls.append(("press", key)),
        hotkey=lambda *keys, **options: calls.append(("hotkey", keys, options)),
    )
    scope = {"pyautogui": backend, "load_pyautogui": lambda: backend}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, "exec"), scope)
    combo = scope["key_combo"]
    assert combo({"keys": "ctrl+A"}) == {"pressed": ["ctrl", "a"]}, filename
    assert calls == [("hotkey", ("ctrl", "a"), {"interval": 0.02})], filename
    assert combo({"keys": "enter", "keySequence": "ctrl+x"}) == {"pressed": ["enter"]}, filename
    assert calls[-1] == ("press", "enter"), filename
    count = len(calls)
    for payload in ({"keySequence": "ctrl+x"}, {"keys": "", "keySequence": "ctrl+x"}):
        try:
            combo(payload)
        except ValueError as error:
            assert str(error) == "No keys provided", filename
        else:
            raise AssertionError(f"{filename} accepted the removed keySequence field")
    assert len(calls) == count, filename
`
    const result = spawnSync(PythonCommand, ['-c', script], {
      cwd: runtimeDir,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
  }
)

pythonTest('helper binds screenshot ids to geometry and fails closed', () => {
  const runtimeDir = resolve(import.meta.dir, '../../runtime')
  const script = String.raw`
from computer_helper_common import (
    ComputerHelperError,
    ScreenSnapshotRegistry,
    parse_pointer_coordinate_binding,
)

display = {
    "displayId": 7,
    "width": 1920,
    "height": 1080,
    "scaleFactor": 1,
    "originX": -1920,
    "originY": 120,
}

registry = ScreenSnapshotRegistry(max_entries=2)
snapshot_id = registry.capture(display, dict(display))
x, y, state = registry.resolve_primary_point(snapshot_id, 100, 50, dict(display))
assert (x, y) == (-1820, 170)
assert state == display

changed_during_capture = dict(display)
changed_during_capture["displayId"] = 8
try:
    registry.capture(display, changed_during_capture)
except ComputerHelperError as error:
    assert error.code == "screen_snapshot_stale"
else:
    raise AssertionError("screenshot was bound after the primary display changed mid-capture")

assert parse_pointer_coordinate_binding({}) == ("global", None)
assert parse_pointer_coordinate_binding({
    "coordinateSpace": "primary-display",
    "snapshotId": snapshot_id,
}) == ("primary-display", snapshot_id)
try:
    parse_pointer_coordinate_binding({
        "coordinateSpace": "global",
        "snapshotId": snapshot_id,
    })
except ComputerHelperError as error:
    assert error.code == "screen_snapshot_unexpected"
else:
    raise AssertionError("global click accepted a screenshot binding")

for invalid_coordinate_space in (None, "", 0, False):
    try:
        parse_pointer_coordinate_binding({
            "coordinateSpace": invalid_coordinate_space,
        })
    except ComputerHelperError as error:
        assert error.code == "screen_coordinate_space_invalid"
    else:
        raise AssertionError("invalid coordinateSpace fell back to a global click")

try:
    registry.resolve_primary_point("screen_unknown_snapshot", 100, 50, dict(display))
except ComputerHelperError as error:
    assert error.code == "screen_snapshot_stale"
else:
    raise AssertionError("unknown snapshot was accepted")

try:
    registry.resolve_primary_point(snapshot_id, 1920, 50, dict(display))
except ComputerHelperError as error:
    assert error.code == "screen_coordinate_out_of_bounds"
else:
    raise AssertionError("out-of-bounds point was accepted")

changed_values = {
    "displayId": 8,
    "width": 1919,
    "height": 1079,
    "scaleFactor": 2,
    "originX": 0,
    "originY": 0,
}
for field, changed_value in changed_values.items():
    snapshot_id = registry.capture(display, dict(display))
    changed = dict(display)
    changed[field] = changed_value
    try:
        registry.resolve_primary_point(snapshot_id, 100, 50, changed)
    except ComputerHelperError as error:
        assert error.code == "screen_snapshot_stale"
    else:
        raise AssertionError(f"changed display state field {field} was accepted")

# A stale binding stays invalid even if the old geometry is later restored.
try:
    registry.resolve_primary_point(snapshot_id, 100, 50, dict(display))
except ComputerHelperError as error:
    assert error.code == "screen_snapshot_stale"
else:
    raise AssertionError("invalidated snapshot became valid again")
`
  const result = spawnSync(PythonCommand, ['-c', script], {
    cwd: runtimeDir,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  expect(result.status, result.stderr || result.stdout).toBe(0)
})
