import { describe, expect, test } from 'bun:test'

import {
  advanceSoloProcessUpdateCadence,
  createSoloProcessUpdateCadenceState,
} from '../src/agent/SoloProcessUpdateCadence'

void describe('solo process update cadence', () => {
  void test('reminds only after a meaningful batch of silent tool turns', () => {
    const first = advanceSoloProcessUpdateCadence(createSoloProcessUpdateCadenceState(), {
      hasVisibleText: false,
    })
    const second = advanceSoloProcessUpdateCadence(first.state, { hasVisibleText: false })

    expect(first.reminder).toBeNull()
    expect(second.reminder).toContain('可见的阶段进展')
    expect(second.reminder).toContain('不要逐工具播报')
  })

  void test('visible progress resets the silent turn counter', () => {
    const first = advanceSoloProcessUpdateCadence(createSoloProcessUpdateCadenceState(), {
      hasVisibleText: false,
    })
    const visible = advanceSoloProcessUpdateCadence(first.state, { hasVisibleText: true })
    const next = advanceSoloProcessUpdateCadence(visible.state, { hasVisibleText: false })

    expect(visible.reminder).toBeNull()
    expect(next.reminder).toBeNull()
    expect(next.state.consecutiveToolOnlyTurns).toBe(1)
  })

  void test('repeats the reminder when the model ignores it and continues silently', () => {
    const first = advanceSoloProcessUpdateCadence(createSoloProcessUpdateCadenceState(), {
      hasVisibleText: false,
    })
    const second = advanceSoloProcessUpdateCadence(first.state, { hasVisibleText: false })
    const third = advanceSoloProcessUpdateCadence(second.state, { hasVisibleText: false })

    expect(second.reminder).not.toBeNull()
    expect(third.reminder).not.toBeNull()
  })
})
