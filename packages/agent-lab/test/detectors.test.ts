import { describe, expect, test } from 'bun:test'

import type {
  DetectorContext,
  LoopThresholds,
  Observation,
  ToolCallRecord,
  TranscriptBlock,
} from '../src/index.js'
import { createDetectorRegistry, DefaultLoopThresholds } from '../src/index.js'
import { createBuiltinDetectors } from '../src/utils/measure/detectors.js'

/** 宿主给的两份工具名单：本包核心里不写任何产品的工具名，测试自己提供。 */
const HostToolNames = {
  catalogToolNames: ['tooling:map'],
  interactiveToolNames: ['interaction:ask_user'],
}

function builtins(thresholds: Partial<LoopThresholds> = {}) {
  return createBuiltinDetectors({
    thresholds: { ...DefaultLoopThresholds, ...thresholds },
    ...HostToolNames,
  })
}

import { journey, observation, trial } from '../spec/support.js'

const context: DetectorContext = {
  trial: trial(),
  journey: journey(),
  leg: null,
}

function call(id: string, name: string, input: ToolCallRecord['input']): ToolCallRecord {
  return {
    id,
    turnId: 'turn-1',
    name,
    input,
    result: null,
    isError: null,
    startedAt: null,
    finishedAt: null,
  }
}

function withCalls(calls: readonly ToolCallRecord[]): Observation {
  return {
    ...observation(),
    turns: [{ id: 'turn-1', index: 1, toolCalls: calls, finishReasons: [] }],
  }
}

function block(id: string, kind: TranscriptBlock['kind'], text: string | null): TranscriptBlock {
  return {
    id,
    messageId: 'message-1',
    role: 'assistant',
    kind,
    text,
    toolCallId: null,
    toolName: null,
    toolInput: null,
    toolResult: null,
    isError: null,
    isRunning: null,
    isStreaming: null,
  }
}

