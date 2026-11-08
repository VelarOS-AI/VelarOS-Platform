import { describe, expect, test } from 'bun:test'

import {
  compareSemanticVersions,
  isSemanticVersion,
  isSemanticVersionRange,
  parseSemanticVersion,
  parseSemanticVersionRange,
  satisfiesSemanticVersionRange,
} from '../../src/utils/semver'
import {
  compareKernelVersions,
  isKernelVersion,
  parseKernelVersion,
  satisfiesKernelVersionRange,
} from '../../src/utils/updater/version'
import { parseVelarosModEnvelope } from '../../src/utils/wire/mod-envelope'

describe('语义化版本口径', () => {
  test('宿主与更新器使用同一范围口径，build 不参与匹配或排序', () => {
    for (const [version, range, satisfied] of [
      ['1.0.0-beta.1', '>=1.0.0', false],
      ['1.0.0-beta.1', '>=1.0.0-alpha.1', true],
      ['1.0.0', '>=1.0.0', true],
      ['1.2.3', '^1.0.0', true],
      ['2.0.0', '^1.0.0', false],
      ['0.0.3', '^0.0.2', false],
      ['1.2.3', '~1.2.0', true],
      ['1.3.0', '~1.2.0', false],
      ['1.0.0+build.1', '>=1.0.0', true],
      ['9007199254740991.2.3', '^9007199254740991.0.0', true],
      ['1.9007199254740991.3', '~1.9007199254740991.0', true],
    ] as const) {
      expect(satisfiesSemanticVersionRange(version, range)).toBe(satisfied)
      expect(satisfiesKernelVersionRange(version, range)).toBe(satisfied)
    }
    expect(compareKernelVersions('1.0.0+a', '1.0.0+b')).toBe(0)
    expect(parseKernelVersion('1.0.0+build.1')).toMatchObject({ build: 'build.1' })
  })

  test('按标识逐段排序预发布版本，不把数字转成不精确的浮点数', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.10',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    expect([...ordered].reverse().sort(compareSemanticVersions)).toEqual(ordered)
    expect(
      compareSemanticVersions('1.0.0-999999999999999999999', '1.0.0-1000000000000000000000')
    ).toBeLessThan(0)
    expect(compareSemanticVersions('1.0.0-1000000000000000000000', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareSemanticVersions('1.0.0-alpha.1', '1.0.0-alpha.1.0')).toBeLessThan(0)
  })

  test('版本解析、更新器与 Mod 边界一致拒绝非法版本', () => {
    for (const version of [
      '1.0',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3-alpha..1',
      '1.2.3-.alpha',
      '1.2.3+build..1',
      '1.2.3-',
      '1.2.3+',
      '1.2.3-???',
      '9007199254740992.0.0',
      'v1.2.3',
      ' 1.2.3',
      '1.2.3 ',
      '1.2.3\n',
    ]) {
      expect(isSemanticVersion(version)).toBe(false)
      expect(isKernelVersion(version)).toBe(false)
      expect(() => parseSemanticVersion(version)).toThrow(
        expect.objectContaining({
          code: 'INVALID_VERSION',
          details: { source: version },
        })
      )
      expect(() => parseKernelVersion(version)).toThrow(
        expect.objectContaining({
          name: 'KernelUpdaterError',
          code: 'INVALID_VERSION',
          details: { version },
        })
      )
      expect(
        parseVelarosModEnvelope({
          module: { id: 'velaros.probe', version, apiVersion: 1 },
        }).ok
      ).toBe(false)
    }
    for (const version of ['1.2.3-0', '1.2.3-01a', '1.2.3+01', '1.2.3+build.1']) {
      expect(isSemanticVersion(version)).toBe(true)
      expect(isKernelVersion(version)).toBe(true)
      expect(
        parseVelarosModEnvelope({
          module: { id: 'velaros.probe', version, apiVersion: 1 },
        }).ok
      ).toBe(true)
    }
  })

  test('先校验完整范围，匹配短路不能跳过非法尾项或空分句', () => {
    expect(satisfiesSemanticVersionRange('1.0.0')).toBe(true)
    expect(satisfiesSemanticVersionRange('1.0.0', '*')).toBe(true)
    for (const range of [
      '',
      ' ',
      'x',
      '1.x',
      '* || nonsense',
      '<0.0.0 nonsense',
      '1.0.0 ||',
      '|| 1.0.0',
      '^1.0.0 nonsense',
      '* nonsense',
      '>=',
    ]) {
      expect(isSemanticVersionRange(range)).toBe(false)
      expect(() => parseSemanticVersionRange(range)).toThrow(
        expect.objectContaining({
          code: 'INVALID_VERSION_RANGE',
          details: { source: range },
        })
      )
      expect(() => satisfiesSemanticVersionRange('1.0.0', range)).toThrow(
        expect.objectContaining({
          code: 'INVALID_VERSION_RANGE',
        })
      )
      expect(() => satisfiesKernelVersionRange('1.0.0', range)).toThrow(
        expect.objectContaining({
          name: 'KernelUpdaterError',
          details: { versionRange: range },
        })
      )
    }
  })
})
