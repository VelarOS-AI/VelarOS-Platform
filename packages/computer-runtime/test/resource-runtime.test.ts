import { describe, expect, test } from 'bun:test'

import { ComputerResourceRuntimeRegistry } from '../src'

describe('ComputerResourceRuntimeRegistry', () => {
  test('owns isolated, idempotent resource state', () => {
    const registry = new ComputerResourceRuntimeRegistry({
      extraResourceRoots: ['/opt/computer', ' /opt/computer '],
      disabledResources: ['computeruse'],
    })

    expect(registry.extraResourceRoots()).toEqual(['/opt/computer'])
    expect(registry.isDisabled('computeruse')).toBe(true)

    const snapshot = registry.extraResourceRoots()
    snapshot.push('/mutated-outside')
    expect(registry.extraResourceRoots()).toEqual(['/opt/computer'])

    registry.setDisabledResources([])
    expect(registry.isDisabled('computeruse')).toBe(false)
  })
})