describe('built-in detectors', () => {
  test('keeps the host-neutral detector catalog explicit', () => {
    expect(builtins().map((item) => item.definition.id)).toEqual([
      'stuck-streaming-block',
      'stuck-running-tool',
      'orphan-tool-call',
      'placeholder-leak',
      'protocol-leak',
      'empty-final-answer',
      'context-estimate-sanity',
      'finish-truncation',
      'finish-unknown',
      'tool-failure',
      'tool-retry-loop',
      'toolmap-read-loop',
      'turn-tool-density',
    ])
  })

  test('rejects duplicate builtins without changing detector or watchdog settings', () => {
    const registry = createDetectorRegistry()
    registry.registerBuiltins({
      thresholds: {
        retryWarn: 2,
        retryAbort: 3,
        toolMapReadWarn: 2,
        toolMapReadAbort: 3,
      },
      ...HostToolNames,
    })
    const registered = registry.list()
    expect(() =>
      registry.registerBuiltins({
        thresholds: { retryWarn: 1, retryAbort: 1, toolMapReadWarn: 1, toolMapReadAbort: 1 },
        catalogToolNames: ['other:catalog'],
        interactiveToolNames: [],
      })
    ).toThrow('stuck-streaming-block')
    expect(registry.list()).toEqual(registered)
    for (const detector of registered) expect(registry.get(detector.definition.id)).toBe(detector)

    const calls = Array.from({ length: 3 }, (_, index) =>
      call(`catalog-${index}`, HostToolNames.catalogToolNames[0]!, { op: 'read', ids: ['write'] })
    )
    const active = new Set(['tool-retry-loop', 'toolmap-read-loop'])
    const baseline = registry.watchdogBaseline(withCalls([]), [], active)
    const current = withCalls(calls.slice(0, 2))
    const findings = registry.detect(current, context)
    expect(
      findings
        .filter((finding) => active.has(finding.detectorId))
        .map((finding) => ({
          detectorId: finding.detectorId,
          abortAt: finding.evidence.abortAt,
        }))
    ).toEqual([
      { detectorId: 'tool-retry-loop', abortAt: 3 },
      { detectorId: 'toolmap-read-loop', abortAt: 3 },
    ])
    expect(registry.watchdogAbort(current, findings, baseline, active)).toBeNull()
    const reached = withCalls(calls)
    expect(
      registry.watchdogAbort(
        reached,
        registry.detect(reached, context),
        baseline,
        new Set(['toolmap-read-loop'])
      )?.detectorId
    ).toBe('toolmap-read-loop')
  })

  test('preflights a later custom detector conflict before registering any builtin', () => {
    const registry = createDetectorRegistry()
    const custom = {
      definition: {
        ...builtins().find((item) => item.definition.id === 'turn-tool-density')!.definition,
      },
      detect: () => [],
    }
    registry.register(custom)
    expect(() => registry.registerBuiltins()).toThrow(custom.definition.id)
    expect(registry.list()).toEqual([custom])
    expect(registry.get(custom.definition.id)).toBe(custom)
    expect(registry.get('stuck-streaming-block')).toBeNull()
    expect(registry.get('tool-retry-loop')).toBeNull()
  })

  test('preserves calibrated loop boundaries and ignores unknown empty arguments', () => {
    const detectors = builtins({
      retryWarn: 2,
      retryAbort: 3,
      toolMapReadWarn: 2,
      toolMapReadAbort: 3,
      turnDensityWarn: 1,
      turnDensityAbort: 3,
    })
    const detect = (id: string, input: Observation) =>
      detectors.find((item) => item.definition.id === id)!.detect(input, context)

    expect(
      detect(
        'tool-retry-loop',
        withCalls([call('a', 'project:read', {}), call('b', 'project:read', {})])
      )
    ).toEqual([])
    expect(
      detect(
        'toolmap-read-loop',
        withCalls([
          call('a', 'tooling:map', { op: 'find', query: 'write' }),
          call('b', 'tooling:map', { op: 'find', query: 'write' }),
        ])
      )
    ).toEqual([])
    expect(
      detect(
        'toolmap-read-loop',
        withCalls([
          call('a', 'tooling:map', { op: 'read', ids: ['tool:write'] }),
          call('b', 'tooling:map', { op: 'read', ids: ['tool:write'] }),
        ])
      ).map((finding) => finding.detectorId)
    ).toEqual(['toolmap-read-loop'])
    expect(
      detect('turn-tool-density', withCalls([call('a', 'project:read', { path: 'a' })]))
    ).toEqual([])
    expect(
      detect(
        'turn-tool-density',
        withCalls([
          call('a', 'project:read', { path: 'a' }),
          call('b', 'project:read', { path: 'b' }),
        ])
      ).map((finding) => finding.detectorId)
    ).toEqual(['turn-tool-density'])
  })

  test('does not report protocol text or an empty answer when the same message has a real artifact', () => {
    const source = `${'x'.repeat(900)}</artifact>`
    const input: Observation = {
      ...observation(),
      transcript: [block('text', 'text', source), block('artifact', 'artifact', null)],
    }
    const detectors = builtins()
    for (const id of ['protocol-leak', 'empty-final-answer']) {
      expect(detectors.find((item) => item.definition.id === id)!.detect(input, context)).toEqual(
        []
      )
    }
  })

  test('references the actual retry episode that reached the reported maximum', () => {
    const detector = builtins({ retryWarn: 2 }).find(
      (item) => item.definition.id === 'tool-retry-loop'
    )!
    const long = Array.from({ length: 3 }, (_, index) =>
      call(`long-${index}`, 'read', { path: '/a' })
    )
    const input = withCalls([
      ...long,
      call('separator', 'write', { path: '/b' }),
      call('short', 'read', { path: '/a' }),
    ])
    const findings = detector.detect(input, context)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.evidence.count).toBe(3)
    expect(findings[0]?.references[0]?.id).toBe('long-2')
  })
})
