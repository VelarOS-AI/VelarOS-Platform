import { describe, expect, test } from 'bun:test'

import { BrowserResourceRuntimeRegistry } from '../dist/index.js'

describe('BrowserResourceRuntimeRegistry', () => {
  test('owns isolated, idempotent resource state', () => {
    const registry = new BrowserResourceRuntimeRegistry({
      extraResourceRoots: ['/opt/browser', ' /opt/browser '],
      disabledResources: ['cloakbrowser'],
    })

    expect(registry.extraResourceRoots()).toEqual(['/opt/browser'])
    expect(registry.isDisabled('cloakbrowser')).toBe(true)

    const snapshot = registry.extraResourceRoots()
    snapshot.push('/mutated-outside')
    expect(registry.extraResourceRoots()).toEqual(['/opt/browser'])

    registry.setDisabledResources([])
    expect(registry.isDisabled('cloakbrowser')).toBe(false)
  })
})
