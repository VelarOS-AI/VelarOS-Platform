import type { ConversationWorkerThread } from '../projection'

import type { ChatMessage } from '#contracts'
import { isFiniteNumber } from '#internal/runtime'
import { isArray, isEmpty, isRecord, isString, toNullable } from '#internal/runtime'

type ToolCallBlock = Extract<ChatMessage['blocks'][number], { type: 'tool-call' }>

interface WorkerThreadTimestampAnchor {
  timestamp: number
  order: number
}

interface WorkerThreadMessageAnchor extends WorkerThreadTimestampAnchor {
  messageId: string
}

interface WorkerThreadDispatchAnchor extends WorkerThreadTimestampAnchor {
  toolCallId: string
  threadIds: ReadonlySet<string>
  /**
   * 派发参数里的任务说明。运行中的调用还没有结果，拿不到线程 id；派发器在线程事件里原样带着
   * 这段说明（线程的 `input`），靠它把线程认回自己的那次调用。
   */
  prompt: Nullable<string>
}

interface PendingDispatchPlaceholder {
  toolCallId: string
  thread: ConversationWorkerThread
}

interface WorkerThreadTranscriptAnchorIndex {
  messageAnchors: WorkerThreadMessageAnchor[]
  dispatchAnchors: WorkerThreadDispatchAnchor[]
  dispatchAnchorsByThreadId: Map<string, WorkerThreadDispatchAnchor[]>
  pendingDispatchPlaceholders: PendingDispatchPlaceholder[]
}

export interface WorkerThreadTranscriptPlacement {
  beforeTranscript: ConversationWorkerThread[]
  afterMessageId: Map<string, ConversationWorkerThread[]>
  afterToolCallId: Map<string, ConversationWorkerThread[]>
}

function sortWorkerThreadsByStartTime(
  threads: readonly ConversationWorkerThread[]
): ConversationWorkerThread[] {
  return [...threads].sort((left, right) => {
    const timestampDelta = left.startedAt - right.startedAt

    if (timestampDelta !== 0) return timestampDelta

    return left.threadId.localeCompare(right.threadId)
  })
}

function readFiniteTimestamp(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? value : null
}

/** 去掉首尾空白后的非空文本：线程 id 与任务说明都按这个口径比（派发 schema 会 trim 任务说明）。 */
function readNonBlankText(value: unknown): Nullable<string> {
  if (!isString(value)) return null

  const text = value.trim()

  return isEmpty(text) ? null : text
}

