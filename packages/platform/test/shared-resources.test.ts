import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { velarosSharedResources } from '../src/shared-resources.js'

describe('VelarOS shared resource store', () => {
  test('resolves the stable organization root on supported platform families', () => {
    expect(velarosSharedResources.dataRoot({
      platform: 'darwin',
      env: {},
      homeDirectory: '/Users/example',
    })).toBe(join('/Users/example', 'Library', 'Application Support', 'VelarOS'))

    expect(velarosSharedResources.dataRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\example',
    })).toBe(join('C:\\Users\\example\\AppData\\Local', 'VelarOS'))

    expect(velarosSharedResources.dataRoot({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/home/example/.data' },
      homeDirectory: '/home/example',
    })).toBe(join('/home/example/.data', 'VelarOS'))
  })

  test('places reusable products under shared/resources and honors an override', () => {
    expect(velarosSharedResources.resourcesRoot({
      platform: 'linux',
      env: { VELAROS_SHARED_DATA_ROOT: '/portable/VelarOS' },
      homeDirectory: '/ignored',
    })).toBe(join('/portable/VelarOS', 'shared', 'resources'))
  })

  test('places product-family account sessions under a versioned shared root', () => {
    expect(velarosSharedResources.accountRoot({
      platform: 'linux',
      env: { VELAROS_SHARED_DATA_ROOT: '/portable/VelarOS' },
      homeDirectory: '/ignored',
    })).toBe(join('/portable/VelarOS', 'shared', 'account', 'v1'))
  })
})
