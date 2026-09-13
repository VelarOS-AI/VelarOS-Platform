
import type {
  ChatContextEvidenceRecord,
  ChatContextRetrievedPayload,
  ChatMessage,
  ChatSessionPayloadSnapshot,
  ChatSessionToolResultPayload,
  SerializedMessage,
} from '@velaros-ai/agent/protocol'
import { isArray, isEmpty, isNonBlankString, isNotNull,isNumber, isPlainObject, isPresent, isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { normalizeLegacyFoldStub } from '../contextRefEnvelope'

import { chatSearchMessages } from './search/Messages'
import { chatSearchText } from './search/Text'
import { paginateJsonPathValue, paginateSerializedText } from './Pagination'
import { type ContextRetrievalReferenceReader } from './ReferenceReader'
import { contextRetrievalReferences } from './References'
import type {
  RetrievalPayloadStorePort,
  RetrievalStateStorePort,
} from './sessionStorePorts'

/**
 * resolveToolPayload 成功后的内部结构。
 */
interface ResolvedToolPayload {
  payload: ChatSessionToolResultPayload
  /** toolResults 对象中的键（可能是 toolCallId 或 ctx-payload:…）。 */
  storageKey: string
  toolCallId: Nullable<string>
  payloadRef: Nullable<string>
}

interface DirectToolPayloadLookupResult {
  checked: boolean
  payload: Nullable<ChatSessionToolResultPayload>
}

type JsonPathSegment = string | number

export interface JsonPathSelection {
  found: boolean
  value: unknown
  reason?: string
}

function readJsonPathIdentifier(path: string, start: number): Nullable<{ key: string; next: number }> {
  let index = start
  while (index < path.length && /[A-Za-z0-9_$]/.test(path[index]!)) {
    index += 1
  }

  if (index === start) return null

  return { key: path.slice(start, index), next: index }
}

function readJsonPathQuotedKey(raw: string): Nullable<string> {
  const inner = raw.slice(1, -1)
  let value = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!
    if (char !== '\\') {
      value += char
      continue
    }

    index += 1
    const escaped = inner[index]
    if (!escaped) return null
    switch (escaped) {
      case '"':
      case '\\':
      case '/': {
        value += escaped
        break
      }
      case 'b': {
        value += '\b'
        break
      }
      case 'f': {
        value += '\f'
        break
      }
      case 'n': {
        value += '\n'
        break
      }
      case 'r': {
        value += '\r'
        break
      }
      case 't': {
        value += '\t'
        break
      }
      case 'u': {
        const hex = inner.slice(index + 1, index + 5)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 4
        break
      }
      default:
        return null
    }
  }
  return value
}

function readJsonPathBracket(path: string, start: number): Nullable<{ segment: JsonPathSegment; next: number }> {
  const end = path.indexOf(']', start)
  if (end < 0) return null

  const raw = path.slice(start + 1, end).trim()
  if (/^\d+$/.test(raw)) return { segment: Number(raw), next: end + 1 }

  if (raw.startsWith('"') && raw.endsWith('"')) {
    const parsed = readJsonPathQuotedKey(raw)
    return isString(parsed) ? { segment: parsed, next: end + 1 } : null
  }

  return null
}

function parseJsonPath(path: string): Nullable<JsonPathSegment[]> {
  const trimmed = path.trim()
  const normalized = trimmed.startsWith('$')
    ? trimmed
    : trimmed.startsWith('.') || trimmed.startsWith('[')
      ? `$${trimmed}`
      : `$.${trimmed}`
  if (normalized === '$') return []
  if (!normalized.startsWith('$')) return null

  const segments: JsonPathSegment[] = []
  let index = 1

  while (index < normalized.length) {
    const char = normalized[index]
    if (char === '.') {
      const identifier = readJsonPathIdentifier(normalized, index + 1)
      if (!identifier) return null
      segments.push(identifier.key)
      index = identifier.next
      continue
    }

    if (char === '[') {
      const bracket = readJsonPathBracket(normalized, index)
      if (!bracket) return null
      segments.push(bracket.segment)
      index = bracket.next
      continue
    }

    return null
  }

  return segments
}

