// 用途：钉住外部浏览器页面的框架怎么列、怎么进：跨进程 iframe 的子会话第一次要框架时才挂、一层层往下挂、没了就划掉；
// 子会话上的框架树接到顶层那棵上，crossOrigin 按页面顶层的源算；在子框架里跑脚本走框架自己的主世界
// （子会话的顶层框架直接 Runtime.evaluate，同进程的子框架经 DOM 拿到 document 再 callFunctionOn），框架没了抛 BROWSER_FRAME_NOT_FOUND。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { BrowserErrorCodes } from '../../contract/constants.js'
import { CdpFrameSessions } from '../../impl/cdp/CdpFrameSessions.js'
import type { CdpBrowserPageDriverTransport } from '../../types/cdp.js'

function frame(id: string, url: string, parentId?: string): Record<string, string> {
  const described: Record<string, string> = {
    id,
    url,
    name: '',
    securityOrigin: new URL(url).origin,
  }
  if (parentId) described.parentId = parentId
  return described
}

/**
 * 一个假的外部页面：顶层 a.test 里套一个同源子框架与一个跨进程的 b.test iframe，b.test 里再套回 a.test。
 * Target.setAutoAttach 在回包之前把这一层已有的 iframe 挂上（和 Chrome 一样）。
 */
function createPage() {
  const sent: Array<{ method: string; params: any; sessionId: Optional<string> }> = []
  const listeners = new Set<
    (method: string, params: unknown, sessionId: Optional<string>) => void
  >()
  const emit = (method: string, params: unknown, sessionId?: string) =>
    listeners.forEach((listener) => listener(method, params, sessionId))
  const trees: Record<string, unknown> = {
    root: {
      frame: frame('top', 'https://a.test/'),
      childFrames: [{ frame: frame('same', 'https://a.test/inner', 'top') }],
    },
    'session-b': { frame: frame('oopif', 'https://b.test/frame', 'top') },
    'session-c': { frame: frame('nested', 'https://a.test/nested', 'oopif') },
  }
  const children: Record<string, string[]> = {
    root: ['session-b'],
    'session-b': ['session-c'],
    'session-c': [],
  }
  const gone = new Set<string>()
  const transport: CdpBrowserPageDriverTransport = {
    send: async <T>(method: string, params: any = {}, sessionId?: string): Promise<T> => {
      sent.push({ method, params, sessionId })
      const session = sessionId ?? 'root'
      if (gone.has(session)) throw new Error(`No session with given id ${session}`)
      if (method === 'Target.setAutoAttach') {
        for (const child of children[session])
          emit(
            'Target.attachedToTarget',
            { sessionId: child, targetInfo: { type: 'iframe' } },
            sessionId
          )
        return {} as T
      }
      if (method === 'Page.getFrameTree') return { frameTree: trees[session] } as T
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 7 } as T
      if (method === 'DOM.describeNode')
        return { node: { contentDocument: { backendNodeId: 8 } } } as T
      if (method === 'DOM.resolveNode') return { object: { objectId: 'document-8' } } as T
      if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn')
        return { result: { type: 'string', value: `${method}@${session}` } } as T
      return {} as T
    },
    onAnyEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    transport,
    sent,
    emit,
    drop: (session: string) => gone.add(session),
    listenerCount: () => listeners.size,
  }
}

describe('CdpFrameSessions', () => {
  test('跨进程 iframe 的子会话一层层挂上，框架树接成一张表，crossOrigin 按页面顶层的源算', async () => {
    const page = createPage()
    const frames = new CdpFrameSessions(page.transport)
    assert.equal(page.sent.length, 0, '没要框架之前一条命令都不发')

    const listed = await frames.listFrames()
    assert.deepEqual(
      listed.map((entry) => [
        entry.info.id,
        entry.info.parentId,
        entry.info.crossOrigin,
        entry.session,
        entry.sessionRoot,
      ]),
      [
        ['top', null, false, null, true],
        ['same', 'top', false, null, false],
        ['oopif', 'top', true, 'session-b', true],
        ['nested', 'oopif', false, 'session-c', true],
      ]
    )
    // 挂接只开一次：再列一次不再发 setAutoAttach。
    await frames.listFrames()
    assert.equal(page.sent.filter((call) => call.method === 'Target.setAutoAttach').length, 3)
    assert.deepEqual(page.sent.find((call) => call.method === 'Target.setAutoAttach')?.params, {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    })
  })

  test('子会话的顶层框架直接在那条会话上求值；同进程的子框架经 DOM 拿到 document，在它上面调，用完释放', async () => {
    const page = createPage()
    const frames = new CdpFrameSessions(page.transport)
    const listed = await frames.listFrames()
    const byId = (id: string) => listed.find((entry) => entry.info.id === id)!

    assert.equal(
      await frames.evaluateInFrame(byId('oopif'), '1 + 1', false),
      'Runtime.evaluate@session-b'
    )
    assert.equal(
      await frames.evaluateInFrame(byId('same'), '(async () => 1)()', true),
      'Runtime.callFunctionOn@root'
    )
    const call = page.sent.find((entry) => entry.method === 'Runtime.callFunctionOn')!
    assert.equal(call.params.objectId, 'document-8')
    assert.equal(call.params.userGesture, true)
    assert.match(
      call.params.functionDeclaration,
      /^async function \(\) \{ return await \(\(async \(\) => 1\)\(\)\n\) \}$/,
      'script 的第一行还在第一行'
    )
    assert.ok(
      page.sent.some(
        (entry) =>
          entry.method === 'Runtime.releaseObject' && entry.params.objectId === 'document-8'
      )
    )
  })

  test('子会话没了就划掉；列框架时读不到的那条跳过，框架已经不在的抛 BROWSER_FRAME_NOT_FOUND', async () => {
    const page = createPage()
    const frames = new CdpFrameSessions(page.transport)
    const listed = await frames.listFrames()

    page.emit('Target.detachedFromTarget', { sessionId: 'session-c' }, 'session-b')
    assert.deepEqual(
      (await frames.listFrames()).map((entry) => entry.info.id),
      ['top', 'same', 'oopif']
    )

    page.drop('session-b')
    assert.deepEqual(
      (await frames.listFrames()).map((entry) => entry.info.id),
      ['top', 'same']
    )

    page.drop('root')
    const same = listed.find((entry) => entry.info.id === 'same')!
    await assert.rejects(
      frames.evaluateInFrame(same, '1', false),
      (error: { code?: string }) => error.code === BrowserErrorCodes.frameNotFound
    )
  })

  test('dispose 退订', async () => {
    const page = createPage()
    const frames = new CdpFrameSessions(page.transport)
    await frames.listFrames()
    assert.equal(page.listenerCount(), 1)
    frames.dispose()
    assert.equal(page.listenerCount(), 0)
  })
})
