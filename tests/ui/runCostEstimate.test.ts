import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  describeRunCostEstimate,
  estimateRunCost,
  estimateSessionCost,
  formatRunCostEstimateLabel,
} from '../../packages/ui/src/conversation/blocks/messageCostEstimate'
import {
  addConversationRunSubAgentUsage,
  addConversationRunTranscriptSubAgentUsage,
  addConversationRunUsageTelemetry,
  createConversationRunUsage,
} from '../../packages/ui/src/conversation/blocks/runUsage'
import type {
  ChatMessage,
  ModelPricingCatalog,
  StreamUsageTelemetryPayload,
} from '../../packages/ui/src/conversation/contracts'
import type {
  ConversationMessageRunMarker,
  ConversationRunUsage,
} from '../../packages/ui/src/conversation/projection'
import {
  buildRunCostEstimates,
  reuseStableRunCostEstimates,
} from '../../packages/ui/src/conversation/shell/runCostEstimates'

type ToolCallBlock = Extract<ChatMessage['blocks'][number], { type: 'tool-call' }>

/** 目录只按别名收录（与公开目录 `openai/<id>` + 别名 `<id>` 同形），服务商是没有前缀映射的中转网关。 */
function createCatalog(
  overrides: Partial<ModelPricingCatalog['entries'][number]> = {}
): ModelPricingCatalog {
  return {
    currency: 'USD',
    version: 'test',
    updatedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    entries: [
      {
        provider: 'openai',
        model: 'openai/gpt-5.6-sol',
        aliases: ['gpt-5.6-sol'],
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 10,
        source: 'test',
        ...overrides,
      },
    ],
  }
}

const GatewayBilling = { provider: 'openai-compatible-gateway', model: 'gpt-5.6-sol' }

function telemetry(
  overrides: Partial<StreamUsageTelemetryPayload> = {}
): StreamUsageTelemetryPayload {
  return {
    kind: 'usage-telemetry',
    turn: 1,
    model: 'gpt-5.6-sol',
    inputTokens: 100_000,
    outputTokens: 2_000,
    totalTokens: 102_000,
    reasoningTokens: null,
    source: 'provider',
    confidence: 'high',
    timestamp: 1_000,
    ...overrides,
  }
}

function subAgentResult(result: Record<string, unknown>): string {
  return `子 agent 结论\n\n<subagent-result type="application/json">\n${JSON.stringify(result)}\n</subagent-result>`
}

function toolCall(toolName: string, result: unknown, id: string): ToolCallBlock {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName,
    args: {},
    result,
    isRunning: false,
  } as ToolCallBlock
}

function userMessage(id: string, timestamp: number, text = '继续'): ChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp } as ChatMessage
}

function assistantMessage(
  id: string,
  timestamp: number,
  blocks: ChatMessage['blocks'] = [{ type: 'text', text: '完成。' }]
): ChatMessage {
  return { id, role: 'assistant', blocks, timestamp } as ChatMessage
}

function completedMarker(
  messageId: string,
  overrides: Partial<ConversationMessageRunMarker> = {}
): ConversationMessageRunMarker {
  return {
    messageId,
    status: 'completed',
    detail: null,
    turnCount: 1,
    turnKind: 'totalTurns',
    timestamp: 10_000,
    ...overrides,
  }
}

function sumUsage(entries: StreamUsageTelemetryPayload[]): ConversationRunUsage {
  return entries.reduce(addConversationRunUsageTelemetry, createConversationRunUsage())
}

void describe('run usage accounting', () => {
  void test('bills reasoning as output and splits cached input out of the total', () => {
    const usage = sumUsage([
      telemetry({
        inputTokens: 300_000,
        outputTokens: 5_000,
        visibleOutputTokens: 1_000,
        reasoningTokens: 4_000,
        cachedInputTokens: 250_000,
      }),
      telemetry({ turn: 2, inputTokens: 310_000, outputTokens: 1_000, cacheReadInputTokens: 300_000 }),
    ])

    assert.equal(usage.buckets.length, 1)
    assert.deepEqual(
      {
        calls: usage.buckets[0]?.calls,
        inputTokens: usage.buckets[0]?.inputTokens,
        cacheReadInputTokens: usage.buckets[0]?.cacheReadInputTokens,
        outputTokens: usage.buckets[0]?.outputTokens,
        reasoningTokens: usage.buckets[0]?.reasoningTokens,
      },
      {
        calls: 2,
        inputTokens: 610_000,
        cacheReadInputTokens: 550_000,
        outputTokens: 6_000,
        reasoningTokens: 4_000,
      }
    )
  })

  void test('keeps gateway-reported costs apart from catalog-priced calls and skips empty reports', () => {
    const usage = sumUsage([
      telemetry({ costUsd: 0.5, source: 'gateway-cost' }),
      telemetry({ turn: 2 }),
      telemetry({ turn: 3, inputTokens: null, outputTokens: null, totalTokens: null }),
    ])

    assert.deepEqual(
      usage.buckets.map((bucket) => [bucket.pricing, bucket.calls, bucket.reportedCostUsd]),
      [
        ['reported', 1, 0.5],
        ['catalog', 1, 0],
      ]
    )
  })

  void test('counts sub-agent runs that reported no usage', () => {
    const usage = addConversationRunSubAgentUsage(createConversationRunUsage(), {
      model: 'gpt-5.6-sol',
      usage: null,
    })

    assert.equal(usage.unreportedSubAgentRuns, 1)
    assert.equal(usage.buckets.length, 0)
  })
})

