import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { expect, test } from 'bun:test'

const PythonCommand = ['python3', 'python'].find((command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
)
const pythonTest = PythonCommand ? test : test.skip

pythonTest('helper binds screenshot ids to geometry and fails closed', () => {
  const runtimeDir = resolve(import.meta.dir, '../../runtime')
  const script = String.raw`
from computer_helper_common import (
    ComputerHelperError,
    ScreenSnapshotRegistry,
    parse_click_coordinate_binding,
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

assert parse_click_coordinate_binding({}) == ("global", None)
assert parse_click_coordinate_binding({
    "coordinateSpace": "primary-display",
    "snapshotId": snapshot_id,
}) == ("primary-display", snapshot_id)
try:
    parse_click_coordinate_binding({
        "coordinateSpace": "global",
        "snapshotId": snapshot_id,
    })
except ComputerHelperError as error:
    assert error.code == "screen_snapshot_unexpected"
else:
    raise AssertionError("global click accepted a screenshot binding")

for invalid_coordinate_space in (None, "", 0, False):
    try:
        parse_click_coordinate_binding({
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
