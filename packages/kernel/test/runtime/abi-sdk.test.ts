import { describe, expect, test } from 'bun:test'

import {
  createCapabilityToken,
  defineKernelModule,
  requireCapability,
} from '../../src/contracts/abi'

describe('kernel sdk', () => {
  test('creates stable typed capability declarations', () => {
    const token = createCapabilityToken<{ value: string }>('example.value')

    expect(token.id).toBe('example.value')
    expect(token.version).toBe('1.0.0')
    expect(requireCapability(token, '^1.0.0')).toEqual({
      id: 'example.value',
      versionRange: '^1.0.0',
    })
    expect(Object.isFrozen(token)).toBe(true)
  })

  test('preserves module definitions without adding runtime policy', () => {
    const module = defineKernelModule({
      manifest: {
        id: 'example.module',
        version: '1.0.0',
        apiVersion: 1,
        provides: [],
        requires: [],
        optionalRequires: [],
        permissions: [],
        isolation: 'in-process' as const,
      },
      activate() {},
    })

    expect(module.manifest.id).toBe('example.module')
  })
})
