import { describe, expect, test } from 'bun:test'

import {
  parseVelarosModEnvelope,
  VelarosModManifestFileName,
} from '../../src/contracts/protocol'

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
    expect(result.envelope.module.provides).toEqual([
      { id: 'probe.capability', version: '1.0.0' },
    ])
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