void describe('run cost estimate', () => {
  void test('prices a long agent run plus its sub-agents instead of the visible answer text', () => {
    // 115 轮、上下文从 50K 线性涨到 360K 的主 Agent，外加 5 个同模型的子 Agent。
    const turns = Array.from({ length: 115 }, (_, index) =>
      telemetry({
        turn: index + 1,
        inputTokens: 50_000 + index * 2_700,
        outputTokens: 900,
        reasoningTokens: 600,
        timestamp: 1_000 + index,
      })
    )
    let usage = sumUsage(turns)
    for (const [input, output] of [
      [200_000, 4_000],
      [1_100_000, 13_000],
      [980_000, 12_000],
      [760_000, 22_000],
      [950_000, 19_000],
    ] as const) {
      usage = addConversationRunSubAgentUsage(usage, {
        provider: 'openai-compatible-gateway',
        model: 'gpt-5.6-sol',
        usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
      })
    }

    const estimate = estimateRunCost({
      usage,
      ...GatewayBilling,
      pricingCatalog: createCatalog(),
      expectedAgentCalls: 115,
    })

    const agentInput = turns.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0)
    const subAgentInput = 200_000 + 1_100_000 + 980_000 + 760_000 + 950_000
    const subAgentOutput = 4_000 + 13_000 + 12_000 + 22_000 + 19_000
    const expectedUsd =
      ((agentInput + subAgentInput) * 2 + (115 * 900 + subAgentOutput) * 10) / 1_000_000

    assert.ok(estimate)
    assert.equal(estimate.agentCalls, 115)
    assert.equal(estimate.subAgentRuns, 5)
    assert.equal(estimate.coverage, 'complete')
    assert.equal(estimate.reasoningTokens, 115 * 600)
    assert.ok(Math.abs(estimate.usd - expectedUsd) < 1e-9)
    assert.ok(estimate.usd > 50, `whole-run estimate should be tens of dollars, got ${estimate.usd}`)
  })

  void test('prices cache reads at the catalog cache rate when the price list carries one', () => {
    const usage = sumUsage([telemetry({ inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 900_000 })])
    const estimate = estimateRunCost({
      usage,
      ...GatewayBilling,
      pricingCatalog: createCatalog({ cacheReadUsdPerMillion: 0.2 }),
    })

    assert.ok(estimate)
    assert.ok(Math.abs(estimate.usd - (0.1 * 2 + 0.9 * 0.2)) < 1e-9)
    assert.equal(estimate.cachedInputPricedAtInputRate, false)
  })

  void test('prices cache reads at the input rate and says so when the price list has no cache price', () => {
    const usage = sumUsage([telemetry({ inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 900_000 })])
    const estimate = estimateRunCost({ usage, ...GatewayBilling, pricingCatalog: createCatalog() })

    assert.ok(estimate)
    assert.ok(Math.abs(estimate.usd - 2) < 1e-9)
    assert.equal(estimate.cachedInputPricedAtInputRate, true)
    assert.match(describeRunCostEstimate('en-US', estimate), /full input rate/u)
  })

  void test('is unknown when the main agent reported no usage, even if sub-agents did', () => {
    const usage = addConversationRunSubAgentUsage(createConversationRunUsage(), {
      model: 'gpt-5.6-sol',
      usage: { inputTokens: 900_000, outputTokens: 10_000 },
    })

    assert.equal(
      estimateRunCost({ usage, ...GatewayBilling, pricingCatalog: createCatalog(), expectedAgentCalls: 115 }),
      null
    )
  })

  void test('is unknown when the main model has no catalog price instead of showing a tiny amount', () => {
    assert.equal(
      estimateRunCost({
        usage: sumUsage([telemetry({ model: 'unlisted-model' })]),
        provider: 'openai-compatible-gateway',
        model: 'unlisted-model',
        pricingCatalog: createCatalog(),
      }),
      null
    )
  })

  void test('marks the amount as a lower bound when turns or sub-agents are missing usage', () => {
    const missingTurns = estimateRunCost({
      usage: sumUsage([telemetry()]),
      ...GatewayBilling,
      pricingCatalog: createCatalog(),
      expectedAgentCalls: 3,
    })
    const unreportedSubAgent = estimateRunCost({
      usage: addConversationRunSubAgentUsage(sumUsage([telemetry()]), {}),
      ...GatewayBilling,
      pricingCatalog: createCatalog(),
      expectedAgentCalls: 1,
    })

    assert.equal(missingTurns?.coverage, 'partial')
    assert.equal(unreportedSubAgent?.coverage, 'partial')
    assert.ok(missingTurns)
    assert.match(formatRunCostEstimateLabel('en-US', missingTurns), /^≥\$/u)
  })

  void test('uses gateway-reported costs as-is', () => {
    const estimate = estimateRunCost({
      usage: sumUsage([telemetry({ costUsd: 1.25 }), telemetry({ turn: 2, costUsd: 0.75 })]),
      provider: 'velar',
      model: 'velar/auto',
      pricingCatalog: null,
    })

    assert.equal(estimate?.usd, 2)
    assert.equal(estimate?.coverage, 'complete')
  })
})