export function selectJsonPath(serialized: string, path: string): JsonPathSelection {
  let root: unknown
  try {
    root = JSON.parse(serialized)
  } catch (error) {
    return {
      found: false,
      value: null,
      reason: `serializedResult is not valid JSON: ${AppError.getMessage(error)}`,
    }
  }

  const segments = parseJsonPath(path)
  if (!segments) return {
      found: false,
      value: null,
      reason: 'jsonPath is invalid. Use paths like $.a.b[0] or $["complex.key"].',
    }

  let current = root
  for (const segment of segments) {
    if (isNumber(segment)) {
      if (!isArray(current) || segment >= current.length) return {
          found: false,
          value: null,
          reason: `jsonPath segment [${segment}] was not found.`,
        }
      current = current[segment]
      continue
    }

    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return {
        found: false,
        value: null,
        reason: `jsonPath segment ${segment} was not found.`,
      }
    current = current[segment]
  }

  return { found: true, value: current }
}

/**
 * 按 **`handle`** 从隐藏的宿主资源区解析并展开 `payload` 正文。
 *
 * ## `Handle` 路由（{@link ChatContextRetrievalService.retrieveContextPayload}）
 * | 前缀 | 方法 | 数据来源 |
 * |------|------|----------|
 * | `tool:` | `retrieveToolPayload` | `payloadStore.toolResults` |
 * | `ctx-payload:` | `retrieveToolPayload` | 内容寻址键 / `payloadRef` |
 * | `ctx-user-payload:` | `retrieveToolPayload` | 超大 user 正文的内容寻址键 |
 * | `message:` | `retrieveMessagePayload` | `stateStore.messages[index]` |
 *
 * ## 工具 `payload` 展开顺序
 * 1. `resolveToolPayload` 定位存储条目
 * 2. 再次 `collectReferenced*`（与索引 `build` 一致，应对索引 `stale`）
 * 3. `ReferenceReader` 读盘日志/`artifact`
 * 4. 按是否有引用分配 `maxChars` 预算，拼接 `content`
 *
 * 每 `Service` 实例一个 `PayloadReader`。
 */
class ContextRetrievalPayloadReader {
  /** handle 前缀：按 toolCallId 寻址，如 `tool:abc-123`。 */
  private readonly toolPayloadHandlePrefix = 'tool:'
  /** handle 前缀：按内容 hash 寻址，如 `ctx-payload:sha256:…`。 */
  private readonly contentAddressedPayloadRefPrefix = 'ctx-payload:'
  /**
   * handle 前缀：超大 user 正文的全保真层引用（`ctx-user-payload:<sessionId>:<hash>`）。
   *
   * 与 `ctx-payload:` 同表落盘（宿主适配器把用户长文同时写进 userMessages 与 toolResults），
   * 只是键前缀不同。过去这一前缀**只有生产方没有消费方**：正文落了盘，任何 handle 都解析不到
   * 它，用户原文永久取不回（审计 U6/U10）。
   */
  private readonly userTextPayloadRefPrefix = 'ctx-user-payload:'

  constructor(
    private readonly payloadStore: RetrievalPayloadStorePort,
    private readonly stateStore: RetrievalStateStorePort,
    private readonly referenceReader: ContextRetrievalReferenceReader
  ) {}

  /**
   * 从 `Context OS` `evidence` 记录推断后续 `retrieve` 用的 `handle`。
   *
   * - `fullPayloadRef` 已是 `tool:` / `ctx-payload:` → 原样返回
   * - 否则若有 `toolCallId` → `tool:{toolCallId}`
   * - 否则 `null`（`readEvidence` 仍返回 `excerpt`，但无 `payloadHandleId`）
   */
  public resolveEvidencePayloadHandle(evidence: ChatContextEvidenceRecord): LooseOptional<string> {
    if (
      evidence.fullPayloadRef?.startsWith(this.toolPayloadHandlePrefix) ||
      this.isContentAddressedRef(evidence.fullPayloadRef)
    ) return evidence.fullPayloadRef

    return evidence.toolCallId ? `${this.toolPayloadHandlePrefix}${evidence.toolCallId}` : null
  }

