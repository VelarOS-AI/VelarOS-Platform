import { describe, expect, test } from 'bun:test'

import {
  beginLoopTurnSpans,
  endLoopTurnSpansError,
  endLoopTurnSpansOk,
  restartLoopTurnModelSpanAfterRetry,
} from '../src/agent/AgentLoop'
import type {
  ModelSpanOutcome,
  RunSpanScope,
  TurnSpanScope,
} from '../src/kernel/observability'

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
      provider: 'test-provider',
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

  test('records a safe structured provider failure on the model request span', () => {
    let outcome: ModelSpanOutcome | null = null
    const turnScope: TurnSpanScope = {
      beginModelSpan: () => ({ end: (value) => { outcome = value } }),
      beginToolSpan: () => null,
      recordPolicySpan: () => undefined,
      recordCapabilitySpan: () => undefined,
      recordPromptAudit: () => undefined,
      end: () => undefined,
    }
    const runScope: RunSpanScope = {
      beginTurn: () => turnScope,
      end: () => undefined,
    }
    const spans = beginLoopTurnSpans(runScope, {
      turn: 1,
      roleId: 'primary-agent',
      provider: 'test-provider',
      model: 'auto',
      providerModel: 'deepseek/deepseek-v4-pro',
    })

    endLoopTurnSpansError(spans, {
      code: 'QUOTA_EXCEEDED',
      message: '模型服务额度已用尽，请补充额度或切换服务商后重试。',
    })

    expect(outcome).toMatchObject({
      status: 'error',
      errorCode: 'QUOTA_EXCEEDED',
      errorMessage: '模型服务额度已用尽，请补充额度或切换服务商后重试。',
    })
  })

  test('records a recovered provider retry as a failed request before the successful attempt', () => {
    const outcomes: ModelSpanOutcome[] = []
    let opened = 0
    const turnScope: TurnSpanScope = {
      beginModelSpan: () => {
        opened += 1
        return { end: (value) => outcomes.push(value) }
      },
      beginToolSpan: () => null,
      recordPolicySpan: () => undefined,
      recordCapabilitySpan: () => undefined,
      recordPromptAudit: () => undefined,
      end: () => undefined,
    }
    const runScope: RunSpanScope = {
      beginTurn: () => turnScope,
      end: () => undefined,
    }
    const spans = beginLoopTurnSpans(runScope, {
      turn: 1,
      roleId: 'primary-agent',
      provider: 'airjelly',
      model: 'lite',
      providerModel: 'lite',
    })

    restartLoopTurnModelSpanAfterRetry(spans, {
      code: 'MODEL_STREAM_STALLED',
      message: '模型流停止前进',
    })
    endLoopTurnSpansOk(
      spans,
      { inputTokens: 20, outputTokens: 4, finishReason: 'stop' },
      { systemPrompt: '', promptSegments: [], skippedPromptSegments: [] }
    )

    expect(opened).toBe(2)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toMatchObject({
      status: 'error',
      errorCode: 'MODEL_STREAM_STALLED',
    })
    expect(outcomes[1]).toMatchObject({
      status: 'ok',
      tokensIn: 20,
      tokensOut: 4,
    })
  })
})
