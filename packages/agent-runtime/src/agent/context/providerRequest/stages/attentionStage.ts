/**
 * Ring 1 stage ②——attention（ContextAttentionRouter 整器官平移成 stage）。
 *
 * 消费已注入的 ContextAttentionSessionRegistry：跨回合粘滞路由（previousActions）、outcome 回学
 * （blockOutcomes）全保留；replay 落盘由编译器在出核地板校验后统一落。默认 active（全能力），
 * mode 仅测试 / 回放评测显式覆盖。校准常数与回学阈值住在 router 本体，本 stage 一克不动。
 */
import type { ModelMessage } from 'ai'

import { toNullable } from '@velaros-ai/core'

import type { ContextAttentionRouterMode } from '../../ContextAttentionPolicyEngine'
import {
  type ContextAttentionRouter,
  type ContextAttentionRouterResult,
} from '../../ContextAttentionRouter'
import type { ContextAttentionSessionRegistry } from '../../ContextAttentionSessionRegistry'
import { ContextEvidenceGraphBuilder } from '../../ContextEvidenceGraph'
import type { ContextWorkingSetBlock } from '../../ContextLedger'
import type {
  CompileProviderRequestInput,
  ProviderHistoryRewriteSignal,
} from '../../ProviderRequestCompiler'

/**
 * 注意力路由内置默认 active（全能力）；mode 仅保留给测试和回放评测做显式覆盖。
 */
export function resolveContextAttentionRouterMode(
  input: CompileProviderRequestInput
): Nullable<ContextAttentionRouterMode> {
  switch (input.contextAttentionRouterMode) {
    case 'shadow':
    case 'guarded':
    case 'active':
      return input.contextAttentionRouterMode
    case 'off':
      return null
    default:
      break
  }

  return 'active'
}

/** 把路由降级 / 折叠决策投影成历史改写签名；路由未改动消息则无签名。 */
export function buildAttentionRewriteSignals(
  route: Nullable<ContextAttentionRouterResult>,
  originalMessages: readonly ModelMessage[]
): ProviderHistoryRewriteSignal[] {
  if (!route || route.messages === originalMessages) return []

  return [
    {
      kind: 'context-attention-route',
      details: route.trace
        .filter((entry) => entry.action === 'handle' || entry.action === 'summarize')
        .map((entry) => ({
          target: entry.target,
          action: entry.action,
          reason: entry.reason,
          score: entry.score,
        })),
    },
  ]
}

/**
 * 执行注意力路由：建证据图 → 按 mode 路由（含跨回合粘滞与回学）→ 回写会话动作。
 * mode 关闭时返回 null（不路由、不回写），与单体 `attentionRoute = null` 分支等价。
 */
export function runAttentionStage(params: {
  messages: ModelMessage[]
  blocks: ContextWorkingSetBlock[]
  input: CompileProviderRequestInput
  router: ContextAttentionRouter
  sessions: ContextAttentionSessionRegistry
}): Nullable<ContextAttentionRouterResult> {
  // 证据图挪到 mode 判定之后：router off（mode null）时白建整图后又丢弃是纯浪费，
  // 只对真正会路由的编译建图。图仅被 router.route 消费，mode null 分支从不触达，逐字节等价。
  const attentionMode = resolveContextAttentionRouterMode(params.input)
  if (!attentionMode) return null

  const evidenceGraph = new ContextEvidenceGraphBuilder().build({
    blocks: params.blocks,
    resourceState: params.input.resourceState,
  })

  const route = params.router.route({
    messages: params.messages,
    blocks: params.blocks,
    mode: attentionMode,
    budgetTokens: toNullable(params.input.contextWindow),
    evidenceGraph,
    previousActionsByBlockId: params.sessions.readSessionActions(
      params.input.sessionId,
      params.blocks
    ),
    blockOutcomes: params.sessions.readSessionOutcomes(params.input.sessionId, params.blocks),
  })
  params.sessions.writeSessionActions(params.input.sessionId, route, params.blocks)
  return route
}
