import type { ModelMessage } from 'ai'

import { isArray, isBlank, isPresent,isRecord, isString, Log, toOptional } from '@velaros-ai/core'

import type { ClassifiedContextWorkingSet, ClassifyContextWorkingSetInput, ContextActiveTaskInput, ContextPinnedEvidenceInput, ContextResourceStateInput, ContextWorkingSetBlock, ContextWorkingSetBlockLifecycle, ContextWorkingSetBlockProvenance, ContextWorkingSetBlockSafety, ContextWorkingSetZoneId } from '../../types/context.js'

import { estimateBlockChars, estimateBlockTokens, hasFailureSignal } from './context-ledger'
import { DefaultContextWorkingSetZonePolicies } from './context-working-set-zones'
import { readVerbatimString } from './message-scan'
import { isStatefulToolResultName } from './stateful-tool-results'

/**
 * 组装一个工作集块：按分区策略抄进优先级，估算字符数与 token，并把生命周期与安全标记补齐成满字段。
 * `metadata.contentText` 不给时从 `content` 里抽文本；`stale` 不给时跟随生命周期里的 `stale`。
 */
function createBlock(
  id: string,
  zone: ContextWorkingSetZoneId,
  content: unknown,
  reclaim: ContextWorkingSetBlock['reclaim'],
  metadata: {
    contentText?: string
    provenance?: ContextWorkingSetBlockProvenance
    lifecycle?: Partial<ContextWorkingSetBlockLifecycle>
    safety?: Partial<ContextWorkingSetBlockSafety>
    payloadRef?: string
    stale?: boolean
  } = {}
): ContextWorkingSetBlock {
  const contentText = metadata.contentText ?? extractBlockText(content)
  const chars = estimateBlockChars(content)
  const lifecycle = buildLifecycle(metadata.lifecycle)
  return {
    id,
    zone,
    priority: DefaultContextWorkingSetZonePolicies[zone].priority,
    chars,
    estimatedTokens: estimateBlockTokens(chars),
    contentText,
    provenance: metadata.provenance,
    lifecycle,
    safety: buildSafety(metadata.safety),
    payloadRef: metadata.payloadRef,
    stale: metadata.stale ?? lifecycle.stale,
    reclaim,
    content,
  }
}

/** 一条模型消息归哪个分区：tool 角色的结果进 `tool-payloads`，其余角色进 `recent-turns`。 */
function resolveMessageZone(message: ModelMessage): ContextWorkingSetZoneId {
  return message.role === 'tool' ? 'tool-payloads' : 'recent-turns'
}

/**
 * 一条模型消息腾地方时怎么回收：tool 结果能换成句柄（`reference`，事后可按 payloadRef 取回原文），
 * 其余角色的消息只能就地摘要（`summarize`）。
 */
function resolveMessageReclaim(message: ModelMessage): ContextWorkingSetBlock['reclaim'] {
  return message.role === 'tool' ? 'reference' : 'summarize'
}

/** 把零散的生命周期标记补成七项齐全的记录：没写到的一律按 false 算，下游不必再对每个字段做可选判断。 */
function buildLifecycle(input: Partial<ContextWorkingSetBlockLifecycle> = {}): ContextWorkingSetBlockLifecycle {
  return {
    pinned: !!input.pinned,
    activeTask: !!input.activeTask,
    consumed: !!input.consumed,
    verified: !!input.verified,
    stale: !!input.stale,
    expired: !!input.expired,
    recoverable: !!input.recoverable,
  }
}

/** 把零散的安全标记补成七项齐全的记录：没写到的一律按 false 算，回收阶梯读这份判断哪些块不许改写或丢弃。 */
function buildSafety(input: Partial<ContextWorkingSetBlockSafety> = {}): ContextWorkingSetBlockSafety {
  return {
    containsUserInstruction: !!input.containsUserInstruction,
    containsPermissionDecision: !!input.containsPermissionDecision,
    containsFailureCause: !!input.containsFailureCause,
    containsUntrustedContent: !!input.containsUntrustedContent,
    requiresExactQuote: !!input.requiresExactQuote,
    statefulToolResult: !!input.statefulToolResult,
    containsSecret: !!input.containsSecret,
  }
}

/**
 * 从任意块内容里抽出一段可用来估算体积与做召回匹配的纯文本：字符串原样返回，数组逐项抽取后按行拼；
 * 对象优先取 `text` / `value` 两个字段（都有就按行拼），两个都空才退回 JSON 序列化。
 * 序列化失败（循环引用等）记一条 debug 日志并退回 `String(value)`，不抛错。
 */
