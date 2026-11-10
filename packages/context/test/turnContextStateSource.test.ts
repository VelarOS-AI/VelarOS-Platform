import { describe, expect, test } from 'bun:test'

import type { TurnContextAppendBus } from '../src/contract/requires.js'
import { TurnContextLedger } from '../src/impl/TurnContextLedger'
import { TurnContextSessionLedgers } from '../src/impl/TurnContextSessionLedgers'

/**
 * 状态型 source 的「后来者取代」语义。
 *
 * 实测事故：运行能力重建时如实记了一条「服务已停止」，随后启动操作记了运行态，
 * 两条一起投给下一回合 → 模型读了前一条，断定「服务已经停止了，需要先启动它」。
 * 陈旧不是记错，是没失效。这一组把失效钉死，同时钉死事件型 source 不受影响。
 */

const SourceId = 'example.service-state' as never

function peekLabels(ledger: TurnContextLedger, afterSeq = 0): string[] {
  return ledger.peek({ afterSeq, generation: null }).deltas.map((delta) => delta.label)
}

test.each(['append', 'replaceLatest'] as const)(
  'an empty activity baseline retains the first real delta (%s)',
  (method) => {
    const ledgers = new TurnContextSessionLedgers(SourceId)
    const empty = ledgers.peek('first', { generation: null, afterSeq: 0 })
    expect(empty.deltas).toEqual([])
    expect(empty.tailSeq).toBe(0)
    const first = ledgers[method]('first', {
      label: 'first event',
      summaryText: 'first event body',
    })
    const next = ledgers.peek('first', { generation: empty.generation, afterSeq: empty.tailSeq })
    expect(next.deltas).toEqual([first])
    expect(next.tailSeq).toBe(first.seq)
    expect(
      ledgers.peek('first', { generation: next.generation, afterSeq: next.tailSeq }).deltas
    ).toEqual([])

    ledgers.clearSession('first')
    ledgers.append('first', { label: 'new ledger', summaryText: 'after a real retirement' })
    const retired = ledgers.peek('first', { generation: next.generation, afterSeq: next.tailSeq })
    expect(retired.generation).not.toBe(next.generation)
    expect(retired.deltas).toEqual([])
  }
)