  /**
   * 展开工具结果 payload 为 agent 可读的大段文本。
   *
   * @param input.sessionId 会话 id
   * @param input.handleId `tool:*` 或 `ctx-payload:*`
   * @param input.retrievalScopeId 写入 metadata，区分重复 retrieve 范围
   * @param input.maxChars 总 content 字符预算（已 clamp）
   * @param input.repeated 本 scope 内是否第 2+ 次 retrieve 同一 handle
   * @param input.retrievalCount 累计 retrieve 次数
   *
   * ### maxChars 预算（存在 log/artifact 引用时）
   * - serializedResult：42%
   * - displayResult：16%
   * - 读盘日志：35%（在 readReferencedLogs 传入）
   * - artifact preview 在 readReferencedArtifactManifests 内单独限额
   * 无引用时 serialized 占满，display 占一半。
   */
  public async retrieveToolPayload(input: {
    sessionId: string
    handleId: string
    retrievalScopeId: string
    maxChars: number
    jsonPath?: LooseOptional<string>
    /**
     * 续读起点（0 起）。jsonPath 命中数组时是**条目**下标，其余情况是正文**字符**下标；
     * 两条路径都在 metadata 里回带 `nextOffset`，模型按同一个字段推进即可。
     */
    offset?: LooseOptional<number>
    repeated: boolean
    retrievalCount: number
  }): Promise<ChatContextRetrievedPayload> {
    const resolved = await this.resolveToolPayload(input.sessionId, input.handleId.startsWith('input:') ? `tool:${input.handleId}` : input.handleId)

    if (!resolved) {
      // 死胡同会逼模型幻觉 id 空转:列出当前可召回的 tool-payload,让它自纠。
      const available = await this.listAvailableToolPayloadRefs(input.sessionId)
      const hint =
        available.length > 0
          ? `未找到该 payload(handle 可能是幻觉或已过期)。当前可召回的工具结果(用 refKind=tool-payload + 下列 ref):\n${available
              .map(
                (entry) =>
                  `- ref=${entry.ref} · ${entry.toolName ?? 'tool'} · ${entry.chars} 字`
              )
              .join('\n')}`
          : '未找到该 payload,且当前会话没有可召回的工具结果。请改用其他上下文或直接向用户说明。'
      return {
        handleId: input.handleId,
        sessionId: input.sessionId,
        found: false,
        kind: 'tool-result',
        content: null,
        repeated: input.repeated,
        retrievalCount: input.retrievalCount,
        warning: hint,
        metadata: {
          ...this.buildMissingToolPayloadMetadata(input.handleId),
          availableToolPayloadRefs: available.map((entry) => entry.ref),
        },
      }
    }
    const { payload, toolCallId, payloadRef, storageKey } = resolved
    const jsonPath = input.jsonPath?.trim() || null
    const jsonSelection = jsonPath ? selectJsonPath(payload.serializedResult, jsonPath) : null

    if (jsonPath && jsonSelection?.found) {
      const page = paginateJsonPathValue(jsonSelection.value, jsonPath, input.offset, input.maxChars)
      const content = [
        toolCallId ? `toolCallId: ${toolCallId}` : null,
        payload.toolName ? `toolName: ${payload.toolName}` : null,
        payloadRef ? `payloadRef: ${payloadRef}` : null,
        `jsonPath: ${jsonPath}`,
        page.summary,
        'serializedResultAtPath:',
        page.body,
      ]
        .filter((item): item is string => Boolean(item))
        .join('\n')

      return {
        handleId: input.handleId,
        sessionId: input.sessionId,
        found: true,
        kind: 'tool-result',
        content,
        repeated: input.repeated,
        retrievalCount: input.retrievalCount,
        warning: input.repeated
          ? '当前执行范围内已检索过该 handle 和 jsonPath；请先使用已返回内容，避免重复检索。'
          : null,
        metadata: {
          toolCallId,
          payloadRef,
          storageKey,
          hash: toNullable(payload.hash),
          retrievalScopeId: input.retrievalScopeId,
          jsonPath,
          jsonPathFound: true,
          ...page.metadata,
        },
      }
    }

    const logReferences = contextRetrievalReferences.collectReferencedLogPaths(
      payload.serializedResult,
      payload.displayResult
    )
    const logSnippets = await this.referenceReader.readReferencedLogs(
      logReferences,
      Math.max(1_000, Math.floor(input.maxChars * 0.35))
    )
    const artifactReferences = contextRetrievalReferences.collectReferencedArtifactPaths(
      payload.serializedResult,
      payload.displayResult
    )
    const artifactManifests =
      await this.referenceReader.readReferencedArtifactManifests(artifactReferences)
    const hasReferences = !isEmpty(logSnippets) || !isEmpty(artifactManifests)
    // content-addressed payload 的 displayResult 与 serializedResult 完全相同(存储适配器直接赋
    // 同值),重复输出白吃一半预算。仅在两者真不同时才额外给 displayResult。
    const displayDiffersFromSerialized =
      isNonBlankString(payload.displayResult) &&
      payload.displayResult !== payload.serializedResult
    const serializedBudget = hasReferences
      ? Math.max(1_000, Math.floor(input.maxChars * (displayDiffersFromSerialized ? 0.42 : 0.6)))
      : input.maxChars
    const displayBudget = hasReferences
      ? Math.max(1_000, Math.floor(input.maxChars * 0.16))
      : Math.max(1_000, Math.floor(input.maxChars / 2))
    // 字符级窗口:offset=0 时 window.text 就是从头 serializedBudget 字(与旧行为等价,只是
    // 尾部截断标记由 nextOffset 元数据代替),offset>0 时才是真正的续读。
    const window = paginateSerializedText(
      payload.serializedResult,
      input.offset,
      serializedBudget
    )
    const content = [
      toolCallId ? `toolCallId: ${toolCallId}` : null,
      payload.toolName ? `toolName: ${payload.toolName}` : null,
      payloadRef ? `payloadRef: ${payloadRef}` : null,
      `chars: ${window.offset}-${window.offset + window.returnedChars}/${window.totalChars}${
        isPresent(window.nextOffset) ? ` (续读传 offset=${window.nextOffset})` : ' (已到末尾)'
      }`,
      'serializedResult:',
      window.text,
      displayDiffersFromSerialized ? 'displayResult:' : null,
      displayDiffersFromSerialized
        ? chatSearchText.stringifyPayload(payload.displayResult, displayBudget)
        : null,
      !isEmpty(logSnippets)
        ? `referencedLogs:\n${this.referenceReader.formatLogSnippets(logSnippets)}`
        : null,
      !isEmpty(artifactManifests)
        ? `referencedArtifacts:\n${this.referenceReader.formatArtifactManifests(artifactManifests)}`
        : null,
    ]
      .filter((item): item is string => Boolean(item))
      .join('\n')

    return {
      handleId: input.handleId,
      sessionId: input.sessionId,
      found: true,
      kind: 'tool-result',
      content,
      repeated: input.repeated,
      retrievalCount: input.retrievalCount,
      warning: [
        jsonPath && jsonSelection && !jsonSelection.found
          ? `未找到 jsonPath ${jsonPath}：${jsonSelection.reason ?? 'unknown'}；已返回完整 payload 摘要。`
          : null,
        window.beyondEnd
          ? `offset=${window.offset} 已越过正文末尾(totalChars=${window.totalChars})；正文已读完，不要再加大 offset 重试。`
          : null,
        input.repeated
          ? '当前执行范围内已检索过该 handle；请先使用已返回内容，避免重复检索。'
          : null,
      ].filter((item): item is string => Boolean(item)).join(' ') || null,
      metadata: {
        toolCallId,
        payloadRef,
        storageKey,
        hash: toNullable(payload.hash),
        retrievalScopeId: input.retrievalScopeId,
        jsonPath,
        jsonPathFound: !!jsonSelection?.found,
        offset: window.offset,
        returnedChars: window.returnedChars,
        totalChars: window.totalChars,
        nextOffset: window.nextOffset,
        referencedLogs: logSnippets.map((snippet) => ({
          path: snippet.path,
          source: snippet.source,
          size: snippet.size,
          truncated: snippet.truncated,
          warning: snippet.warning,
        })),
        referencedArtifacts: artifactManifests.map((artifact) => ({
          path: artifact.path,
          source: artifact.source,
          filename: artifact.filename,
          type: artifact.type,
          size: artifact.size,
          hasPreview: isNotNull(artifact.preview),
          warning: artifact.warning,
        })),
      },
    }
  }