void describe('session telemetry cost', () => {
  void test('bills reasoning tokens as output instead of only the visible part', () => {
    const estimate = estimateSessionCost({
      ...GatewayBilling,
      messages: [],
      pricingCatalog: createCatalog(),
      usageTelemetry: [
        telemetry({ inputTokens: 0, outputTokens: 10_000, visibleOutputTokens: 1_000, reasoningTokens: 9_000 }),
      ],
    })

    assert.ok(estimate)
    assert.equal(estimate.outputTokens, 10_000)
    assert.ok(Math.abs(estimate.usd - 0.1) < 1e-9)
  })
})

void describe('transcript run cost estimates', () => {
  const pricingCatalog = createCatalog()

  void test('attributes telemetry to the run it happened in and adds sub-agent results from the transcript', () => {
    const syncDispatch = toolCall(
      'agent:dispatch',
      subAgentResult({
        thread_id: 'subagent:a',
        status: 'completed',
        summary: 'done',
        usage: { inputTokens: 500_000, outputTokens: 5_000, totalTokens: 505_000 },
        model_trace: { providerId: 'openai-compatible-gateway', model: 'gpt-5.6-sol' },
      }),
      'dispatch-a'
    )
    const messages = [
      userMessage('u1', 100),
      assistantMessage('a1', 200),
      userMessage('u2', 5_000),
      assistantMessage('a2', 5_100, [syncDispatch, { type: 'text', text: '完成。' }]),
    ]
    const markers = new Map([
      ['a1', completedMarker('a1', { startedAt: 100, timestamp: 4_000, turnCount: 1 })],
      ['a2', completedMarker('a2', { startedAt: 5_000, timestamp: 9_000, turnCount: 2 })],
    ])
    const estimates = buildRunCostEstimates({
      messages,
      messageRunMarkerMap: markers,
      usageTelemetry: [
        telemetry({ turn: 1, timestamp: 1_000, inputTokens: 10_000, outputTokens: 100 }),
        telemetry({ turn: 1, timestamp: 6_000, inputTokens: 100_000, outputTokens: 1_000 }),
        telemetry({ turn: 2, timestamp: 7_000, inputTokens: 120_000, outputTokens: 1_000 }),
      ],
      billingModel: GatewayBilling,
      pricingCatalog,
    })

    assert.equal(estimates.get('a1')?.agentCalls, 1)
    assert.equal(estimates.get('a1')?.inputTokens, 10_000)
    assert.equal(estimates.get('a2')?.agentCalls, 2)
    assert.equal(estimates.get('a2')?.subAgentRuns, 1)
    assert.equal(estimates.get('a2')?.inputTokens, 100_000 + 120_000 + 500_000)
    assert.equal(estimates.get('a2')?.coverage, 'complete')
  })

  void test('bounds a legacy marker without startedAt by the previous run and its own turn input', () => {
    const messages = [
      userMessage('u1', 100),
      assistantMessage('a1', 200),
      userMessage('u2', 5_000),
      assistantMessage('a2', 5_100),
    ]
    const estimates = buildRunCostEstimates({
      messages,
      messageRunMarkerMap: new Map([
        ['a1', completedMarker('a1', { timestamp: 4_000 })],
        ['a2', completedMarker('a2', { timestamp: 9_000 })],
      ]),
      usageTelemetry: [
        telemetry({ timestamp: 1_000, inputTokens: 10_000 }),
        telemetry({ timestamp: 6_000, inputTokens: 20_000 }),
      ],
      billingModel: GatewayBilling,
      pricingCatalog,
    })

    assert.equal(estimates.get('a1')?.inputTokens, 10_000)
    assert.equal(estimates.get('a2')?.inputTokens, 20_000)
  })

  void test('prefers the host run ledger on the marker over session telemetry', () => {
    const ledger = sumUsage([telemetry({ inputTokens: 42_000, outputTokens: 0, timestamp: 0 })])
    const estimates = buildRunCostEstimates({
      messages: [userMessage('u1', 100), assistantMessage('a1', 200)],
      messageRunMarkerMap: new Map([
        ['a1', completedMarker('a1', { startedAt: 100, timestamp: 4_000, usage: ledger })],
      ]),
      usageTelemetry: [telemetry({ timestamp: 1_000, inputTokens: 999_999 })],
      billingModel: GatewayBilling,
      pricingCatalog,
    })

    assert.equal(estimates.get('a1')?.inputTokens, 42_000)
  })

  void test('falls back to session telemetry when a restored marker ledger is malformed', () => {
    const malformedLedger = { buckets: null } as unknown as ConversationRunUsage
    const estimates = buildRunCostEstimates({
      messages: [userMessage('u1', 100), assistantMessage('a1', 200)],
      messageRunMarkerMap: new Map([
        ['a1', completedMarker('a1', { startedAt: 100, timestamp: 4_000, usage: malformedLedger })],
      ]),
      usageTelemetry: [telemetry({ timestamp: 1_000, inputTokens: 7_000 })],
      billingModel: GatewayBilling,
      pricingCatalog,
    })

    assert.equal(estimates.get('a1')?.inputTokens, 7_000)
  })

  void test('shows no amount when the host supplies no usage for the run', () => {
    const estimates = buildRunCostEstimates({
      messages: [userMessage('u1', 100), assistantMessage('a1', 200)],
      messageRunMarkerMap: new Map([
        ['a1', completedMarker('a1', { startedAt: 100, timestamp: 4_000, turnCount: 115 })],
      ]),
      usageTelemetry: [],
      billingModel: GatewayBilling,
      pricingCatalog,
    })

    assert.equal(estimates.size, 0)
  })

  void test('does not estimate when the host opted out of billing', () => {
    const estimates = buildRunCostEstimates({
      messages: [userMessage('u1', 100), assistantMessage('a1', 200)],
      messageRunMarkerMap: new Map([['a1', completedMarker('a1', { startedAt: 100 })]]),
      usageTelemetry: [telemetry({ timestamp: 1_000 })],
      billingModel: null,
      pricingCatalog,
    })

    assert.equal(estimates.size, 0)
  })

  void test('reuses estimate objects whose numbers did not change', () => {
    const input = {
      messages: [userMessage('u1', 100), assistantMessage('a1', 200)],
      messageRunMarkerMap: new Map([['a1', completedMarker('a1', { startedAt: 100 })]]),
      usageTelemetry: [telemetry({ timestamp: 1_000 })],
      billingModel: GatewayBilling,
      pricingCatalog,
    }
    const first = buildRunCostEstimates(input)
    const second = reuseStableRunCostEstimates(first, buildRunCostEstimates(input))

    assert.equal(second.get('a1'), first.get('a1'))
  })
})

