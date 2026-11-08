import { describe, expect, test } from 'bun:test'

import {
  parseVelarosModEnvelope,
  VelarosModManifestFileName,
} from '../../src/utils/wire/mod-envelope'

function baseModuleSection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'probe.mod',
    version: '1.0.0',
    apiVersion: 1,
    provides: ['probe.capability'],
    ...overrides,
  }
}

describe('single Mod manifest envelope', () => {
  test('capability versions share strict module SemVer validation', () => {
    for (const version of [
      'v1.0.0',
      '01.0.0',
      '1.0.0-01',
      '1.0.0-alpha..1',
      '9007199254740992.0.0',
      ' 1.0.0',
    ]) {
      const result = parseVelarosModEnvelope({
        module: baseModuleSection({ provides: [{ id: 'probe.capability', version }] }),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.diagnostics[0]?.path).toBe('module.provides.0.version')
    }
    expect(
      parseVelarosModEnvelope({
        module: baseModuleSection({
          provides: [{ id: 'probe.capability', version: '1.0.0-rc.1+build.01' }],
        }),
      }).ok
    ).toBe(true)
  })

  test('validates all explicit requirement ranges while preserving author shorthand', () => {
    for (const field of ['requires', 'optionalRequires']) {
      for (const versionRange of ['', 'x', '* || nonsense', '<0.0.0 nonsense']) {
        const result = parseVelarosModEnvelope({
          module: baseModuleSection({ [field]: [{ id: 'other.capability', versionRange }] }),
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.diagnostics[0]?.path).toBe(`module.${field}.0.versionRange`)
      }
    }
    const shorthand = parseVelarosModEnvelope({
      module: baseModuleSection({
        provides: 'probe.capability',
        requires: 'other.capability',
        optionalRequires: [{ id: 'optional.capability', versionRange: '^1.0.0 || >=2.0.0 <3.0.0' }],
      }),
    })
    expect(shorthand.ok).toBe(true)
    if (!shorthand.ok) return
    expect(shorthand.envelope.module.provides).toEqual([
      { id: 'probe.capability', version: '1.0.0' },
    ])
    expect(shorthand.envelope.module.requires).toEqual([{ id: 'other.capability' }])
  })

  test('validates module once and leaves domain sections opaque', () => {
    const agentSection = { id: 'probe.mod', contributes: { skills: [] } }
    const uiSection = { pages: [{ id: 'p1', kind: 'host-owned' }] }
    const result = parseVelarosModEnvelope({
      module: baseModuleSection(),
      agent: agentSection,
      ui: uiSection,
    })

    expect(VelarosModManifestFileName).toBe('velaros.mod.json')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.envelope.module.provides).toEqual([{ id: 'probe.capability', version: '1.0.0' }])
    expect(result.envelope.module.isolation).toBe('in-process')
    expect(result.envelope.agent).toBe(agentSection)
    expect(result.envelope.ui).toBe(uiSection)
  })

  test('allows an envelope without Agent or UI contributions', () => {
    const result = parseVelarosModEnvelope({ module: baseModuleSection() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.envelope.agent).toBeUndefined()
    expect(result.envelope.ui).toBeUndefined()
  })

  test('rejects unknown sections and missing module identity', () => {
    expect(parseVelarosModEnvelope({ module: baseModuleSection(), shell: {} }).ok).toBe(false)
    const noModule = parseVelarosModEnvelope({ agent: {} })
    expect(noModule.ok).toBe(false)
    if (noModule.ok) return
    expect(noModule.diagnostics[0]?.code).toBe('mod.envelope-invalid')
  })

  test('rejects cross-section identity mismatch', () => {
    const result = parseVelarosModEnvelope({
      module: baseModuleSection({ id: 'module.owner' }),
      agent: { id: 'agent.owner' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]?.code).toBe('mod.envelope-id-mismatch')
  })
})
