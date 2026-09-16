// 域：两个 loop 面与两个 turn helper 在「把一轮装配起来」时用到的纯函数。
//
// 这里的函数都不碰实例状态、不发请求、不写历史：给什么算什么。它们从 impl/loop 的类里搬出来，
// 正是因为用不到 this——留在类里会让人以为它们依赖某份实例状态。
import type { ToolChoice, ToolSet } from 'ai'

import { isObject, isString } from '@velaros-ai/core'

import type { QueryLoopToolContext, QueryLoopToolRegistry, QueryTurnEvents, StreamConsumerEvents } from '../../types/loop.js'
import type { ToolExecutorEvents } from '../../types/tools.js'

/** 会话级缓存的键：没有会话 id（headless / 一次性执行）时共用兜底那一格，不同会话的状态才不会互相串。 */
export function resolveLoopSessionStateKey(sessionId: LooseOptional<string>): string {
  return sessionId ?? '__default__'
}

/**
 * 本轮暴露工具的 schema 字符合计（单项为负按 0 记）。
 * 没有预备账时返回 null——「没有可信的账」与「合计为 0」是两回事，遥测要分得清。
 */
export function sumPreparedToolSchemaChars(
  allowedTools: readonly string[],
  toolSchemaChars?: Readonly<Record<string, number>>
): Nullable<number> {
  if (!toolSchemaChars) return null

  return allowedTools.reduce((sum, toolName) => sum + Math.max(0, toolSchemaChars[toolName] ?? 0), 0)
}

/**
 * 子 Agent 本轮的 schema 字符账：问注册表实测，再收成候选工具的那一份。
 * 注册表不提供实测、或任何一个候选工具缺账时整份作废（返回 undefined）——半份账会让预算算出偏小的占用，
 * 宁可让下游按「没有账」走保守路径。
 */
export function prepareQueryLoopToolSchemaChars<TContext extends QueryLoopToolContext>(
  toolRegistry: QueryLoopToolRegistry<TContext>,
  toolContext: TContext,
  allowedTools: string[]
): Readonly<Record<string, number>> | undefined {
  const measured = toolRegistry.estimateToolSerializedCharsByName?.(toolContext, allowedTools)
  if (!measured) return undefined

  if (!allowedTools.every((toolName) => Object.prototype.hasOwnProperty.call(measured, toolName)))
    return undefined

  return Object.fromEntries(
    allowedTools.map((toolName) => [toolName, Math.max(0, measured[toolName] ?? 0)])
  )
}

/**
 * provider 回合账本的 id：会话键 + 链路 + 轮次。
 * 子 Agent 没有面向界面的轮次轴（turn 缺席），用 `internal` 占位，好让同一会话里的内部回合也各有各的 id。
 */
export function buildProviderTurnId(
  sessionKey: string,
  phase: 'stream' | 'query',
  turn: LooseOptional<number>
): string {
  return `${sessionKey}:${phase}:${turn ?? 'internal'}`
}

/**
 * 从强制工具选择里取出工具名，用来写进本回合账本的 `toolChoiceName`。
 * 不是 `{ type: 'tool', toolName }` 这种形态（auto / none / required）就没有名字，返回缺席。
 */
export function resolveProviderToolChoiceName(
  toolChoice?: ToolChoice<ToolSet>
): LooseOptional<string> {
  if (!toolChoice || !isObject(toolChoice)) return undefined

  const candidate = toolChoice as { type?: unknown; toolName?: unknown }
  if (candidate.type !== 'tool' || !isString(candidate.toolName)) return undefined

  const trimmed = candidate.toolName.trim()
  return trimmed || undefined
}

/**
 * 把子 Agent 的事件面接到 ToolExecutor 上：逐项转发，宿主没装配对应监听器时是空操作。
 * 工具执行的事件与文本投影无关，所以这里不受 `streamTextDeltas` 开关影响。
 */
export function createQueryTurnToolExecutorEvents(
  events: LooseOptional<QueryTurnEvents>
): ToolExecutorEvents {
  return {
    emitRuntime: (event) => events?.emitRuntime?.(event),
    emitNotice: (event) => events?.emitNotice?.(event),
    emitToolStart: (payload) => events?.emitToolStart?.(payload),
    emitToolProgress: (payload) => events?.emitToolProgress?.(payload),
    emitToolMetadata: (payload) => events?.emitToolMetadata?.(payload),
    emitToolDone: (payload) => events?.emitToolDone?.(payload),
  }
}

/**
 * 把子 Agent 的事件面接到流消费引擎上——这一层就是「要不要投影界面」的装配点：
 * 正文增量只在 `streamTextDeltas` 打开时才转发，其余事件照常转发给可选监听器（缺省空操作）。
 * 引擎内部的 reducer 累积与 turnState 更新无条件发生，不受这个开关影响。
 */
export function createQueryTurnStreamConsumerEvents(
  events: LooseOptional<QueryTurnEvents>,
  streamTextDeltas: boolean
): StreamConsumerEvents {
  return {
    emitRuntime: (event) => events?.emitRuntime?.(event),
    emitReasoningDelta: (payload) => events?.emitReasoningDelta?.(payload),
    emitTextDelta: (text) => {
      if (streamTextDeltas) events?.emitTextDelta?.(text)
    },
    emitGeneratedFile: (payload) => events?.emitGeneratedFile?.(payload),
    emitSource: (payload) => events?.emitSource?.(payload),
    emitToolStart: (payload) => events?.emitToolStart?.(payload),
    emitToolMetadata: (payload) => events?.emitToolMetadata?.(payload),
  }
}
