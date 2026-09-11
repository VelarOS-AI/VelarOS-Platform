import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ChatStreamEvent } from '../../packages/ui/src/conversation/contracts'
import {
  ChatStreamPacer,
  type ChatStreamPacerEventClass,
  classifyChatStreamEvent,
  classifyChatStreamStateKind,
  type FrameTimerPort,
} from '../../packages/ui/src/conversation/stream/chatStreamPacer'

/** 宿主自己的事件形状（如直接消费执行事件的 Workbench）。 */
type HostEvent =
  | { type: 'thinking'; streamId: string; text: string }
  | { type: 'tool'; id: string; step: string }
  | { type: 'runtime'; kind: string }
  | { type: 'worker'; n: number }

function classifyHostEvent(event: HostEvent): ChatStreamPacerEventClass {
  if (event.type === 'thinking') return { kind: 'reasoning', id: event.streamId, text: event.text }
  if (event.type === 'tool') return { kind: 'tool', toolCallId: event.id }
  if (event.type === 'worker') return { kind: 'structural', batchKey: 'worker-thread' }
  return { kind: classifyChatStreamStateKind(event.kind) }
}

function createFrames() {
  let now = 0
  let queue: Array<{ callback: FrameRequestCallback; cancelled: boolean }> = []
  const timers: FrameTimerPort = {
    nextFrame(callback) {
      const entry = { callback, cancelled: false }
      queue.push(entry)
      return {
        cancel: () => {
          entry.cancelled = true
          return true
        },
      }
    },
  }
  return {
    timers,
    step(ms = 1000 / 60): void {
      now += ms
      const due = queue
      queue = []
      for (const entry of due) if (!entry.cancelled) entry.callback(now)
    },
    runAll(limit = 2_000): number {
      let frames = 0
      while (queue.some((entry) => !entry.cancelled) && frames < limit) {
        this.step()
        frames += 1
      }
      return frames
    },
  }
}

function createHostPacer(options: { suspended?: () => boolean } = {}) {
  const frames = createFrames()
  const log: string[] = []
  const pacer = new ChatStreamPacer<HostEvent>({
    timers: frames.timers,
    classifyEvent: classifyHostEvent,
    createReasoningEvent: (id, text) => ({ type: 'thinking', streamId: id, text }),
    applyTextChunk: (_session, text) => log.push(`text:${text}`),
    applyDeferredLiveEvent: (_session, event) => log.push(`live:${JSON.stringify(event)}`),
    applyImmediateLiveEvent: (_session, event) => log.push(`now:${JSON.stringify(event)}`),
    applyCachedEvent: (_session, event) => log.push(`cached:${JSON.stringify(event)}`),
    appendImmediateText: (_session, text) => log.push(`text:${text}`),
    isSessionStreaming: () => true,
    getReasoningAppendText: (_previous, incoming) => incoming,
    ...(options.suspended ? { isPacingSuspended: options.suspended } : {}),
  })
  return { pacer, frames, log }
}

function joinedText(log: readonly string[]): string {
  return log.filter((entry) => entry.startsWith('text:')).map((entry) => entry.slice(5)).join('')
}

