// 域：上下文三件套（`context:recall` / `context:handoff` / `context:distill`）的入参形状与结果投影。
//
// 只放 schema 与纯函数：真去召回、真去请交接在 impl/builtin/ContextOperations.ts。
import { z } from 'zod'

import { isPlainObject, isString, toNullable } from '@velaros-ai/core'

import { AgentToolLimits } from '../../contract/constants.js'
import type { DistillContextInput, HandoffContextInput, RecallContextInput } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { renderParameterDescription as parameterDescription } from '../toolkit/tool-description'

import { inferRecallRefKind } from './context-retrieval'

/** 交接理由的长度上限模型直接看得见，值在 AgentToolLimits.context.handoffReasonChars。 */
export const handoffContextSchema: z.ZodType<HandoffContextInput> = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(AgentToolLimits.context.handoffReasonChars)
    .describe(
      parameterDescription({
        description: '为什么当前会话已经不适合继续，以及交接后应继续处理什么。',
        notes: ['用户会看到交接批准卡；写清必要性，不要把普通进度更新当成交接理由。'],
      })
    ),
})

// 兼容事实便签受整体载荷预算约束，不使用过小的条目数硬限制。20 条精炼事实占用与旧版
// 10 × 400 的契约大致相当，同时允许长阶段为每个已完成工作项保留独立可寻址的事实。
// 三个上限模型直接看得见，写在 AgentToolLimits.context 里。
/** 事实便签的入参形状：一批精炼事实，外加一句可选的进度便签。 */
export const distillContextSchema: z.ZodType<DistillContextInput> = z.object({
  facts: z
    .array(z.string().trim().min(1).max(AgentToolLimits.context.distilledFactChars))
    .min(1)
    .max(AgentToolLimits.context.distilledFactCount)
    .describe(
      parameterDescription({
        description: '从已读取/搜索/执行结果中蒸馏出的持久事实。',
        notes: [
          `最多 ${AgentToolLimits.context.distilledFactCount} 条，每条不超过 ${AgentToolLimits.context.distilledFactChars} 字符；事实较多时先合并重复项。`,
          '每条自包含，代码事实带 file:line 或符号名；决策写清结论和原因。',
          '只记新知识，之前 distill 过的事实不要重复。',
        ],
      })
    ),
  note: z
    .string()
    .trim()
    .min(1)
    .max(AgentToolLimits.context.distillNoteChars)
    .optional()
    .describe(
      parameterDescription({
        description: '一句话进度便签：当前做到哪里、下一步是什么。',
        notes: ['被打断或上下文压缩后靠它恢复现场，避免重读文件。'],
      })
    ),
})

/** 模型读取统一逻辑正文，持久档案及其分页坐标保留原始文本。 */
export function presentHistoricalFile(value: unknown): unknown {
  if (!isPlainObject(value) || !isString(value.content) || value.kind !== 'file-snapshot') return value
  const content = (value.offset ? value.content : value.content.replace(/^\uFEFF/u, '')).replace(/\r\n/gu, '\n')
  return { ...value, content, contentFormat: 'unicode-lf', offsetUnit: 'archived-utf16',
    pagingNote: '续读时原样使用 nextOffset；它指向归档原文，不能根据显示正文长度推算。' }
}


/** ref 指向本会话已落盘的载荷时把归档记录取出来，用于判断它到底是文件快照还是内部记录。 */
export async function findRecallArchiveRecord(input: RecallContextInput, ctx: KernelToolContext) {
  const payloadPrefix = `ctx-payload:${encodeURIComponent(ctx.sessionId)}:`
  const archiveHash = input.ref?.startsWith(payloadPrefix) ? input.ref.slice(payloadPrefix.length)
    : input.ref?.startsWith('file-snapshot:') ? input.ref.slice('file-snapshot:'.length) : undefined
  return archiveHash ? ctx.contextPayloadStore?.findByHash(ctx.sessionId, archiveHash) : undefined
}


/** 按 ref 精确取回：refKind 省略时按 ref 前缀判别，reason 省略时给个兜底，不硬拒。 */
export async function recallByRef(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown> {
  const conversation = ctx.conversation
  const maxChars = toNullable(input.maxChars)
  const refKind = input.refKind ?? inferRecallRefKind(input.ref!)
  const reason = input.reason?.trim() || '(未说明)'
  switch (refKind) {
    case 'evidence':
      return {
        kind: refKind,
        result: await conversation.readEvidence({
          sessionId: ctx.sessionId,
          evidenceId: input.ref!,
          maxChars,
        }),
      }
    case 'tool-payload':
      return {
        kind: refKind,
        result: await conversation.readToolPayload({
          sessionId: ctx.sessionId,
          toolCallId: input.ref,
          jsonPath: input.jsonPath,
          offset: input.offset,
          reason,
          maxChars,
        }),
      }
    case 'payload-ref':
      return {
        kind: refKind,
        result: await conversation.readToolPayload({
          sessionId: ctx.sessionId,
          payloadRef: input.ref,
          jsonPath: input.jsonPath,
          offset: input.offset,
          reason,
          maxChars,
        }),
      }
    default:
      return {
        kind: refKind,
        result: await conversation.retrieveContextPayload({
          sessionId: ctx.sessionId,
          handleId: input.ref!,
          // 分页参数必须跟着走:模型手里的 ref 很多时候就是 tool:*(搜索结果的 handleId、
          // 未命中时的自纠样本都是这个形态),漏传等于每次都回第一页,模型照提示加 offset
          // 重试拿到逐字相同的内容直到熔断（审计 U9）。
          jsonPath: input.jsonPath,
          offset: input.offset,
          reason,
          maxChars,
        }),
      }
  }
}


/** 按 query 搜索：kind 缺省 all，会话历史与终端日志各出一份结果。 */
export async function recallByQuery(input: RecallContextInput, ctx: KernelToolContext): Promise<unknown> {
  const conversation = ctx.conversation
  const maxChars = toNullable(input.maxChars)
  const query = input.query!.trim()
  const kind = input.kind ?? 'all'
  const maxResults = toNullable(input.maxResults)
  const results = []

  if (kind === 'all' || kind === 'conversation') {
    results.push({
      kind: 'conversation',
      result: await conversation.searchConversationHistory({
        sessionId: ctx.sessionId,
        query,
        maxResults,
        maxChars,
      }),
    })
  }

  if (kind === 'all' || kind === 'terminal') {
    results.push({
      kind: 'terminal',
      result: await conversation.searchTerminalOutput({
        sessionId: ctx.sessionId,
        query,
        maxResults,
        maxChars,
      }),
    })
  }

  return { kind, query, results }
}
