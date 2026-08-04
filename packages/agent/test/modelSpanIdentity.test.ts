import { describe, expect, test } from 'bun:test'

import {
  beginLoopTurnSpans,
  endLoopTurnSpansOk,
} from '../src/agent/AgentLoop'
import type { RunSpanScope, TurnSpanScope } from '../src/kernel/observability'

describe('model span identity', () => {
  test('keeps the selected tier on the turn and records the concrete provider model on the request', () => {
    const observed: {
      turnModel: string | null
      requestModel: string | null
    } = { turnModel: null, requestModel: null }
    const turnScope: TurnSpanScope = {
      beginModelSpan: (input) => {
        observed.requestModel = input.model
        return { end: () => undefined }
      },
      beginToolSpan: () => null,
      recordPolicySpan: () => undefined,
      recordCapabilitySpan: () => undefined,
      recordPromptAudit: () => undefined,
      end: () => undefined,
    }
    const runScope: RunSpanScope = {
      beginTurn: (input) => {
        observed.turnModel = input.model
        return turnScope
      },
      end: () => undefined,
    }

    const spans = beginLoopTurnSpans(runScope, {
      turn: 1,
      roleId: 'primary-agent',
      provider: 'airjelly',
      model: 'auto',
      providerModel: 'deepseek/deepseek-v4-pro',
    })
    endLoopTurnSpansOk(
      spans,
      { inputTokens: 10, outputTokens: 2, finishReason: 'stop' },
      { systemPrompt: '', promptSegments: [], skippedPromptSegments: [] }
    )

    expect(observed).toEqual({
      turnModel: 'auto',
      requestModel: 'deepseek/deepseek-v4-pro',
    })
  })
})