function extractBlockText(value: unknown): string {
  if (isString(value)) return value
  if (isArray(value)) return value.map(extractBlockText).filter(Boolean).join('\n')
  if (!isRecord(value)) return ''

  const directText = [readVerbatimString(value.text), readVerbatimString(value.value)]
    .filter(Boolean)
    .join('\n')
  if (!isBlank(directText)) return directText

  try {
    return JSON.stringify(value) ?? ''
  } catch (error) {
    Log.tag('ContextWorkingSetOS').debug('序列化上下文块文本失败，回退到字符串表示', { error: String(error) })
    return String(value)
  }
}

/**
 * 从一条 tool 角色消息里读出这次工具结果的溯源信息：`toolCallId` 与 `toolName` 取第一个 `tool-result`
 * part 上的值；只要有任一 part 的 output 是 `error-text` 就算带失败原因；只要有任一 part 的工具名在
 * 有状态工具名单里就标 `statefulToolResult`（这种结果不许被摘要顶掉）。
 * 不是 tool 消息、或 content 不是数组时返回全空的一份，调用方不必先做角色判断。
 */
function extractToolResultMetadata(message: ModelMessage): {
  toolCallId: Nullable<string>
  toolName: Nullable<string>
  containsFailureCause: boolean
  statefulToolResult: boolean
} {
  if (message.role !== 'tool' || !isArray(message.content)) return {
      toolCallId: null,
      toolName: null,
      containsFailureCause: false,
      statefulToolResult: false,
    }

  let toolCallId: Nullable<string> = null
  let toolName: Nullable<string> = null
  let containsFailureCause = false
  let statefulToolResult = false

  for (const part of message.content as unknown[]) {
    if (!isRecord(part) || part.type !== 'tool-result') continue
    const partToolName = readVerbatimString(part.toolName)
    toolCallId ??= readVerbatimString(part.toolCallId)
    toolName ??= partToolName
    const output = part.output
    if (isRecord(output) && output.type === 'error-text') containsFailureCause = true
    if (partToolName && isStatefulToolResultName(partToolName)) statefulToolResult = true
  }

  return {
    toolCallId,
    toolName,
    containsFailureCause,
    statefulToolResult,
  }
}

/**
 * 把历史里第 `index` 条模型消息做成工作集块。失败信号两路取或：tool 结果自带的 `error-text` output，
 * 或正文文本命中失败特征；命中就同时打上 `containsFailureCause` 与 `requiresExactQuote`——失败原因
 * 必须逐字留着，不许被改写成摘要。user 消息一律标成含用户指令；tool 结果标成可恢复（原文能按句柄取回）。
 */
function buildMessageBlock(message: ModelMessage, index: number): ContextWorkingSetBlock {
  const contentText = extractBlockText(message.content)
  const toolMetadata = extractToolResultMetadata(message)
  const containsFailureCause =
    toolMetadata.containsFailureCause || hasFailureSignal(contentText)

  return createBlock(
    `message:${index}`,
    resolveMessageZone(message),
    message,
    resolveMessageReclaim(message),
    {
      contentText,
      provenance: {
        source: message.role === 'tool' ? 'tool-result' : 'message',
        messageIndex: index,
        toolCallId: toOptional(toolMetadata.toolCallId),
        toolName: toOptional(toolMetadata.toolName),
      },
      lifecycle: {
        recoverable: message.role === 'tool',
      },
      safety: {
        containsUserInstruction: message.role === 'user',
        containsFailureCause,
        requiresExactQuote: containsFailureCause,
        statefulToolResult: toolMetadata.statefulToolResult,
      },
    }
  )
}

/**
 * 给带失败原因的 tool 结果块再配一个 `diagnostics` 分区的副本，好让失败原因在原块被回收之后仍然在场。
 * 只有「来源是 tool-result 且标了 containsFailureCause」的块才配，其余返回 null。
 * 副本自己标成不可恢复（`evict` 掉就真没了），因为它本来就只是原块的一份摘录。
 */
