/**
 * 四个操作的实现细节：交给后端的证据只带给了的字段、get 与召回同形、取消的调用不碰端口。
 * 对外承诺在 spec/acceptance.test.ts；这里钉的是承诺之下的具体写法。
 */
import { describe, expect, test } from 'bun:test'

import { memoryOperations } from '../index.js'
import { failureOf, memorySpace, recallItem, spyStore } from '../spec/support.js'

describe('写入', () => {
  test('交给后端的证据：没给的摘要、来源、标签、任务键落缺省值，给了的原样带上', async () => {
    const spy = spyStore()
    await memorySpace(spy.port).call('save', { kind: 'task', title: '重构记忆系统', content: '先做后端内核。', taskKey: 'memory-refactor' })
    expect(spy.captured[0]?.metadata).toMatchObject({ summary: '', source: '记忆工具', tags: [], taskKey: 'memory-refactor' })
    expect(spy.captured[0]?.privacyClass).toBe('standard')
    await memorySpace(spy.port).call('save', { kind: 'preference', title: '回复风格', content: '先给结论。' })
    expect(spy.captured[1]?.privacyClass).toBe('personal')
  })
})

describe('读', () => {
  test('get 交回的形状与召回的每一条一样', async () => {
    const item = recallItem('m-1', { sourceTypes: undefined })
    const spy = spyStore({ pages: [[item]], known: [item] })
    const space = memorySpace(spy.port)
    const found = await space.call('search', { query: 'x' })
    const read = await space.call('get', { id: 'm-1' })
    expect(read).toEqual(found.memories[0])
    expect(read.sourceTypes).toEqual([])
  })
})

describe('取消', () => {
  test('已经取消的调用不碰端口', async () => {
    const spy = spyStore({ known: [recallItem('m-1')] })
    const controller = new AbortController()
    controller.abort()
    const context = { ...memorySpace(spy.port).context, abortSignal: controller.signal }
    await failureOf(memoryOperations.save({ kind: 'fact', title: 't', content: 'c' }, context))
    await failureOf(memoryOperations.search({}, context))
    await failureOf(memoryOperations.get({ id: 'm-1' }, context))
    await failureOf(memoryOperations.archive({ id: 'm-1' }, context))
    expect([spy.captured, spy.recalls, spy.reads, spy.archives]).toEqual([[], [], [], []])
  })
})