void describe('transcript sub-agent usage', () => {
  void test('reads an async dispatch once its final result is read back and de-duplicates repeats', () => {
    const running = toolCall(
      'agent:dispatch',
      subAgentResult({ thread_id: 'subagent:b', status: 'running', summary: 'started' }),
      'dispatch-b'
    )
    const finalResult = subAgentResult({
      thread_id: 'subagent:b',
      status: 'completed',
      summary: 'done',
      usage: { inputTokens: 300_000, outputTokens: 3_000 },
    })
    const usage = addConversationRunTranscriptSubAgentUsage(createConversationRunUsage(), [
      assistantMessage('a1', 1, [
        running,
        toolCall('job:wait', `job finished\n${finalResult}`, 'wait-b'),
        toolCall('job:read_output', finalResult, 'read-b'),
      ]),
    ])

    assert.equal(usage.unreportedSubAgentRuns, 0)
    assert.equal(usage.buckets.length, 1)
    assert.equal(usage.buckets[0]?.calls, 1)
    assert.equal(usage.buckets[0]?.inputTokens, 300_000)
  })

  void test('counts an async dispatch whose result was never read back as unreported', () => {
    const usage = addConversationRunTranscriptSubAgentUsage(createConversationRunUsage(), [
      assistantMessage('a1', 1, [
        toolCall(
          'agent:dispatch',
          subAgentResult({ thread_id: 'subagent:c', status: 'running', summary: 'started' }),
          'dispatch-c'
        ),
        toolCall(
          'agent:dispatch',
          subAgentResult({ thread_id: 'subagent:d', status: 'failed', summary: 'skipped' }),
          'dispatch-d'
        ),
      ]),
    ])

    assert.equal(usage.unreportedSubAgentRuns, 1)
    assert.equal(usage.buckets.length, 0)
  })
})