  /**
   * 将 handle 解析为 toolResults 中的具体条目。
   *
   * 1. `tool:{id}` → 直接读取单个 tool blob，避免扫描整包 payload
   * 2. `ctx-payload:…` → 先直键读取，再退回 snapshot 遍历 payloadRef 匹配
   * 3. 其它前缀 → null
   */
  private async resolveToolPayload(
    sessionId: string,
    handleId: string
  ): Promise<Nullable<ResolvedToolPayload>> {
    const visited = new Set<string>()
    let current = handleId
    for (let depth = 0; depth < 8; depth += 1) {
      if (visited.has(current)) throw new AppError('VALIDATION', 'Context payload reference cycle detected.')
      visited.add(current)
      const resolved = await this.resolveSingleToolPayload(sessionId, current)
      if (!resolved) return null
      const text = resolved.payload.serializedResult
      if (!text.includes('ctx-payload:')) return resolved
      let ref: string | undefined
      try {
        ref = normalizeLegacyFoldStub(JSON.parse(text) as unknown)?.ref
      } catch {
        // arch-guard:silent-catch-ok 普通工具正文可能含不完整的 JSON 示例，仍按原始内容返回。
        return resolved
      }
      if (!ref?.startsWith('ctx-payload:')) return resolved
      current = ref
    }
    throw new AppError('VALIDATION', 'Context payload reference chain requires more than 8 lookups.')
  }

