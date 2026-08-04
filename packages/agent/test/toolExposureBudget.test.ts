import { describe, expect, test } from 'bun:test'

import {
  applyRunProfileToolExposure,
  resolveRunProfileWorkingSetContextWindow,
  RunProfileDefinitions,
} from '../src/agent/RunProfile'

describe('tool exposure cognitive budget', () => {
  test('keeps every runtime profile bounded independently from model context size', () => {
    expect(RunProfileDefinitions.compact.budget).toMatchObject({
      maxToolCount: 32,
      maxInputWorkingSetTokens: 48_000,
      maxToolSchemaChars: 48_000,
    })
    expect(RunProfileDefinitions.balanced.budget).toMatchObject({
      maxToolCount: 64,
      maxInputWorkingSetTokens: 96_000,
      maxToolSchemaChars: 96_000,
    })
    expect(RunProfileDefinitions.expanded.budget).toMatchObject({
      maxToolCount: 128,
      maxInputWorkingSetTokens: 192_000,
      maxToolSchemaChars: 192_000,
    })
  })

  test('caps a large physical context window by the selected working-set profile', () => {
    expect(resolveRunProfileWorkingSetContextWindow({
      physicalContextWindow: 1_048_576,
      profile: 'compact',
    })).toBe(48_000)
    expect(resolveRunProfileWorkingSetContextWindow({
      physicalContextWindow: 1_048_576,
      profile: 'balanced',
    })).toBe(96_000)
    expect(resolveRunProfileWorkingSetContextWindow({
      physicalContextWindow: 1_048_576,
      profile: 'expanded',
    })).toBe(192_000)
    expect(resolveRunProfileWorkingSetContextWindow({
      physicalContextWindow: 32_000,
      profile: 'compact',
    })).toBe(32_000)
  })

  test('keeps an explicitly paged-in tool while evicting unrelated schema weight', () => {
    const toolNames = ['probe:one', 'probe:two', 'probe:three', 'probe:paged-in']
    const result = applyRunProfileToolExposure(toolNames, 'compact', {
      protectedTools: ['probe:paged-in'],
      toolSchemaChars: Object.fromEntries(toolNames.map((name) => [name, 20_000])),
      maxToolSchemaCharsOverride: 1_000_000,
    })

    expect(result.allowedTools).toHaveLength(2)
    expect(result.allowedTools).toContain('probe:paged-in')
    expect(result.droppedTools).toHaveLength(2)
  })

  test('pins protected control tools while keeping the total tool count bounded', () => {
    const toolNames = Array.from({ length: 60 }, (_, index) => `probe:tool-${index}`)
    const protectedTool = toolNames.at(-1)!
    const result = applyRunProfileToolExposure(toolNames, 'compact', {
      protectedTools: [protectedTool],
      toolSchemaChars: Object.fromEntries(toolNames.map((name) => [name, 100])),
    })

    expect(result.allowedTools).toHaveLength(37)
    expect(result.allowedTools).toContain(protectedTool)
    expect(result.droppedTools).not.toContain(protectedTool)
  })

  test('enforces the expanded schema budget instead of treating large context as unbounded', () => {
    const toolNames = Array.from({ length: 140 }, (_, index) => `probe:expanded-${index}`)
    const result = applyRunProfileToolExposure(toolNames, 'expanded', {
      toolSchemaChars: Object.fromEntries(toolNames.map((name) => [name, 2_000])),
    })

    expect(result.allowedTools).toHaveLength(96)
    expect(result.droppedTools).toHaveLength(44)
  })
})