describe('state-like turn context sources supersede instead of accumulate', () => {
  test('host append notifications depend on a structural bus rather than a concrete class', () => {
    const emitted: Array<[string, string]> = []
    const appendBus: TurnContextAppendBus = {
      subscribe: () => () => undefined,
      emit: (sessionId, sourceId) => emitted.push([sessionId, sourceId]),
    }
    const ledgers = new TurnContextSessionLedgers(SourceId, { appendHub: appendBus })

    ledgers.append('s1', { label: '运行中', summaryText: '正在运行。' })

    expect(emitted).toEqual([['s1', SourceId]])
  })

  test('replaceLatest keeps only the newest state', () => {
    const ledger = new TurnContextLedger(SourceId, 100)

    ledger.replaceLatest({ label: '服务已停止', summaryText: '服务运行态已停止。' })
    ledger.replaceLatest({ label: '服务正在运行', summaryText: '正在运行。' })

    // 从零 cursor 读：只应看到当前状态，绝不能同时看到「已停止」。
    expect(peekLabels(ledger)).toEqual(['服务正在运行'])
  })

  test('a consumer that never read the stale state never sees it', () => {
    const ledger = new TurnContextLedger(SourceId, 100)

    ledger.replaceLatest({ label: '服务已停止', summaryText: '停了。' })
    // 消费方还没 peek（cursor 仍在 0），此时新状态到达。
    ledger.replaceLatest({ label: '服务正在运行', summaryText: '跑起来了。' })

    const labels = peekLabels(ledger)
    expect(labels).not.toContain('服务已停止')
    expect(labels).toEqual(['服务正在运行'])
  })

  test('seq keeps advancing so an old cursor still receives the new state', () => {
    const ledger = new TurnContextLedger(SourceId, 100)

    const first = ledger.replaceLatest({ label: '状态一', summaryText: 'a' })
    const consumed = ledger.peek({ afterSeq: 0, generation: null })
    expect(consumed.deltas.map((d) => d.label)).toEqual(['状态一'])

    const second = ledger.replaceLatest({ label: '状态二', summaryText: 'b' })
    expect(second.seq).toBeGreaterThan(first.seq)
    // 拿着「已读到 first」的 cursor 再来，必须读到 second。
    expect(peekLabels(ledger, first.seq)).toEqual(['状态二'])
  })

  test('superseding is not reported as a ring-buffer gap', () => {
    const ledger = new TurnContextLedger(SourceId, 100)

    ledger.replaceLatest({ label: '状态一', summaryText: 'a' })
    ledger.replaceLatest({ label: '状态二', summaryText: 'b' })

    // 取代 ≠ 装不下漏看了：不许向消费方报缺口。
    expect(ledger.peek({ afterSeq: 0, generation: null }).droppedBeforeSeq).toBeUndefined()
  })

  test('append still accumulates for event-like sources', () => {
    const ledger = new TurnContextLedger(SourceId, 100)

    const inspect = { tool: 'inspect', argsHint: { opaque: () => true } }
    const first = ledger.append({ label: '3 条运行错误', summaryText: 'x', inspect })
    first.seq = 999
    first.summaryText = 'caller changed the returned body'
    first.inspect!.tool = 'caller changed the returned tool'
    inspect.tool = 'caller changed the input tool'
    const snapshot = ledger.peek({ afterSeq: 0, generation: null })
    expect(snapshot.deltas[0]).toMatchObject({
      seq: 1,
      summaryText: 'x',
      inspect: { tool: 'inspect' },
    })
    expect(snapshot.deltas[0].inspect!.argsHint!.opaque).toBe(inspect.argsHint.opaque)
    snapshot.deltas[0].label = 'caller changed a peek'
    snapshot.deltas[0].seq = 1000
    snapshot.deltas[0].inspect!.tool = 'caller changed the peek tool'
    ledger.append({ label: '运行错误已清零', summaryText: 'y' })

    // 事件型 source 的行为一个字都不能变。
    expect(peekLabels(ledger)).toEqual(['3 条运行错误', '运行错误已清零'])
    expect(ledger.peek({ afterSeq: 0, generation: null }).deltas[0]).toMatchObject({
      seq: 1,
      summaryText: 'x',
      inspect: { tool: 'inspect' },
    })
  })

  test('replaceLatest only clears the source it is called on', () => {
    const sceneState = new TurnContextSessionLedgers(SourceId, { notifyRenderer: false })
    const runtimeErrors = new TurnContextSessionLedgers('example.runtime-errors' as never, {
      notifyRenderer: false,
    })

    runtimeErrors.append('s1', { label: '3 条运行错误', summaryText: 'x' })
    sceneState.replaceLatest('s1', { label: '服务已停止', summaryText: 'a' })
    sceneState.replaceLatest('s1', { label: '服务正在运行', summaryText: 'b' })

    // 另一个 source 的账本不受牵连（五源单 cursor 协议里各源账本互不相干）。
    expect(
      runtimeErrors.peek('s1', { afterSeq: 0, generation: null }).deltas.map((d) => d.label)
    ).toEqual(['3 条运行错误'])
    expect(
      sceneState.peek('s1', { afterSeq: 0, generation: null }).deltas.map((d) => d.label)
    ).toEqual(['服务正在运行'])
  })

  test('replaceLatest is scoped per session', () => {
    const sceneState = new TurnContextSessionLedgers(SourceId, { notifyRenderer: false })

    sceneState.replaceLatest('s1', { label: 's1 运行中', summaryText: 'a' })
    sceneState.replaceLatest('s2', { label: 's2 已停止', summaryText: 'b' })
    sceneState.replaceLatest('s1', { label: 's1 已停止', summaryText: 'c' })

    expect(
      sceneState.peek('s1', { afterSeq: 0, generation: null }).deltas.map((d) => d.label)
    ).toEqual(['s1 已停止'])
    expect(
      sceneState.peek('s2', { afterSeq: 0, generation: null }).deltas.map((d) => d.label)
    ).toEqual(['s2 已停止'])
  })
})
