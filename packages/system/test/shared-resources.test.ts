import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  resolveVelarOSSharedAccountRoot,
  resolveVelarOSSharedDataRoot,
  resolveVelarOSSharedResourcesRoot,
} from '../src/VelarOSSharedResourceStore'

describe('VelarOS shared resource store', () => {
  test('resolves the stable organization root on supported platform families', () => {
    expect(resolveVelarOSSharedDataRoot({
      platform: 'darwin',
      env: {},
      homeDirectory: '/Users/example',
    })).toBe(join('/Users/example', 'Library', 'Application Support', 'VelarOS'))

    expect(resolveVelarOSSharedDataRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\example',
    })).toBe(join('C:\\Users\\example\\AppData\\Local', 'VelarOS'))

    expect(resolveVelarOSSharedDataRoot({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/home/example/.data' },
      homeDirectory: '/home/example',
    })).toBe(join('/home/example/.data', 'VelarOS'))
  })

  test('places reusable products under shared/resources and honors an override', () => {
    expect(resolveVelarOSSharedResourcesRoot({
      platform: 'linux',
      env: { VELAROS_SHARED_DATA_ROOT: '/portable/VelarOS' },
      homeDirectory: '/ignored',
    })).toBe(join('/portable/VelarOS', 'shared', 'resources'))
  })

  test('places product-family account sessions under a versioned shared root', () => {
    expect(resolveVelarOSSharedAccountRoot({
      platform: 'linux',
      env: { VELAROS_SHARED_DATA_ROOT: '/portable/VelarOS' },
      homeDirectory: '/ignored',
    })).toBe(join('/portable/VelarOS', 'shared', 'account', 'v1'))
  })
})
