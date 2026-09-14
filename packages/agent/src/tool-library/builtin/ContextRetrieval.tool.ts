import { isPlainObject, isString, toNullable } from '@velaros-ai/core'

import { fileContextFor } from '../../agent/context/resources'
import { FileSnapshotToolName } from '../../agent/context/resources/FileSnapshotArchive'
import { DynamicHandlesMarker, PinnedEvidenceMarker } from '../../agent/history/contextOSMessage'
import { defineVelaTool } from '../defineVelaTool'

import { AgentContextReadCapability } from './Capabilities'
import type { RecallContextInput } from './ContextRetrieval'
import { inferRecallRefKind, recallContextSchema } from './ContextRetrieval'

/** 模型读取统一逻辑正文，持久档案及其分页坐标保留原始文本。 */
function presentHistoricalFile(value: unknown): unknown {
  if (!isPlainObject(value) || !isString(value.content) || value.kind !== 'file-snapshot') return value
  const content = (value.offset ? value.content : value.content.replace(/^\uFEFF/u, '')).replace(/\r\n/gu, '\n')
  return { ...value, content, contentFormat: 'unicode-lf', offsetUnit: 'archived-utf16',
    pagingNote: '续读时原样使用 nextOffset；它指向归档原文，不能根据显示正文长度推算。' }
}

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
    '相同 ref、jsonPath 和 offset 已有足够结果时直接继续；需要剩余内容时按 nextOffset 续读。',
    '折叠桩标注 excerptTruncated:false 时内容已完整可见，不要对它召回。',
  ],
  usage: [
    '取回旧文件时传 path 列版本，path + revision 读旧版本；也可直接传快照 ref，系统自动识别。只读历史，不更新当前文件。',
    '搜索未知内容时传 query，kind 默认 all，会同时查会话历史和终端日志。',
    '精确取回时只需传 ref（refKind/reason 可省略，系统按 ref 形状自动判别）。',
    '历史参数视图带 __historyInputOmissions 时，用其中 ref/jsonPath 取回省略字段；标注不是源码。失败回执带 inputReuse 时优先差量重试，无需重新输入正文。',
    '工具结果里出现 {__truncatedItems,jsonPath,nextOffset} 标记时:传同一 ref + 该 jsonPath + offset=nextOffset 续读剩余条目,返回会告知新的 nextOffset 直到读完。',
  ],
  examples: [
    { query: "BASE_REVISION_MISMATCH", kind: "all" },
    { ref: "<evidenceRef>", refKind: "evidence", reason: "need pinned evidence" },
    { ref: "<toolCallId>", refKind: "tool-payload", reason: "need full tool result" },
    { ref: "<toolCallId>", jsonPath: "$.entries", offset: 400, reason: "continue truncated array" },
  ],
  notes: [
    `优先阅读 ${PinnedEvidenceMarker}/${DynamicHandlesMarker} 摘要；不足时再取回详情。`,
    '返回的是历史上下文，不代表当前文件或终端状态。',
    '示例中的 <...> 是占位符，必须替换为历史回执中的实际引用；主动召回的旧候选按普通资料预算处理。',
  ],
  schema: recallContextSchema,
  permissions: [],
  capabilities: AgentContextReadCapability,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    if (input.ref && /^(?:source|view|read-page):/.test(input.ref)) return {
      kind: 'internal-reference', found: false,
      reason: 'This reference is consumed by Project tools. Read current source with project:read; recall historical source with path and revision.',
    }
    const payloadPrefix = `ctx-payload:${encodeURIComponent(ctx.sessionId)}:`
    const archiveHash = input.ref?.startsWith(payloadPrefix) ? input.ref.slice(payloadPrefix.length)
      : input.ref?.startsWith('file-snapshot:') ? input.ref.slice('file-snapshot:'.length) : undefined
    const archiveRecord = archiveHash ? await ctx.contextPayloadStore?.findByHash(ctx.sessionId, archiveHash) : undefined
    if (input.path || input.refKind === 'file-snapshot' || archiveRecord?.toolName === FileSnapshotToolName) {
      const files = fileContextFor(ctx)
      return files ? presentHistoricalFile(await files.recall({ ...input, ref: archiveRecord?.payloadRef ?? input.ref }))
        : { kind: 'file-snapshot', found: false, reason: 'File snapshot storage is unavailable' }
    }
    if (archiveRecord?.toolName.startsWith('__') && archiveRecord.toolName !== '__context_user_text__') return {
      kind: 'internal-reference', found: false,
      reason: 'Internal runtime records are not generic conversation payloads. Use the owning tool; historical files use path and revision.',
    }
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
