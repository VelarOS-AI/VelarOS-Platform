import { describe, expect, test } from 'bun:test'

import { assertSemanticVersion, satisfiesVersionRange } from '../../src/utils/runtime/version'
import {
  compareKernelVersions,
  isKernelVersion,
  parseKernelVersion,
  satisfiesKernelVersionRange,
} from '../../src/utils/updater/version'
import { parseVelarosModEnvelope } from '../../src/utils/wire/mod-envelope'

describe('语义化版本口径', () => {
  test('宿主与更新器对同一个版本号给同一个结论', () => {
    // 宿主那份原来比较时忽略预发布：`1.0.0-beta.1` 被判为满足 `>=1.0.0`，而同一个包里的
    // 更新器判不满足。
    for (const [version, range, satisfied] of [
      ['1.0.0-beta.1', '>=1.0.0', false],
      ['1.0.0-beta.1', '>=1.0.0-alpha.1', true],
      ['1.0.0', '>=1.0.0', true],
      ['1.2.3', '^1.0.0', true],
      ['2.0.0', '^1.0.0', false],
      ['1.2.3', '~1.2.0', true],
      ['1.3.0', '~1.2.0', false],
      ['1.0.0+build.1', '>=1.0.0', true],
    ] as const) {
      expect(satisfiesVersionRange(version, range)).toBe(satisfied)
      expect(satisfiesKernelVersionRange(version, range)).toBe(satisfied)
    }
  })

  test('mod 信封接受的版本号，宿主的清单校验也接受', () => {
    // 信封放行 `1.0.0+build.1`，宿主原来当场判 INVALID_VERSION。
    const envelope = parseVelarosModEnvelope({
      module: { id: 'velaros.probe', version: '1.0.0+build.1', apiVersion: 1 },
    })
    expect(envelope.ok).toBe(true)
    expect(() => assertSemanticVersion('1.0.0+build.1')).not.toThrow()
    expect(isKernelVersion('1.0.0+build.1')).toBe(true)
    expect(parseKernelVersion('1.0.0+build.1')).toMatchObject({
      major: 1,
      minor: 0,
      patch: 0,
      build: 'build.1',
    })
    // build 元数据不参与比较（SemVer §10）。
    expect(compareKernelVersions('1.0.0+a', '1.0.0+b')).toBe(0)
  })

  test('非法版本号在两条路径上都按各自的领域错误抛出', () => {
    expect(() => assertSemanticVersion('1.0')).toThrow(
      expect.objectContaining({ name: 'KernelError', code: 'INVALID_VERSION' })
    )
    expect(() => satisfiesVersionRange('1.0.0', '>=')).toThrow(
      expect.objectContaining({ code: 'INVALID_VERSION_RANGE' })
    )
    expect(() => parseKernelVersion('1.0')).toThrow(
      expect.objectContaining({
        name: 'KernelUpdaterError',
        code: 'INVALID_VERSION',
      })
    )
  })
})