function buildDiagnosticBlock(messageBlock: ContextWorkingSetBlock): Nullable<ContextWorkingSetBlock> {
  if (!messageBlock.safety?.containsFailureCause) return null
  if (messageBlock.provenance?.source !== 'tool-result') return null

  return createBlock(
    `diagnostic:${messageBlock.id}`,
    'diagnostics',
    {
      sourceBlockId: messageBlock.id,
      summary: messageBlock.contentText,
      provenance: messageBlock.provenance,
    },
    'evict',
    {
      contentText: messageBlock.contentText,
      provenance: {
        source: 'diagnostics',
        messageIndex: messageBlock.provenance?.messageIndex,
        toolCallId: messageBlock.provenance?.toolCallId,
        toolName: messageBlock.provenance?.toolName,
      },
      lifecycle: {
        recoverable: false,
      },
      safety: {
        containsFailureCause: true,
        requiresExactQuote: true,
        statefulToolResult: messageBlock.safety.statefulToolResult,
      },
    }
  )
}

/**
 * 把任意一段文本收成能直接拼进块 id 的片段：去首尾空白后把连续的非 `\w.-` 字符压成一个连字符，
 * 再削掉首尾的连字符。整段都被削光时返回 `unnamed`，保证 id 里不会出现空的片段。
 */
function normalizeBlockIdPart(value: string): string {
  const replaced = value.trim().replace(/[^\w.-]+/gu, '-')
  let start = 0
  let end = replaced.length
  while (replaced[start] === '-') start += 1
  while (end > start && replaced[end - 1] === '-') end -= 1
  const normalized = replaced.slice(start, end)
  return normalized || 'unnamed'
}

/** 把当前任务的标题、状态、摘要与最近一次失败拼成 `字段: 值` 的多行文本，供估算体积与召回匹配；没填的字段整行跳过。 */
function activeTaskText(input: ContextActiveTaskInput): string {
  return [
    input.title ? `title: ${input.title}` : null,
    input.state ? `state: ${input.state}` : null,
    input.summary ? `summary: ${input.summary}` : null,
    input.latestFailure ? `latestFailure: ${input.latestFailure}` : null,
  ].filter(isPresent).join('\n')
}

/**
 * 把当前任务做成 `active-task` 分区的固定块：回收方式是 `keep`，任何压力下都不腾它。
 * 块 id 依次取任务 id、标题，都没有就用 `current`。带最近一次失败时同时要求逐字引用，
 * 免得失败原因在后续摘要里被改写成"之前出过错"。
 */
function buildActiveTaskBlock(activeTask: ContextActiveTaskInput): ContextWorkingSetBlock {
  const id = normalizeBlockIdPart(activeTask.id?.trim() || activeTask.title?.trim() || 'current')
  const contentText = activeTaskText(activeTask)

  return createBlock(
    `active-task:${id}`,
    'active-task',
    {
      ...activeTask,
      summary: activeTask.summary,
      latestFailure: activeTask.latestFailure,
    },
    'keep',
    {
      contentText,
      provenance: {
        source: 'active-task',
      },
      lifecycle: {
        activeTask: true,
        pinned: true,
        recoverable: false,
      },
      safety: {
        containsFailureCause: Boolean(activeTask.latestFailure),
        requiresExactQuote: Boolean(activeTask.latestFailure),
      },
    }
  )
}

/**
 * 把一条固定证据做成 `pinned-evidence` 分区的块，并就地判它是否已经过期。
 *
 * 过期三选一即成立：证据自报 `stale`；它记着的文件哈希与 `resourceState` 里同路径文件的当前哈希对不上；
 * 它记着的资源版本号与当前版本号不一致。过期的块同时标 `stale` 与 `expired`，让回收阶梯优先腾它。
 * 带 `payloadRef` 的证据回收时换成句柄（`reference`，原文可取回），否则只能摘要（`summarize`）。
 * `user-constraint` 类证据按用户指令处理，并要求逐字引用。
 */
