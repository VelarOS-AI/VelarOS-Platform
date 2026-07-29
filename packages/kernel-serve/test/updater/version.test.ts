import { describe, expect, test } from 'bun:test'

import {
  assertKernelVersion,
  compareKernelVersions,
  isKernelVersion,
  KernelUpdaterError,
  parseKernelVersion,
  satisfiesKernelVersionRange,
} from '../../src/updater'

describe('Kernel version matching', () => {
  test('parses semantic versions and rejects everything else', () => {
    expect(parseKernelVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: undefined,
    })
    expect(parseKernelVersion('v2.0.0-rc.1').prerelease).toBe('rc.1')

    for (const invalid of ['1.2', 'latest', '1.2.3.4', '', '../escape', '1.2.x']) {
      expect(isKernelVersion(invalid)).toBe(false)
      expect(() => assertKernelVersion(invalid)).toThrowError(KernelUpdaterError)
    }
  })

  test('orders releases ahead of their prereleases', () => {
    const versions = ['1.10.0', '1.2.0', '2.0.0-rc.1', '2.0.0', '1.2.0-beta']
    expect([...versions].sort(compareKernelVersions)).toEqual([
      '1.2.0-beta',
      '1.2.0',
      '1.10.0',
      '2.0.0-rc.1',
      '2.0.0',
    ])
  })

  test('matches the range forms a launcher requirement can use', () => {
    expect(satisfiesKernelVersionRange('1.4.0')).toBe(true)
    expect(satisfiesKernelVersionRange('1.4.0', '*')).toBe(true)
    expect(satisfiesKernelVersionRange('1.4.0', '1.4.0')).toBe(true)
    expect(satisfiesKernelVersionRange('1.4.1', '1.4.0')).toBe(false)
    expect(satisfiesKernelVersionRange('1.4.0', '^1.2.0')).toBe(true)
    expect(satisfiesKernelVersionRange('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfiesKernelVersionRange('0.2.9', '^0.2.0')).toBe(true)
    expect(satisfiesKernelVersionRange('0.3.0', '^0.2.0')).toBe(false)
    expect(satisfiesKernelVersionRange('1.2.9', '~1.2.0')).toBe(true)
    expect(satisfiesKernelVersionRange('1.3.0', '~1.2.0')).toBe(false)
    expect(satisfiesKernelVersionRange('1.5.0', '>=1.2.0 <2.0.0')).toBe(true)
    expect(satisfiesKernelVersionRange('2.0.0', '>=1.2.0 <2.0.0')).toBe(false)
    expect(satisfiesKernelVersionRange('2.1.0', '^1.0.0 || ^2.0.0')).toBe(true)
  })

  test('rejects an unparsable range distinctly from an unparsable version', () => {
    expect(() => satisfiesKernelVersionRange('nightly', '^1.0.0'))
      .toThrowError(/Invalid Kernel version/)
    try {
      satisfiesKernelVersionRange('1.0.0', '^1.x')
      throw new Error('Expected the range to be rejected')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_VERSION_RANGE',
        details: { versionRange: '1.x' },
      })
    }
  })
})
