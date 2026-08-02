import type { ConversationWorkerThread } from '../projection'

import type { ChatMessage } from '#contracts'
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
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readThreadId(value: unknown): Nullable<string> {
  if (!isString(value)) return null

  const threadId = value.trim()

  return isEmpty(threadId) ? null : threadId
}

function truncateDispatchTitle(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77).trimEnd()}...` : value
}

function readDispatchArg(args: Record<string, unknown>, key: string): Nullable<string> {
  return readThreadId(args[key])
}

function readDispatchMode(value: unknown): Nullable<ConversationWorkerThread['mode']> {
  return value === 'async' || value === 'sync' ? value : null
}

function createPendingWorkerThreadFromDispatchToolCall(
  message: ChatMessage,
  block: ToolCallBlock
): Nullable<ConversationWorkerThread> {
  if (block.toolName !== 'agent:dispatch' || !block.isRunning) return null

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
    input: prompt ?? description ?? null,
    output: null,
    summary: title,
    error: null,
    messages: [],
  }
}

function collectThreadIdsFromString(value: string, threadIds: Set<string>): void {
  const trimmed = value.trim()
  if (isEmpty(trimmed)) return

  const subAgentResultPattern =
    /<subagent-result type="application\/json">\s*([\s\S]*?)\s*<\/subagent-result>/gu
  let match: Nullable<RegExpExecArray>

  while ((match = subAgentResultPattern.exec(trimmed))) {
    if (!match[1]) continue

    try {
      collectThreadIdsFromValue(JSON.parse(match[1]), threadIds)
    } catch {
      // Ignore malformed historical tool payloads and keep the timestamp fallback.
    }
  }

  if (trimmed[0] !== '{' && trimmed[0] !== '[') return

  try {
    collectThreadIdsFromValue(JSON.parse(trimmed), threadIds)
  } catch {
    // Ignore non-JSON textual summaries.
  }
}

function collectThreadIdsFromRecord(value: Record<string, unknown>, threadIds: Set<string>): void {
  const directThreadId =
    readThreadId(value.thread_id) ??
    readThreadId(value.threadId) ??
    readThreadId(value.worker_thread_id) ??
    readThreadId(value.workerThreadId)
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
      const threadId = readThreadId(item)

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

function findWorkerThreadAnchorToolCallId(
  anchorIndex: WorkerThreadTranscriptAnchorIndex,
  thread: ConversationWorkerThread
): Nullable<string> {
  const exactAnchor = findNearestTranscriptAnchor(
    anchorIndex.dispatchAnchorsByThreadId.get(thread.threadId) ?? [],
    thread.startedAt
  )
  if (exactAnchor) return exactAnchor.toolCallId

  return findNearestTranscriptAnchor(anchorIndex.dispatchAnchors, thread.startedAt)?.toolCallId ?? null
}

function findWorkerThreadAnchorMessageId(
  anchorIndex: WorkerThreadTranscriptAnchorIndex,
  thread: ConversationWorkerThread
): Nullable<string> {
  return findAnchorAtOrBefore(anchorIndex.messageAnchors, thread.startedAt)?.messageId ?? null
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

  sortWorkerThreadsByStartTime(threads).forEach((thread) => {
    const anchorToolCallId = findWorkerThreadAnchorToolCallId(anchorIndex, thread)

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
