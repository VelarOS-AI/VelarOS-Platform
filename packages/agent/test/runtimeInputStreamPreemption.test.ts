import assert from 'node:assert/strict'

import type { TextStreamPart, ToolSet } from 'ai'
import { describe, test } from 'bun:test'

import { createAgentRuntimeInputInterruptScope } from '../src/agent/RuntimeInputPort'
import { StreamConsumer } from '../src/agent/stream'
import { ExecutionGuidanceQueue } from '../src/execution/GuidanceQueue'

void describe('runtime input stream preemption', () => {
  void test('accepted guidance stops a provider stream before a late tool call is dispatched', async () => {
    const queue = new ExecutionGuidanceQueue()
    const executionId = 'execution:stream-preemption'
    const interrupt = createAgentRuntimeInputInterruptScope(queue.port(executionId))
    const enqueuedTools: string[] = []
    const toolStarts: string[] = []
    let resolveLatePart: (part: IteratorResult<TextStreamPart<ToolSet>>) => void = () => undefined
    let markWaitingForLatePart: () => void = () => undefined
    const waitingForLatePart = new Promise<void>((resolve) => {
      markWaitingForLatePart = resolve
    })
    let nextIndex = 0
    const stream: AsyncIterable<TextStreamPart<ToolSet>> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          nextIndex += 1
          if (nextIndex === 1)
            return {
              done: false,
              value: { type: 'text-delta', id: 'text-1', text: 'Collected evidence.' },
            } as IteratorResult<TextStreamPart<ToolSet>>

          markWaitingForLatePart()
          return new Promise<IteratorResult<TextStreamPart<ToolSet>>>((resolve) => {
            resolveLatePart = resolve
          })
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    }
    const turnState = {
      turn: 1,
      hasToolUse: false,
      accumulatedText: '',
      hasVisibleOutput: false,
    }
    const consumer = new StreamConsumer({} as never)
    const consumption = consumer.consumeAssistantStream(stream, turnState, {
      abortSignal: interrupt.signal,
      executor: {
        enqueue: (_id, toolName) => enqueuedTools.push(toolName),
      },
      events: {
        emitReasoningDelta: () => undefined,
        emitTextDelta: () => undefined,
        emitGeneratedFile: () => undefined,
        emitSource: () => undefined,
        emitToolStart: ({ toolName }) => toolStarts.push(toolName),
      },
      model: 'probe-model',
    })

    await waitingForLatePart
    assert.deepEqual(queue.enqueue(executionId, {
      role: 'user',
      content: 'Stop searching and synthesize from existing evidence.',
    }), { status: 'accepted' })

    const assistantContent = await consumption
    resolveLatePart({
      done: false,
      value: {
        type: 'tool-call',
        toolCallId: 'late-call',
        toolName: 'project:search',
        input: { query: 'forbidden expansion' },
      } as TextStreamPart<ToolSet>,
    })
    await Promise.resolve()

    assert.deepEqual(assistantContent, [{ type: 'text', text: 'Collected evidence.' }])
    assert.deepEqual(enqueuedTools, [])
    assert.deepEqual(toolStarts, [])
    assert.equal(turnState.hasDispatchedToolUse, undefined)
    interrupt.dispose()
  })
})