  private async resolveSingleToolPayload(
    sessionId: string,
    handleId: string
  ): Promise<Nullable<ResolvedToolPayload>> {
    if (handleId.startsWith(this.toolPayloadHandlePrefix)) {
      const toolCallId = handleId.slice(this.toolPayloadHandlePrefix.length)
      const directLookup = await this.loadDirectToolPayload(sessionId, toolCallId)
      if (directLookup.payload) return {
          payload: directLookup.payload,
          storageKey: toolCallId,
          toolCallId,
          payloadRef: toNullable(directLookup.payload.payloadRef),
        }
      // 直查未命中不能判死:折叠写入的条目键是 payloadRef(ctx-payload:*)，
      // toolCallId 存在 value 里，落到下方快照扫描按 value 匹配。
    }

    if (this.isContentAddressedRef(handleId)) {
      const directLookup = await this.loadDirectToolPayload(sessionId, handleId)
      if (directLookup.payload) return {
          payload: directLookup.payload,
          storageKey: handleId,
          toolCallId: toNullable(directLookup.payload.toolCallId),
          payloadRef: directLookup.payload.payloadRef ?? handleId,
        }
    }

    const snapshot = await this.payloadStore.loadSessionPayloads(sessionId)
    return this.resolveToolPayloadFromSnapshot(snapshot, handleId)
  }

