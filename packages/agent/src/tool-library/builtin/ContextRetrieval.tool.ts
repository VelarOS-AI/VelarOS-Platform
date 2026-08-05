import { toNullable } from '@velaros-ai/core'

import { DynamicHandlesMarker, PinnedEvidenceMarker } from '../../agent/history/contextOSMessage'
import { defineVelaTool } from '../defineVelaTool'

import type { RecallContextInput } from './ContextRetrieval'
import { inferRecallRefKind, recallContextSchema } from './ContextRetrieval'

const recallContext = defineVelaTool<RecallContextInput>({
  name: 'context:recall',
  role: 'inspect',
  category: 'context',
  summary: '统一找回本会话之前见过的上下文。',
  outputInline: true,
  suitable: [
    '需要找回较早对话、压缩上下文、pinned evidence、历史工具 payload 或终端日志。',
    '看到动态上下文 handle、evidence id、tool call id 或 ctx-payload:* 引用后需要取回详情。',
  ],
  forbidden: [
    '不要用它读取外部资源的当前内容；当前状态必须用对应的注入能力重新确认。',
    '不要重复取回同一个 ref；摘要足够时直接继续。',
    '折叠桩标注 excerptTruncated:false 时内容已完整可见，不要对它召回。',
  ],
  usage: [
    '搜索未知内容时传 query，kind 默认 all，会同时查会话历史和终端日志。',
    '精确取回时只需传 ref（refKind/reason 可省略，系统按 ref 形状自动判别）。',
    '工具结果里出现 {__truncatedItems,jsonPath,nextOffset} 标记时:传同一 ref + 该 jsonPath + offset=nextOffset 续读剩余条目,返回会告知新的 nextOffset 直到读完。',
  ],
  examples: [
    { query: "BASE_REVISION_MISMATCH", kind: "all" },
    { ref: "ev_123", refKind: "evidence", reason: "need pinned evidence" },
    { ref: "call_abc", refKind: "tool-payload", reason: "need full tool result" },
    { ref: "call_abc", jsonPath: "$.entries", offset: 400, reason: "continue truncated array" },
    { ref: "message:12", refKind: "context-handle", reason: "need prior requirement" },
  ],
  notes: [
    `优先阅读 ${PinnedEvidenceMarker}/${DynamicHandlesMarker} 摘要；不足时再取回详情。`,
    '返回的是历史上下文，不代表当前文件或终端状态。',
  ],
  schema: recallContextSchema,
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    const conversation = ctx.conversation
    const maxChars = toNullable(input.maxChars)

    if (input.ref) {
      // refKind 可省略(按 ref 前缀判别);reason 缺省兜底——两者此前的必填是纯仪式硬拒。
      const refKind = input.refKind ?? inferRecallRefKind(input.ref)
      const reason = input.reason?.trim() || '(未说明)'
      switch (refKind) {
        case 'evidence':
          return {
            kind: refKind,
            result: await conversation.readEvidence({
              sessionId: ctx.sessionId,
              evidenceId: input.ref,
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
        case 'context-handle':
          return {
            kind: refKind,
            result: await conversation.retrieveContextPayload({
              sessionId: ctx.sessionId,
              handleId: input.ref,
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

    return {
      kind,
      query,
      results,
    }
  },
})

const contextRetrievalTools = {
  'context:recall': recallContext,
}

export { contextRetrievalTools }
