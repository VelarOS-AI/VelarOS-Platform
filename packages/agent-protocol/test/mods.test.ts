import { describe, expect, test } from 'bun:test'

import {
  AgentModContributionAxisNames,
  AgentModManifestSchemaVersion,
  AgentModPackManifestFileName,
  AgentModPackProvidesId,
  isSemverRangeParsable,
  listAgentModDeclaredAxes,
  parseAgentModManifest,
  satisfiesSemverRange,
} from '../src/mods'

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'probe.mod',
    version: '1.0.0',
    manifestSchemaVersion: AgentModManifestSchemaVersion,
    engines: { velaros: '^1.0.0' },
    trust: 'local-dev',
    ...overrides,
  }
}

describe('semver range 判定', () => {
  test('支持的形态可解析，垃圾串不可解析', () => {
    for (const range of ['*', '1.2.3', '=1.2.3', '^1.2.3', '~1.2.3', '>=1.0.0 <2.0.0', '^1.0.0 || ^2.0.0']) {
      expect(isSemverRangeParsable(range)).toBe(true)
    }
    for (const range of ['', 'latest', '1.x.y', '>>1.0.0']) {
      expect(isSemverRangeParsable(range)).toBe(false)
    }
  })

  test('caret 在 0.x 收紧到 minor；合取与析取按 npm 语义', () => {
    expect(satisfiesSemverRange('1.9.0', '^1.2.3')).toBe(true)
    expect(satisfiesSemverRange('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfiesSemverRange('0.2.9', '^0.2.0')).toBe(true)
    expect(satisfiesSemverRange('0.3.0', '^0.2.0')).toBe(false)
    expect(satisfiesSemverRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesSemverRange('2.1.0', '^1.0.0 || ^2.0.0')).toBe(true)
    // range 非法一律 fail-closed。
    expect(satisfiesSemverRange('1.0.0', 'latest')).toBe(false)
  })
})

describe('manifest 解析', () => {
  test('形态层宽容：标量自动升成单元素数组', () => {
    const result = parseAgentModManifest(
      baseManifest({ permissions: 'agent:execute', entitlements: 'pro' })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.permissions).toEqual(['agent:execute'])
    expect(result.manifest.entitlements).toEqual(['pro'])
    expect(result.manifest.contributes).toEqual({})
  })

  test('语义层零宽容：未知字段、未知贡献轴、非法枚举一律拒载', () => {
    for (const overrides of [
      { unknownField: 1 },
      { contributes: { pages: [] } },
      { trust: 'self-signed' },
      { engines: { velaros: 'latest' } },
      { version: 'v1' },
    ]) {
      const result = parseAgentModManifest(baseManifest(overrides))
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.diagnostics[0]?.code).toBe('mod.manifest-invalid')
      expect(result.diagnostics[0]?.message.length).toBeGreaterThan(0)
    }
  })

  test('同轴主键重复给可读诊断', () => {
    const result = parseAgentModManifest(
      baseManifest({
        contributes: { tools: [{ name: 'probe_tool' }, { name: 'probe_tool' }] },
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]?.code).toBe('mod.duplicate-contribution')
  })

  test('requiredAxes 必须是自己实际贡献的轴', () => {
    const result = parseAgentModManifest(
      baseManifest({ requiredAxes: ['spaces'], contributes: {} })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]?.code).toBe('mod.required-axis-not-contributed')
  })

  test('declaredAxes 只列出真有条目的轴', () => {
    const result = parseAgentModManifest(
      baseManifest({
        contributes: {
          tools: [{ name: 'probe_tool' }],
          skills: [],
        },
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(listAgentModDeclaredAxes(result.manifest)).toEqual(['tools'])
  })
})

describe('契约常量', () => {
  test('贡献轴是封闭集合，pack 接缝常量稳定', () => {
    expect(AgentModContributionAxisNames).toEqual([
      'tools',
      'toolCategories',
      'promptSegments',
      'skills',
      'spaces',
      'subAgentTypes',
      'turnContextSources',
      'executionModes',
      'hooks',
    ])
    expect(AgentModPackManifestFileName).toBe('velaros.agent.mod.json')
    expect(AgentModPackProvidesId).toBe('velaros.agent')
  })
})