void describe('chat stream pacer with a host event shape', () => {
  void test('types text out over several frames and keeps tools and the finish in arrival order', () => {
    const { pacer, frames, log } = createHostPacer()
    pacer.enqueueText('s', 1, 'hello streaming world')
    pacer.enqueueLiveEvent('s', 2, { type: 'tool', id: 't1', step: 'start' })
    pacer.enqueueLiveEvent('s', 3, { type: 'runtime', kind: 'done' })

    assert.deepEqual(log, [], 'nothing lands before the first frame')
    frames.runAll()

    const textChunks = log.filter((entry) => entry.startsWith('text:'))
    assert.ok(textChunks.length > 1, 'text is revealed across frames, not in one burst')
    assert.equal(joinedText(log), 'hello streaming world')
    const toolIndex = log.indexOf('live:{"type":"tool","id":"t1","step":"start"}')
    const doneIndex = log.indexOf('now:{"type":"runtime","kind":"done"}')
    assert.ok(toolIndex > log.lastIndexOf(textChunks.at(-1)!), 'the tool lands after the text before it')
    assert.ok(doneIndex > toolIndex, 'the smooth finish lands last')
  })

  void test('rebuilds paced thinking in the host shape', () => {
    const { pacer, frames, log } = createHostPacer()
    pacer.enqueueLiveEvent('s', 1, { type: 'thinking', streamId: 'r1', text: 'let me think' })
    frames.runAll()

    const pieces = log.map((entry) => JSON.parse(entry.slice(entry.indexOf(':') + 1)) as HostEvent)
    assert.ok(pieces.every((piece) => piece.type === 'thinking' && piece.streamId === 'r1'))
    assert.equal(pieces.map((piece) => (piece as { text: string }).text).join(''), 'let me think')
  })

  void test('an interrupting event drains the backlog first, without waiting for frames', () => {
    const { pacer, log } = createHostPacer()
    pacer.enqueueText('s', 1, 'partial answer')
    pacer.enqueueLiveEvent('s', 2, { type: 'runtime', kind: 'error' })

    assert.deepEqual(log, ['text:partial answer', 'now:{"type":"runtime","kind":"error"}'])
  })

  void test('while pacing is suspended everything lands in order at once, including a held finish', () => {
    let suspended = false
    const { pacer, log } = createHostPacer({ suspended: () => suspended })
    pacer.enqueueText('s', 1, 'abc')
    pacer.enqueueLiveEvent('s', 2, { type: 'runtime', kind: 'done' })
    assert.deepEqual(log, [])

    suspended = true
    pacer.enqueueText('s', 3, 'def')
    assert.deepEqual(log, ['text:abc', 'now:{"type":"runtime","kind":"done"}', 'text:def'])

    pacer.enqueueLiveEvent('s', 4, { type: 'tool', id: 't2', step: 'done' })
    assert.equal(log.at(-1), 'live:{"type":"tool","id":"t2","step":"done"}')
  })

  void test('drain lands the backlog and the held finish right away', () => {
    const { pacer, log } = createHostPacer()
    pacer.enqueueText('s', 1, 'xyz')
    pacer.enqueueLiveEvent('s', 2, { type: 'runtime', kind: 'done' })
    pacer.drain('s')

    assert.deepEqual(log, ['text:xyz', 'now:{"type":"runtime","kind":"done"}'])
  })
})

void describe('chat stream pacer batching and settling', () => {
  void test('a burst of sub-agent events lands in one frame instead of one per frame', () => {
    const { pacer, frames, log } = createHostPacer()
    for (let n = 0; n < 40; n += 1) pacer.enqueueLiveEvent('s', n + 1, { type: 'worker', n })
    pacer.enqueueLiveEvent('s', 41, { type: 'tool', id: 't', step: 'done' })

    frames.step()
    assert.equal(log.length, 40, 'all queued worker events in the first frame')
    assert.ok(log.every((entry) => entry.startsWith('live:{"type":"worker"')))
    frames.step()
    assert.equal(log.at(-1), 'live:{"type":"tool","id":"t","step":"done"}', 'the tool behind them is not held back')
  })

  void test('reports pending output until the smooth finish has landed', () => {
    const { pacer, frames } = createHostPacer()
    assert.equal(pacer.hasPendingOutput('s'), false)
    pacer.enqueueText('s', 1, 'some text')
    pacer.enqueueLiveEvent('s', 2, { type: 'runtime', kind: 'done' })
    assert.equal(pacer.hasPendingOutput('s'), true)
    frames.runAll()
    assert.equal(pacer.hasPendingOutput('s'), false)
  })
})

void describe('chat stream pacer default classification', () => {
  void test('conversation stream events keep their pacing classes', () => {
    const classify = (event: unknown): ChatStreamPacerEventClass['kind'] =>
      classifyChatStreamEvent(event as ChatStreamEvent).kind

    assert.equal(classify({ type: 'end', payload: {} }), 'terminal')
    assert.equal(classify({ type: 'state', payload: { kind: 'done' } }), 'terminal')
    assert.equal(classify({ type: 'state', payload: { kind: 'aborted' } }), 'immediate')
    assert.equal(classify({ type: 'state', payload: { kind: 'awaiting-input' } }), 'immediate')
    assert.equal(classify({ type: 'state', payload: { kind: 'phase' } }), 'structural')
    assert.equal(classify({ type: 'error', payload: { message: 'x' } }), 'immediate')
    assert.equal(classify({ type: 'tool-call', payload: { toolCallId: 't' } }), 'tool')
    assert.equal(classify({ type: 'reasoning', payload: { id: 'r', text: 'x' } }), 'reasoning')
    assert.equal(classify({ type: 'worker-thread', payload: {} }), 'structural')
    const workerEvent: unknown = { type: 'worker-thread', payload: {} }
    assert.deepEqual(classifyChatStreamEvent(workerEvent as ChatStreamEvent), {
      kind: 'structural',
      batchKey: 'worker-thread',
    })
  })
})
