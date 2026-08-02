import { describe, expect, test } from 'bun:test'

import { OfficeResourceRuntimeRegistry } from '../src'

describe('OfficeResourceRuntimeRegistry', () => {
  test('owns isolated, idempotent resource state', () => {
    const registry = new OfficeResourceRuntimeRegistry({
      extraResourceRoots: ['/opt/office', ' /opt/office '],
      disabledResources: ['markitdown'],
    })

    expect(registry.extraResourceRoots()).toEqual(['/opt/office'])
    expect(registry.isDisabled('markitdown')).toBe(true)

    const snapshot = registry.extraResourceRoots()
    snapshot.push('/mutated-outside')
    expect(registry.extraResourceRoots()).toEqual(['/opt/office'])

    registry.setDisabledResources([])
    expect(registry.isDisabled('markitdown')).toBe(false)
  })
})
