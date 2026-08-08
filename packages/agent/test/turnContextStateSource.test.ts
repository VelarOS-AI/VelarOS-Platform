import { describe, expect, test } from 'bun:test'

import {
  TurnContextLedger,
  TurnContextSessionLedgers,
} from '../src/agent/run-context/TurnContextLedger'

/**
 * 状态型 source 的「后来者取代」语义。
 *
 * 实测事故：游戏能力重建时如实记了一条「游戏已停止」，随后 game:run 记了运行态，
 * 两条一起投给下一回合 → 模型读了前一条，断定「游戏已经停止了，需要先启动它」。
 * 陈旧不是记错，是没失效。这一组把失效钉死，同时钉死事件型 source 不受影响。
 */

const SourceId = 'game.scene-state' as never

function peekLabels(ledger: TurnContextLedger, afterSeq = 0): string[] {
  return ledger.peek({ afterSeq, generation: null }).deltas.map((delta) => delta.label)
}

describe('state-like turn context sources supersede instead of accumulate', () => {
  test('replaceLatest keeps only the newest state', () => {
    const ledger = new TurnContextLedger(SourceId, 100)

    ledger.replaceLatest({ label: '游戏已停止', summaryText: '游戏运行态已停止。' })
    ledger.replaceLatest({ label: 'main · 1 个实体 · 可见 1', summaryText: '正在运行。' })

    // 从零 cursor 读：只应看到当前状态，绝不能同时看到「已停止」。
    expect(peekLabels(ledger)).toEqual(['main · 1 个实体 · 可见 1'])
  })

  test('a consumer that never read the stale state never sees it', () => {
    const ledger = new TurnContextLedger(SourceId, 100)

    ledger.replaceLatest({ label: '游戏已停止', summaryText: '停了。' })
    // 消费方还没 peek（cursor 仍在 0），此时新状态到达。
    ledger.replaceLatest({ label: '游戏正在运行', summaryText: '跑起来了。' })

    const labels = peekLabels(ledger)
    expect(labels).not.toContain('游戏已停止')
    expect(labels).toEqual(['游戏正在运行'])
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

    ledger.append({ label: '3 条游戏报错', summaryText: 'x' })
    ledger.append({ label: '游戏报错已清零', summaryText: 'y' })

    // 事件型 source 的行为一个字都不能变。
    expect(peekLabels(ledger)).toEqual(['3 条游戏报错', '游戏报错已清零'])
  })

  test('replaceLatest only clears the source it is called on', () => {
    const sceneState = new TurnContextSessionLedgers(SourceId, { notifyRenderer: false })
    const runtimeErrors = new TurnContextSessionLedgers('game.runtime-errors' as never, {
      notifyRenderer: false,
    })

    runtimeErrors.append('s1', { label: '3 条游戏报错', summaryText: 'x' })
    sceneState.replaceLatest('s1', { label: '游戏已停止', summaryText: 'a' })
    sceneState.replaceLatest('s1', { label: '游戏正在运行', summaryText: 'b' })

    // 另一个 source 的账本不受牵连（五源单 cursor 协议里各源账本互不相干）。
    expect(
      runtimeErrors.peek('s1', { afterSeq: 0, generation: null }).deltas.map((d) => d.label),
    ).toEqual(['3 条游戏报错'])
    expect(
      sceneState.peek('s1', { afterSeq: 0, generation: null }).deltas.map((d) => d.label),
    ).toEqual(['游戏正在运行'])
  })

  test('replaceLatest is scoped per session', () => {
    const sceneState = new TurnContextSessionLedgers(SourceId, { notifyRenderer: false })

    sceneState.replaceLatest('s1', { label: 's1 运行中', summaryText: 'a' })
    sceneState.replaceLatest('s2', { label: 's2 已停止', summaryText: 'b' })
    sceneState.replaceLatest('s1', { label: 's1 已停止', summaryText: 'c' })

    expect(
      sceneState.peek('s1', { afterSeq: 0, generation: null }).deltas.map((d) => d.label),
    ).toEqual(['s1 已停止'])
    expect(
      sceneState.peek('s2', { afterSeq: 0, generation: null }).deltas.map((d) => d.label),
    ).toEqual(['s2 已停止'])
  })
})
