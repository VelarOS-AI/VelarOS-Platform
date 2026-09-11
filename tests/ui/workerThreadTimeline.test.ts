import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ChatMessage } from '../../packages/ui/src/conversation/contracts'
import type { ConversationWorkerThread } from '../../packages/ui/src/conversation/projection'
import {
  groupWorkerThreadsByTranscriptAnchor,
  isSameWorkerThreadPlacement,
} from '../../packages/ui/src/conversation/shell/workerThreadTimeline.pure'

type ToolCallBlock = Extract<ChatMessage['blocks'][number], { type: 'tool-call' }>

function dispatchBlock(
  toolCallId: string,
  args: Record<string, unknown>,
  options: { startedAt: number; threadIdInResult?: string }
): ToolCallBlock {
  const finished = !!options.threadIdInResult
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'agent:dispatch',
    args,
    isRunning: !finished,
    startedAt: options.startedAt,
    ...(finished
      ? {
          finishedAt: options.startedAt + 10_000,
          result: `【子 agent 的返回】\n结论\n<subagent-result type="application/json">${JSON.stringify({
            thread_id: options.threadIdInResult,
            status: 'completed',
          })}</subagent-result>`,
        }
      : {}),
  }
}

function assistantMessage(blocks: ToolCallBlock[]): ChatMessage {
  return { id: 'assistant-1', role: 'assistant', blocks, timestamp: 500 }
}

function workerThread(
  threadId: string,
  options: { startedAt: number; input: Nullable<string>; activationId?: string }
): ConversationWorkerThread {
  return {
    threadId,
    ...(options.activationId ? { activationId: options.activationId } : {}),
    taskId: null,
    nodeId: null,
    title: threadId,
    agentName: null,
    roleId: null,
    phase: null,
    status: 'running',
    workspaceTarget: null,
    dag: null,
    subagentType: 'explore',
    customAgentName: null,
    mode: 'sync',
    model: null,
    startedAt: options.startedAt,
    updatedAt: options.startedAt,
    input: options.input,
    output: null,
    summary: null,
    error: null,
    messages: [],
  }
}

function anchoredThreadIds(
  placement: ReturnType<typeof groupWorkerThreadsByTranscriptAnchor>,
  toolCallId: string
): string[] {
  return (placement.afterToolCallId.get(toolCallId) ?? []).map(
    (thread) => thread.activationId ?? thread.threadId
  )
}

