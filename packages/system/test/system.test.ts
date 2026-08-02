import { describe, expect, test } from 'bun:test'

import { systemTools } from '../src/Collection'
import { SystemToolNames } from '../src/system-tool-names'

describe('System capability', () => {
  test('publishes only canonical system tool ids', () => {
    expect(Object.keys(systemTools).toSorted()).toEqual(Object.values(SystemToolNames).toSorted())
    expect(Object.keys(systemTools).every((name) => name.startsWith('system:'))).toBe(true)
  })

  test('does not publish project discovery or diagnostic shortcuts', () => {
    expect(Object.hasOwn(systemTools, 'discover_projects')).toBe(false)
    expect(Object.hasOwn(systemTools, 'diagnose_dev_runtime')).toBe(false)
    expect(Object.hasOwn(systemTools, 'get_system_overview')).toBe(false)
  })
})