function truncateDispatchTitle(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77).trimEnd()}...` : value
}

function readDispatchArg(args: Record<string, unknown>, key: string): Nullable<string> {
  return readNonBlankText(args[key])
}

function readDispatchMode(value: unknown): Nullable<ConversationWorkerThread['mode']> {
  return value === 'async' || value === 'sync' ? value : null
}

/**
 * 乐观占位按工具块缓存：流式输出时同一条消息里别的块在变，派发块对象本身不变；占位也就沿用
 * 同一个对象，整份落位才能与上一份判等（见 {@link isSameWorkerThreadPlacement}）。
 */
const PendingDispatchThreads = new WeakMap<ToolCallBlock, ConversationWorkerThread>()

function createPendingWorkerThreadFromDispatchToolCall(
  message: ChatMessage,
  block: ToolCallBlock
): Nullable<ConversationWorkerThread> {
  if (block.toolName !== 'agent:dispatch' || !block.isRunning) return null

  const cached = PendingDispatchThreads.get(block)
  if (cached) return cached
  const thread = buildPendingWorkerThread(message, block)
  PendingDispatchThreads.set(block, thread)
  return thread
}

function buildPendingWorkerThread(message: ChatMessage, block: ToolCallBlock): ConversationWorkerThread {
  const args = isRecord(block.args) ? block.args : {}
  const prompt = readDispatchArg(args, 'prompt')
  const description = readDispatchArg(args, 'description')
  const title = truncateDispatchTitle(description ?? prompt ?? 'Sub-agent run')
  const startedAt = readFiniteTimestamp(block.startedAt) ?? message.timestamp

  return {
    threadId: readDispatchArg(args, 'thread_id') ?? `dispatch:${block.toolCallId}`,
    taskId: null,
    nodeId: null,
    title,
    agentName: readDispatchArg(args, 'agent_name'),
    roleId: null,
    phase: null,
    status: 'pending',
    workspaceTarget: null,
    dag: null,
    subagentType: readDispatchArg(args, 'subagent_type'),
    // 由 dispatch tool-call 参数重建的乐观线程还没有后端注入的展示名。
    customAgentName: null,
    mode: readDispatchMode(args.mode),
    model: readDispatchArg(args, 'model'),
    startedAt,
    updatedAt: startedAt,
    input: toNullable(prompt ?? description),
    output: null,
    summary: title,
    error: null,
    messages: [],
  }
}

function collectThreadIdsFromString(value: string, threadIds: Set<string>): void {
  const trimmed = value.trim()
  if (isEmpty(trimmed)) return

  const openMarker = '<subagent-result type="application/json">'
  const closeMarker = '</subagent-result>'
  let cursor = 0
  while (cursor < trimmed.length) {
    const open = trimmed.indexOf(openMarker, cursor)
    if (open < 0) break
    const bodyStart = open + openMarker.length
    const close = trimmed.indexOf(closeMarker, bodyStart)
    if (close < 0) break
    const body = trimmed.slice(bodyStart, close).trim()
    cursor = close + closeMarker.length
    if (!body) continue

    try {
      collectThreadIdsFromValue(JSON.parse(body), threadIds)
    } catch {
      // arch-guard:silent-catch-ok 历史工具载荷损坏时保留时间戳回退，不让旧记录击穿时间线。
    }
  }

  if (trimmed[0] !== '{' && trimmed[0] !== '[') return

  try {
    collectThreadIdsFromValue(JSON.parse(trimmed), threadIds)
  } catch {
    // arch-guard:silent-catch-ok 普通文本摘要不是 JSON，按文本路径继续处理。
  }
}

function collectThreadIdsFromRecord(value: Record<string, unknown>, threadIds: Set<string>): void {
  const directThreadId =
    readNonBlankText(value.thread_id) ??
    readNonBlankText(value.threadId) ??
    readNonBlankText(value.worker_thread_id) ??
    readNonBlankText(value.workerThreadId)
  if (directThreadId) {
    threadIds.add(directThreadId)
  }

  for (const directListKey of [
    'thread_ids',
    'threadIds',
    'worker_thread_ids',
    'workerThreadIds',
  ]) {
    const directListValue = value[directListKey]

    if (!isArray(directListValue)) continue

    directListValue.forEach((item) => {
      const threadId = readNonBlankText(item)

      if (threadId) threadIds.add(threadId)
    })
  }

  for (const nestedKey of [
    'result',
    'data',
    'payload',
    'threads',
    'workerThread',
    'workerThreads',
    'worker_thread',
    'worker_threads',
    'subagents',
    'agents',
  ]) {
    if (nestedKey in value) {
      collectThreadIdsFromValue(value[nestedKey], threadIds)
    }
  }
}

function collectThreadIdsFromValue(value: unknown, threadIds: Set<string>): void {
  if (isString(value)) {
    collectThreadIdsFromString(value, threadIds)
    return
  }

  if (isArray(value)) {
    value.forEach((item) => collectThreadIdsFromValue(item, threadIds))
    return
  }

  if (isRecord(value)) {
    collectThreadIdsFromRecord(value, threadIds)
  }
}

function getDispatchAgentThreadIds(block: ToolCallBlock): Set<string> {
  const threadIds = new Set<string>()

  collectThreadIdsFromValue(block.args, threadIds)
  collectThreadIdsFromValue(block.result, threadIds)
  collectThreadIdsFromValue(block.serializedResult, threadIds)

  return threadIds
}

function sortTimestampAnchors<T extends WorkerThreadTimestampAnchor>(anchors: readonly T[]): T[] {
  return [...anchors].sort((left, right) => {
    const timestampDelta = left.timestamp - right.timestamp

    return timestampDelta !== 0 ? timestampDelta : left.order - right.order
  })
}

function findAnchorAtOrBefore<T extends WorkerThreadTimestampAnchor>(
  anchors: readonly T[],
  timestamp: number
): Nullable<T> {
  let low = 0
  let high = anchors.length - 1
  let anchor: Nullable<T> = null

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const middleAnchor = anchors[middle]

    if (!middleAnchor) break

    if (middleAnchor.timestamp <= timestamp) {
      anchor = middleAnchor
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return anchor
}

function findAnchorAfter<T extends WorkerThreadTimestampAnchor>(
  anchors: readonly T[],
  timestamp: number
): Nullable<T> {
  let low = 0
  let high = anchors.length - 1
  let anchor: Nullable<T> = null

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const middleAnchor = anchors[middle]

    if (!middleAnchor) break

    if (middleAnchor.timestamp > timestamp) {
      anchor = middleAnchor
      high = middle - 1
    } else {
      low = middle + 1
    }
  }

  return anchor
}

function findNearestTranscriptAnchor<T extends WorkerThreadTimestampAnchor>(
  anchors: readonly T[],
  timestamp: number
): Nullable<T> {
  return findAnchorAtOrBefore(anchors, timestamp) ?? findAnchorAfter(anchors, timestamp)
}

function createWorkerThreadTranscriptAnchorIndex(
  messages: readonly ChatMessage[]
): WorkerThreadTranscriptAnchorIndex {
  const messageAnchors: WorkerThreadMessageAnchor[] = []
  const dispatchAnchors: WorkerThreadDispatchAnchor[] = []
  const pendingDispatchPlaceholders: PendingDispatchPlaceholder[] = []
  let dispatchOrder = 0

  messages.forEach((message, messageOrder) => {
    messageAnchors.push({
      messageId: message.id,
      timestamp: message.timestamp,
      order: messageOrder,
    })

    message.blocks.forEach((block) => {
      if (block.type !== 'tool-call' || block.toolName !== 'agent:dispatch') return

      const timestamp = readFiniteTimestamp(block.startedAt) ?? message.timestamp
      dispatchAnchors.push({
        toolCallId: block.toolCallId,
        timestamp,
        order: dispatchOrder,
        threadIds: getDispatchAgentThreadIds(block),
        prompt: readDispatchArg(isRecord(block.args) ? block.args : {}, 'prompt'),
      })

      const pendingThread = createPendingWorkerThreadFromDispatchToolCall(message, block)
      if (pendingThread) {
        pendingDispatchPlaceholders.push({
          toolCallId: block.toolCallId,
          thread: pendingThread,
        })
      }

      dispatchOrder += 1
    })
  })

  const sortedDispatchAnchors = sortTimestampAnchors(dispatchAnchors)
  const dispatchAnchorsByThreadId = new Map<string, WorkerThreadDispatchAnchor[]>()

  sortedDispatchAnchors.forEach((anchor) => {
    anchor.threadIds.forEach((threadId) => {
      const anchors = dispatchAnchorsByThreadId.get(threadId)

      if (anchors) {
        anchors.push(anchor)
        return
      }

      dispatchAnchorsByThreadId.set(threadId, [anchor])
    })
  })

  return {
    messageAnchors: sortTimestampAnchors(messageAnchors),
    dispatchAnchors: sortedDispatchAnchors,
    dispatchAnchorsByThreadId,
    pendingDispatchPlaceholders,
  }
}

/** 同一线程被续跑多次时，参数或结果都写着它的 id；任务说明相同的那次调用才是这次激活的来处。 */
function preferSamePromptAnchors(
  anchors: readonly WorkerThreadDispatchAnchor[],
  prompt: Nullable<string>
): readonly WorkerThreadDispatchAnchor[] {
  const samePrompt = prompt ? anchors.filter((anchor) => anchor.prompt === prompt) : []

  return isEmpty(samePrompt) ? anchors : samePrompt
}

/**
 * 线程挂到哪次 `agent:dispatch` 调用下面：先认身份，时间只作兜底。
 *
 * 1. 调用的参数或结果里写明了这个线程 id（续跑的、已完成的调用）。
 * 2. 还没有结果的调用拿不到线程 id，按任务说明认领；一次调用只被认领一次（记进 `claimedToolCallIds`）。
 * 3. 两样都认不出（旧记录、不是派发出来的线程）才找时间上最近的调用；这样落上去的不算认领。
 *
 * 不能只看时间：工具块的开始时间与线程的开始时间出自两处时钟（Workbench 前者是渲染进程收到
 * tool-start 的时刻，后者是主进程发出 pending 的时刻），线程常比自己那次调用"早"几毫秒，最近邻
 * 就落到上一次调用上；同一轮并行派发时各调用也都早于各自的线程。落错之后，自己那次调用下面只剩
 * 乐观占位卡，同一个子 Agent 就出现两张卡。
 */
function resolveWorkerThreadAnchorToolCallId(
  anchorIndex: WorkerThreadTranscriptAnchorIndex,
  thread: ConversationWorkerThread,
  claimedToolCallIds: Set<string>
): Nullable<string> {
  const prompt = readNonBlankText(thread.input)
  const explicitAnchor = findNearestTranscriptAnchor(
    preferSamePromptAnchors(anchorIndex.dispatchAnchorsByThreadId.get(thread.threadId) ?? [], prompt),
    thread.startedAt
  )
  if (explicitAnchor) return explicitAnchor.toolCallId

  const promptAnchor = prompt
    ? findNearestTranscriptAnchor(
        anchorIndex.dispatchAnchors.filter(
          (anchor) =>
            anchor.prompt === prompt &&
            anchor.threadIds.size === 0 &&
            !claimedToolCallIds.has(anchor.toolCallId)
        ),
        thread.startedAt
      )
    : null
  if (promptAnchor) {
    claimedToolCallIds.add(promptAnchor.toolCallId)
    return promptAnchor.toolCallId
  }

  return toNullable(findNearestTranscriptAnchor(anchorIndex.dispatchAnchors, thread.startedAt)?.toolCallId)
}

function findWorkerThreadAnchorMessageId(
  anchorIndex: WorkerThreadTranscriptAnchorIndex,
  thread: ConversationWorkerThread
): Nullable<string> {
  return toNullable(findAnchorAtOrBefore(anchorIndex.messageAnchors, thread.startedAt)?.messageId)
}

function appendPendingDispatchAgentPlaceholders(
  pendingDispatchPlaceholders: readonly PendingDispatchPlaceholder[],
  afterToolCallId: Map<string, ConversationWorkerThread[]>
): void {
  pendingDispatchPlaceholders.forEach(({ toolCallId, thread }) => {
    if (afterToolCallId.has(toolCallId)) return

    afterToolCallId.set(toolCallId, [thread])
  })
}

export function groupWorkerThreadsByTranscriptAnchor(
  messages: readonly ChatMessage[],
  threads: readonly ConversationWorkerThread[]
): WorkerThreadTranscriptPlacement {
  const beforeTranscript: ConversationWorkerThread[] = []
  const afterMessageId = new Map<string, ConversationWorkerThread[]>()
  const afterToolCallId = new Map<string, ConversationWorkerThread[]>()
  const anchorIndex = createWorkerThreadTranscriptAnchorIndex(messages)
  const claimedToolCallIds = new Set<string>()

  sortWorkerThreadsByStartTime(threads).forEach((thread) => {
    const anchorToolCallId = resolveWorkerThreadAnchorToolCallId(anchorIndex, thread, claimedToolCallIds)

    if (anchorToolCallId) {
      const anchoredThreads = afterToolCallId.get(anchorToolCallId)

      if (anchoredThreads) {
        anchoredThreads.push(thread)
        return
      }

      afterToolCallId.set(anchorToolCallId, [thread])
      return
    }

    const anchorMessageId = findWorkerThreadAnchorMessageId(anchorIndex, thread)

    if (!anchorMessageId) {
      beforeTranscript.push(thread)
      return
    }

    const anchoredThreads = afterMessageId.get(anchorMessageId)

    if (anchoredThreads) {
      anchoredThreads.push(thread)
      return
    }

    afterMessageId.set(anchorMessageId, [thread])
  })

  appendPendingDispatchAgentPlaceholders(anchorIndex.pendingDispatchPlaceholders, afterToolCallId)

  return { beforeTranscript, afterMessageId, afterToolCallId }
}

/**
 * 两份落位逐项同一：同样的锚点下是同一批线程对象。流式输出时消息数组每个 token 都换新，线程与
 * 派发块却没变——调用方据此沿用上一份落位，`renderAfterToolCall` 的引用不变，带派发卡的消息气泡
 * 就不必随正文重画。
 */
export function isSameWorkerThreadPlacement(
  left: WorkerThreadTranscriptPlacement,
  right: WorkerThreadTranscriptPlacement
): boolean {
  return (
    isSameThreadList(left.beforeTranscript, right.beforeTranscript) &&
    isSameThreadMap(left.afterMessageId, right.afterMessageId) &&
    isSameThreadMap(left.afterToolCallId, right.afterToolCallId)
  )
}

function isSameThreadList(
  left: readonly ConversationWorkerThread[],
  right: readonly ConversationWorkerThread[]
): boolean {
  return left.length === right.length && left.every((thread, index) => thread === right[index])
}

function isSameThreadMap(
  left: ReadonlyMap<string, readonly ConversationWorkerThread[]>,
  right: ReadonlyMap<string, readonly ConversationWorkerThread[]>
): boolean {
  if (left.size !== right.size) return false
  for (const [key, threads] of left) {
    const other = right.get(key)
    if (!other || !isSameThreadList(threads, other)) return false
  }
  return true
}

export function listWorkerThreadsFromTranscriptPlacement(
  placement: WorkerThreadTranscriptPlacement
): ConversationWorkerThread[] {
  const byThreadId = new Map<string, ConversationWorkerThread>()
  const appendThreads = (threads: readonly ConversationWorkerThread[]): void => {
    threads.forEach((thread) => {
      if (!byThreadId.has(thread.threadId)) {
        byThreadId.set(thread.threadId, thread)
      }
    })
  }

  appendThreads(placement.beforeTranscript)
  placement.afterMessageId.forEach(appendThreads)
  placement.afterToolCallId.forEach(appendThreads)

  return sortWorkerThreadsByStartTime([...byThreadId.values()])
}

export function findWorkerThreadReplacementForDispatchPlaceholder(
  placement: WorkerThreadTranscriptPlacement,
  placeholderThreadId: string
): Nullable<ConversationWorkerThread> {
  if (!placeholderThreadId.startsWith('dispatch:')) return null

  const toolCallId = placeholderThreadId.slice('dispatch:'.length)
  const anchoredThreads = placement.afterToolCallId.get(toolCallId) ?? []

  return toNullable(anchoredThreads.find((thread) => thread.threadId !== placeholderThreadId))
}

export function listWorkerThreadsForTranscriptStage(
  messages: readonly ChatMessage[],
  threads: readonly ConversationWorkerThread[]
): ConversationWorkerThread[] {
  return listWorkerThreadsFromTranscriptPlacement(
    groupWorkerThreadsByTranscriptAnchor(messages, threads)
  )
}
