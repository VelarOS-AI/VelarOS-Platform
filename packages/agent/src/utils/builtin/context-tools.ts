/** 会话历史检索的来源解析与结果投影。 */

import { isPlainObject, isString, toNullable } from '@velaros-ai/core'

import type { RecallContextInput } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'

import { inferRecallRefKind } from './context-retrieval'

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