void describe('worker thread transcript placement', () => {
  void test('a running dispatch keeps its own thread even when the thread started a few ms before the tool block', () => {
    // 宿主记工具块开始时间用的是收到 tool-start 的时刻，线程开始时间是主进程发 pending 的时刻：
    // 线程会比自己那次调用"早"，按时间最近邻会落到上一次调用上。
    const placement = groupWorkerThreadsByTranscriptAnchor(
      [
        assistantMessage([
          dispatchBlock('call-atlas', { agent_name: 'Atlas', prompt: 'audit tool contracts' }, {
            startedAt: 1_000,
            threadIdInResult: 'subagent:atlas',
          }),
          dispatchBlock('call-forge', { agent_name: 'Forge', prompt: ' audit the transaction core ' }, {
            startedAt: 2_000,
          }),
        ]),
      ],
      [
        workerThread('subagent:atlas', { startedAt: 998, input: 'audit tool contracts' }),
        workerThread('subagent:forge', { startedAt: 1_996, input: 'audit the transaction core' }),
      ]
    )

    assert.deepEqual(anchoredThreadIds(placement, 'call-atlas'), ['subagent:atlas'])
    // 自己那次调用下面是真线程，不再额外补一张乐观占位卡。
    assert.deepEqual(anchoredThreadIds(placement, 'call-forge'), ['subagent:forge'])
  })

  void test('parallel dispatches in one turn each claim the call that carried their task', () => {
    const placement = groupWorkerThreadsByTranscriptAnchor(
      [
        assistantMessage([
          dispatchBlock('call-x', { prompt: 'scan src/auth' }, { startedAt: 1_000 }),
          dispatchBlock('call-y', { prompt: 'scan src/billing' }, { startedAt: 1_001 }),
        ]),
      ],
      [
        workerThread('subagent:y', { startedAt: 1_002, input: 'scan src/billing' }),
        workerThread('subagent:x', { startedAt: 1_003, input: 'scan src/auth' }),
      ]
    )

    assert.deepEqual(anchoredThreadIds(placement, 'call-x'), ['subagent:x'])
    assert.deepEqual(anchoredThreadIds(placement, 'call-y'), ['subagent:y'])
  })

  void test('the same task dispatched twice is claimed once per call, in start order', () => {
    const placement = groupWorkerThreadsByTranscriptAnchor(
      [
        assistantMessage([
          dispatchBlock('call-1', { prompt: 'retry the flaky test' }, { startedAt: 1_000 }),
          dispatchBlock('call-2', { prompt: 'retry the flaky test' }, { startedAt: 2_000 }),
        ]),
      ],
      [
        workerThread('subagent:first', { startedAt: 999, input: 'retry the flaky test' }),
        workerThread('subagent:second', { startedAt: 1_999, input: 'retry the flaky test' }),
      ]
    )

    assert.deepEqual(anchoredThreadIds(placement, 'call-1'), ['subagent:first'])
    assert.deepEqual(anchoredThreadIds(placement, 'call-2'), ['subagent:second'])
  })

  void test('each activation of a resumed thread sits under the call that carried its prompt', () => {
    const placement = groupWorkerThreadsByTranscriptAnchor(
      [
        assistantMessage([
          dispatchBlock('call-first', { prompt: 'review the patch' }, {
            startedAt: 1_000,
            threadIdInResult: 'subagent:reviewer',
          }),
          dispatchBlock('call-resume', { thread_id: 'subagent:reviewer', prompt: 'check the edge case too' }, {
            startedAt: 2_000,
          }),
        ]),
      ],
      [
        workerThread('subagent:reviewer', {
          activationId: 'subagent:reviewer:activation:1',
          startedAt: 1_001,
          input: 'review the patch',
        }),
        workerThread('subagent:reviewer', {
          activationId: 'subagent:reviewer:activation:2',
          startedAt: 1_998,
          input: 'check the edge case too',
        }),
      ]
    )

    assert.deepEqual(anchoredThreadIds(placement, 'call-first'), ['subagent:reviewer:activation:1'])
    assert.deepEqual(anchoredThreadIds(placement, 'call-resume'), ['subagent:reviewer:activation:2'])
  })

  void test('a running dispatch without a thread yet still shows its optimistic placeholder', () => {
    const placement = groupWorkerThreadsByTranscriptAnchor(
      [
        assistantMessage([
          dispatchBlock('call-pending', { agent_name: 'Scout', prompt: 'map the repo', description: 'Map repo' }, {
            startedAt: 1_000,
          }),
        ]),
      ],
      []
    )

    const [placeholder] = placement.afterToolCallId.get('call-pending') ?? []
    assert.equal(placeholder?.threadId, 'dispatch:call-pending')
    assert.equal(placeholder?.agentName, 'Scout')
    assert.equal(placeholder?.status, 'pending')
  })

  void test('threads that carry no task description fall back to the nearest call in time', () => {
    const placement = groupWorkerThreadsByTranscriptAnchor(
      [
        assistantMessage([
          dispatchBlock('call-early', { prompt: 'a' }, { startedAt: 1_000 }),
          dispatchBlock('call-late', { prompt: 'b' }, { startedAt: 2_000 }),
        ]),
      ],
      [workerThread('subagent:legacy', { startedAt: 2_500, input: null })]
    )

    assert.deepEqual(anchoredThreadIds(placement, 'call-late'), ['subagent:legacy'])
    // 没认出来的线程不占位：早一些那次调用还在跑，照样有自己的占位卡。
    assert.deepEqual(anchoredThreadIds(placement, 'call-early'), ['dispatch:call-early'])
  })

  void test('streamed text alone leaves the placement equal, placeholders included', () => {
    const running = dispatchBlock('call-running', { prompt: 'scan' }, { startedAt: 1_000 })
    const done = dispatchBlock('call-done', { prompt: 'read' }, { startedAt: 500, threadIdInResult: 'subagent:done' })
    const thread = workerThread('subagent:done', { startedAt: 501, input: 'read' })
    const before = groupWorkerThreadsByTranscriptAnchor(
      [{ id: 'm', role: 'assistant', blocks: [done, running, { type: 'text', text: 'wor' }], timestamp: 500 }],
      [thread]
    )
    // 下一个 token：正文块换新，派发块与线程对象不变。
    const after = groupWorkerThreadsByTranscriptAnchor(
      [{ id: 'm', role: 'assistant', blocks: [done, running, { type: 'text', text: 'working' }], timestamp: 500 }],
      [thread]
    )

    assert.equal(isSameWorkerThreadPlacement(before, after), true)
    assert.equal(before.afterToolCallId.get('call-running')?.[0], after.afterToolCallId.get('call-running')?.[0])
  })

  void test('an updated thread makes the placement differ', () => {
    const done = dispatchBlock('call-done', { prompt: 'read' }, { startedAt: 500, threadIdInResult: 'subagent:done' })
    const messages: ChatMessage[] = [{ id: 'm', role: 'assistant', blocks: [done], timestamp: 500 }]
    const thread = workerThread('subagent:done', { startedAt: 501, input: 'read' })

    assert.equal(
      isSameWorkerThreadPlacement(
        groupWorkerThreadsByTranscriptAnchor(messages, [thread]),
        groupWorkerThreadsByTranscriptAnchor(messages, [{ ...thread, output: 'more' }])
      ),
      false
    )
  })
})
