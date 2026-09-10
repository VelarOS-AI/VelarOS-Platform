import assert from 'node:assert/strict'

import type { TextStreamPart, ToolSet } from 'ai'
import { describe, test } from 'bun:test'

import { StreamConsumer } from '../src/agent/stream'

void describe('stream idle notice', () => {
  void test('a silent provider stream reports thinking, never a reconnect', async () => {
    const runtimeEvents: Array<{ kind: string; teamPhase?: string }> = []
    let finishStream: () => void = () => undefined
    let nextIndex = 0
    const stream: AsyncIterable<TextStreamPart<ToolSet>> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          nextIndex += 1
          if (nextIndex === 1)
            return {
              done: false,
              value: { type: 'text-delta', id: 'text-1', text: 'Let me think.' },
            } as IteratorResult<TextStreamPart<ToolSet>>

          // 推理模型长时间不出字：流没断，只是静默。
          return new Promise<IteratorResult<TextStreamPart<ToolSet>>>((resolve) => {
            finishStream = () => resolve({ done: true, value: undefined })
          })
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    }
    const consumer = new StreamConsumer({} as never)
    const consumption = consumer.consumeAssistantStream(
      stream,
      { turn: 1, hasToolUse: false, accumulatedText: '', hasVisibleOutput: false },
      {
        abortSignal: new AbortController().signal,
        executor: { enqueue: () => undefined },
        events: {
          emitReasoningDelta: () => undefined,
          emitTextDelta: () => undefined,
          emitGeneratedFile: () => undefined,
          emitSource: () => undefined,
          emitToolStart: () => undefined,
          emitRuntime: (event) => runtimeEvents.push(event as { kind: string; teamPhase?: string }),
        },
        idleReconnectDelayMs: 20,
        model: 'probe-model',
      }
    )

    // 跨过多个静默周期
    await new Promise((resolve) => setTimeout(resolve, 150))
    finishStream()
    await consumption

    assert.equal(
      runtimeEvents.some((event) => event.kind === 'reconnecting'),
      false,
      '静默期不能冒充重连'
    )
    assert.deepEqual(
      runtimeEvents.filter((event) => event.kind === 'phase'),
      [{ kind: 'phase', teamPhase: 'executing' }],
      '一段静默只把状态拉回一次「思考中」'
    )
  })
})