  private async loadDirectToolPayload(
    sessionId: string,
    storageKey: string
  ): Promise<DirectToolPayloadLookupResult> {
    const directLoader = this.payloadStore.loadToolPayload
    if (!directLoader) return { checked: false, payload: null }

    return {
      checked: true,
      payload: await directLoader.call(this.payloadStore, sessionId, storageKey),
    }
  }

  private resolveToolPayloadFromSnapshot(
    snapshot: ChatSessionPayloadSnapshot,
    handleId: string
  ): Nullable<ResolvedToolPayload> {
    if (handleId.startsWith(this.toolPayloadHandlePrefix)) {
      const toolCallId = handleId.slice(this.toolPayloadHandlePrefix.length)
      const payload = snapshot.toolResults[toolCallId]
      if (payload) return {
          payload,
          storageKey: toolCallId,
          toolCallId,
          payloadRef: toNullable(payload.payloadRef),
        }

      // 键未命中时按 value.toolCallId 匹配（折叠条目以 payloadRef 为键）。
      for (const [storageKey, stored] of Object.entries(snapshot.toolResults)) {
        if (stored.toolCallId !== toolCallId) continue
        return {
          payload: stored,
          storageKey,
          toolCallId,
          payloadRef: toNullable(stored.payloadRef ?? storageKey),
        }
      }
      return null
    }

    if (!this.isContentAddressedRef(handleId)) return null

    const directPayload = snapshot.toolResults[handleId]
    if (directPayload) return {
        payload: directPayload,
        storageKey: handleId,
        toolCallId: toNullable(directPayload.toolCallId),
        payloadRef: directPayload.payloadRef ?? handleId,
      }

    for (const [storageKey, payload] of Object.entries(snapshot.toolResults)) {
      if (payload.payloadRef !== handleId && payload.handoff?.sourceRef !== handleId && !payload.handoff?.sourceRefs?.includes(handleId)) {
        continue
      }

      return {
        payload,
        storageKey,
        toolCallId: payload.toolCallId ?? (this.isContentAddressedRef(storageKey)
          ? null
          : storageKey),
        payloadRef: handleId,
      }
    }

    return null
  }

  /** 内容寻址前缀（工具结果 payload 与 user 长文 payload 同表落盘，路由口径必须一致）。 */
  private isContentAddressedRef(handleId: LooseOptional<string>): boolean {
    return (
      !!handleId?.startsWith(this.contentAddressedPayloadRefPrefix) ||
      !!handleId?.startsWith(this.userTextPayloadRefPrefix)
    )
  }

  /**
   * found=false 时 metadata 里尽量留下可 debug 的 id 片段。
   */
  private buildMissingToolPayloadMetadata(handleId: string): Record<string, unknown> {
    if (handleId.startsWith(this.toolPayloadHandlePrefix)) return { toolCallId: handleId.slice(this.toolPayloadHandlePrefix.length) }

    if (this.isContentAddressedRef(handleId)) return { payloadRef: handleId }

    return { handleId }
  }

  /** 列出当前会话可召回的工具结果(供 not-found 自纠提示);最多返回最近 20 条。 */
  private async listAvailableToolPayloadRefs(
    sessionId: string
  ): Promise<Array<{ ref: string; toolName: Nullable<string>; chars: number }>> {
    try {
      const snapshot = await this.payloadStore.loadSessionPayloads(sessionId)
      const seen = new Set<string>()
      const entries: Array<{ ref: string; toolName: Nullable<string>; chars: number }> = []
      for (const [storageKey, payload] of Object.entries(snapshot.toolResults)) {
        // 优先给 toolCallId(模型手里的 handle 多是 call_*),回退 payloadRef。
        const ref = payload.toolCallId?.trim() || payload.payloadRef?.trim() || storageKey
        if (seen.has(ref)) continue
        seen.add(ref)
        entries.push({
          ref,
          toolName: toNullable(payload.toolName),
          chars: payload.serializedResult.length,
        })
      }
      // 大结果通常是模型想召回的;按体量降序,截前 20。
      return entries.sort((left, right) => right.chars - left.chars).slice(0, 20)
    } catch {
      // arch-guard:silent-catch-ok 自纠候选是 best-effort：快照读不到时给空列表，不能让它压过主召回错误。
      return []
    }
  }

