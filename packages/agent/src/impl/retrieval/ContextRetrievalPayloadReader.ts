
import { isEmpty, isNonBlankString, isNotNull, isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { RetrievalPayloadStorePort, RetrievalStateStorePort } from '../../contract/requires.js'
import type { ChatContextEvidenceRecord, ChatContextRetrievedPayload, ChatMessage, ChatSessionPayloadSnapshot, SerializedMessage } from '../../types/agent.js'
import type { DirectToolPayloadLookupResult, ResolvedToolPayload } from '../../types/retrieval.js'
import { normalizeLegacyFoldStub } from '../../utils/context/context-ref-envelope'
import { isPrivateFileContextRecord } from '../../utils/context/private-file-records'
import { selectJsonPath } from '../../utils/retrieval/context-retrieval-payload-reader'
import { getMessageText, getMessageToolBlocks } from '../../utils/retrieval/messages'
import { paginateJsonPathValue, paginateSerializedText } from '../../utils/retrieval/pagination'
import { chatSearchText } from '../../utils/retrieval/text'

import { type ContextRetrievalReferenceReader } from './ContextRetrievalReferenceReader'
import { contextRetrievalReferences } from './ContextRetrievalReferences'

/**
 * 按 handle 把藏在宿主资源区的正文取回来这一面：工具结果、内容寻址的大 payload、超大 user 正文和单条历史消息，四类各有自己的前缀。
 *
 * 实现是 `ContextRetrievalPayloadReader`，每个 `ChatContextRetrievalService` 实例持一个；本身不缓存，每次都现读存储端口。
 * 取不到不抛：返回 `found: false` 并在 `warning` 里给出可召回的候选，让模型自纠而不是拿着幻觉 id 空转。
 * 真正抛错的只有三种坏输入：payload 引用成环、链路超过 8 跳、以及拿通用 handle 去读内部文件记录（都是 `VALIDATION`）。
 */
export interface ContextRetrievalPayloadReaderApi {
  /** 从一条证据记录推断后续该用哪个 handle 去 retrieve：`fullPayloadRef` 已经是 `tool:`/`ctx-payload:` 就原样用，否则退回用 `toolCallId` 拼 `tool:{id}`，都没有时给 null（调用方只能拿摘录，取不到全文）。 */
  resolveEvidencePayloadHandle(evidence: ChatContextEvidenceRecord): LooseOptional<string>
  /** 把一条工具结果展开成模型能读的大段文本：定位存储条目、重新收集日志/制品引用（防索引过期）、读盘、再按引用有无分配字符预算拼出 content。 */
  retrieveToolPayload(input: {
    /** 在哪个会话里找这条 payload。 */
    sessionId: string
    /** 要取的句柄：`tool:{toolCallId}` 或 `ctx-payload:`/`ctx-user-payload:` 打头的内容寻址键。 */
    handleId: string
    /** 这次召回属于哪个执行范围，原样写进 metadata，用来分辨「同一个 handle 在同一范围里被重复取」。 */
    retrievalScopeId: string
    /** 整段 content 的字符预算（调用方已钳过）；有日志/制品引用时按比例分给正文、显示结果和读盘内容。 */
    maxChars: number
    /** 只取 serializedResult 里的某个 JSON 路径，如 `data.items[0].name`；命中数组时按条目分页。留空取整段正文。 */
    jsonPath?: LooseOptional<string>
    /** 续读起点，0 起：jsonPath 命中数组时是条目下标，其余情况是正文字符下标。两条路都会在 metadata 里回带 `nextOffset`，照着它推进即可。 */
    offset?: LooseOptional<number>
    /** 这个 scope 里是不是第二次及以后取同一个 handle；true 时结果里会带上「别再重复召回」的 warning。 */
    repeated: boolean
    /** 这个 handle 在这个 scope 里累计被取了几次，原样写进结果供诊断。 */
    retrievalCount: number
  }): Promise<ChatContextRetrievedPayload>
  /** 按 `message:{index}` 取回单条会话消息：拼出 messageIndex、role、timestamp、正文、provider 序列化形态和工具块摘要，整体截到 maxChars。索引不是合法非负整数、或那条消息不在已保存状态里时返回 `found: false`。 */
  retrieveMessagePayload(input: {
    /** 在哪个会话里找这条消息。 */
    sessionId: string
    /** 要取的句柄，形如 `message:{index}`；冒号后必须是十进制非负整数。 */
    handleId: string
    /** 这次召回属于哪个执行范围，原样写进 metadata。 */
    retrievalScopeId: string
    /** 整段 content 的字符预算；序列化形态和工具块摘要各有更小的分配。 */
    maxChars: number
    /** 这个 scope 里是不是第二次及以后取同一个 handle；true 时结果里会带上劝阻重复召回的 warning。 */
    repeated: boolean
    /** 这个 handle 在这个 scope 里累计被取了几次，原样写进结果供诊断。 */
    retrievalCount: number
  }): Promise<ChatContextRetrievedPayload>
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
class ContextRetrievalPayloadReader implements ContextRetrievalPayloadReaderApi {
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
      if (visited.has(current)) throw new AppError('VALIDATION', '上下文 payload 的引用链成环了：它绕回了已经解析过的句柄，为避免死循环已中止解析。')
      visited.add(current)
      const resolved = await this.resolveSingleToolPayload(sessionId, current)
      if (!resolved) return null
      if (isPrivateFileContextRecord(resolved.payload.toolName))
        throw new AppError('VALIDATION', '读历史文件请改用 context:recall 并带上 path 与 revision：内部文件记录不是通用 payload，不能拿这个句柄直接取。')
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
    throw new AppError('VALIDATION', '上下文 payload 的引用链跳了 8 次还没落到真正的结果：链路太长，已停止解析。')
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
        if (isPrivateFileContextRecord(payload.toolName)) continue
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
    const text = getMessageText(message)
    const toolBlocks = getMessageToolBlocks(message)
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