function buildPinnedEvidenceBlock(
  evidence: ContextPinnedEvidenceInput,
  resourceState?: LooseOptional<ContextResourceStateInput>
): ContextWorkingSetBlock {
  const kind = evidence.kind ?? 'evidence'
  const id = normalizeBlockIdPart(evidence.id)
  const contentText = [evidence.summary, evidence.content].filter(isPresent).join('\n')
  const stale =
    !!evidence.stale ||
    Boolean(
      evidence.filePath &&
        evidence.contentHash &&
        resourceState?.files?.some(
          (file) => file.path === evidence.filePath && file.hash && file.hash !== evidence.contentHash
        )
    ) ||
    Boolean(
      evidence.resourceRevision &&
        resourceState?.revision &&
        resourceState.revision !== evidence.resourceRevision
    )

  return createBlock(
    `pinned-evidence:${id}`,
    'pinned-evidence',
    {
      ...evidence,
      stale,
    },
    evidence.payloadRef ? 'reference' : 'summarize',
    {
      contentText,
      payloadRef: toOptional(evidence.payloadRef),
      stale,
      provenance: {
        source: evidence.source?.trim() || (kind === 'user-constraint' ? 'user-constraint' : 'pinned-evidence'),
        payloadRef: toOptional(evidence.payloadRef),
        filePath: toOptional(evidence.filePath),
        contentHash: toOptional(evidence.contentHash),
        resourceRevision: toOptional(evidence.resourceRevision),
      },
      lifecycle: {
        pinned: true,
        verified: !!evidence.verified,
        stale,
        expired: stale,
        recoverable: evidence.recoverable ?? Boolean(evidence.payloadRef),
      },
      safety: {
        containsUserInstruction: kind === 'user-constraint',
        requiresExactQuote: kind === 'user-constraint',
      },
    }
  )
}

/** 任务和固定证据只依赖当前有效输入；治理预留与最终分类复用这些块。 */
export function classifyRetainedContextWorkingSet(
  input: Pick<ClassifyContextWorkingSetInput, 'activeTask' | 'pinnedEvidence' | 'resourceState'>
): ContextWorkingSetBlock[] {
  return [
    ...(input.activeTask ? [buildActiveTaskBlock(input.activeTask)] : []),
    ...(input.pinnedEvidence ?? []).map((evidence) => buildPinnedEvidenceBlock(evidence, input.resourceState)),
  ]
}

/**
 * 把一次供应方请求的全部原料切成带分区、优先级与回收方式的工作集块表：
 * 系统提示词 → `kernel`，保留上下文 → `active-task` / `pinned-evidence`，消息按角色进
 * `tool-payloads` / `recent-turns`（带失败原因的 tool 结果再配一个 `diagnostics` 块），
 * 工具 schema 与检索句柄各进自己的分区。只做分类，不做任何裁剪与回收。
 */
export function classifyContextWorkingSet(input: ClassifyContextWorkingSetInput): ClassifiedContextWorkingSet {
  const blocks: ContextWorkingSetBlock[] = [
    createBlock('system', 'kernel', input.systemPrompt, 'keep', {
      provenance: { source: 'system' },
      lifecycle: { activeTask: true },
    }),
  ]

  blocks.push(...classifyRetainedContextWorkingSet(input))

  input.messages.forEach((message, index) => {
    const messageBlock = buildMessageBlock(message, index)
    blocks.push(messageBlock)
    const diagnosticBlock = buildDiagnosticBlock(messageBlock)
    if (diagnosticBlock) blocks.push(diagnosticBlock)
  })

  Object.entries(input.toolSchemaChars ?? {}).forEach(([toolName, chars]) => {
    blocks.push({
      id: `tool-schema:${toolName}`,
      zone: 'tool-schemas',
      priority: DefaultContextWorkingSetZonePolicies['tool-schemas'].priority,
      chars: Math.max(0, chars),
      estimatedTokens: estimateBlockTokens(chars),
      contentText: `${toolName} ${chars}`,
      provenance: { source: 'tool-schema' },
      lifecycle: buildLifecycle(),
      safety: buildSafety(),
      reclaim: 'page-out',
      content: { toolName, chars },
    })
  })

  for (const handle of input.retrievalHandles ?? []) {
    const chars = handle.estimatedChars ?? estimateBlockChars(handle.summary)
    blocks.push({
      id: `retrieval:${handle.id}`,
      zone: 'retrieval-index',
      priority: DefaultContextWorkingSetZonePolicies['retrieval-index'].priority,
      chars: Math.max(0, chars),
      estimatedTokens: estimateBlockTokens(chars),
      contentText: handle.summary,
      provenance: {
        source: 'retrieval',
        payloadRef: handle.payloadRef,
      },
      lifecycle: buildLifecycle({
        stale: !!handle.stale,
        expired: !!handle.stale,
        recoverable: Boolean(handle.payloadRef),
      }),
      safety: buildSafety(),
      payloadRef: handle.payloadRef,
      stale: handle.stale,
      reclaim: 'evict',
      content: handle,
    })
  }

  return { blocks }
}