  /**
   * 按 `message:{index}` 展开单条会话消息。
   *
   * content 段：messageIndex、role、timestamp、text、serialized（若有）、toolBlocks 摘要。
   * 最终整体 truncate 到 maxChars。
   */
  public async retrieveMessagePayload(input: {
    sessionId: string
    handleId: string
    retrievalScopeId: string
    maxChars: number
    repeated: boolean
    retrievalCount: number
  }): Promise<ChatContextRetrievedPayload> {
    const rawIndex = input.handleId.slice('message:'.length)
    const index = /^\d+$/u.test(rawIndex) ? Number(rawIndex) : Number.NaN
    if (!Number.isSafeInteger(index) || index < 0) return {
        handleId: input.handleId,
        sessionId: input.sessionId,
        found: false,
        kind: 'message',
        content: null,
        repeated: input.repeated,
        retrievalCount: input.retrievalCount,
        warning: '消息 handle 索引无效。',
      }

    const message = await this.stateStore.loadSessionMessage(
      input.sessionId,
      index
    )
    if (!message) return {
        handleId: input.handleId,
        sessionId: input.sessionId,
        found: false,
        kind: 'message',
        content: null,
        repeated: input.repeated,
        retrievalCount: input.retrievalCount,
        warning: '未在已保存的会话状态中找到该消息。',
        metadata: { index },
      }

    const serialized = await this.loadSerializedMessage(input.sessionId, message)
    const text = chatSearchMessages.getMessageText(message)
    const toolBlocks = chatSearchMessages.getMessageToolBlocks(message)
    const content = [
      `messageIndex: ${index}`,
      `role: ${message.role}`,
      `timestamp: ${message.timestamp}`,
      text ? `text:\n${text}` : null,
      serialized ? `serialized:\n${chatSearchText.stringifyPayload(serialized, input.maxChars)}` : null,
      !isEmpty(toolBlocks)
        ? `toolBlocks:\n${chatSearchText.stringifyPayload(
            toolBlocks.map((block) => ({
              toolCallId: block.toolCallId,
              toolName: block.toolName,
              args: block.args,
              error: block.error,
            })),
            Math.max(1_000, Math.floor(input.maxChars / 2))
          )}`
        : null,
    ]
      .filter((item): item is string => Boolean(item))
      .join('\n')

    return {
      handleId: input.handleId,
      sessionId: input.sessionId,
      found: true,
      kind: 'message',
      content: chatSearchText.truncate(content, input.maxChars),
      repeated: input.repeated,
      retrievalCount: input.retrievalCount,
      warning: input.repeated
        ? '当前执行范围内已检索过该 handle；请避免重复检索循环。'
        : null,
      metadata: {
        index,
        messageId: message.id,
        retrievalScopeId: input.retrievalScopeId,
      },
    }
  }

  /**
   * 获取消息的 provider serialized 形态。
   * 1. message.serialized 内联
   * 2. serializedStoredExternally → 从 payload 快照 assistantMessages/userMessages 取
   */
  private async loadSerializedMessage(
    sessionId: string,
    message: ChatMessage
  ): Promise<LooseOptional<SerializedMessage>> {
    if (message.serialized) return message.serialized

    if (!message.serializedStoredExternally) return null

    const snapshot = await this.payloadStore.loadSessionPayloads(sessionId)
    return message.role === 'assistant'
      ? snapshot.assistantMessages[message.id]
      : snapshot.userMessages[message.id]
  }
}

export {
  ContextRetrievalPayloadReader,
}

export { type PaginatedJsonPathSelection,type PaginatedTextWindow, paginateJsonPathSelection, paginateSerializedText } from './Pagination'
