/**
 * 会话之间交活、传话的验收测试：每一条对应 spec/invariants.md 里的一个编号。只测对外承诺的行为，实现细节的测试在 test/ 目录。
 * 宿主用 `spec/support.ts` 的假宿主：会话表、ask 与 tell 怎么回都能按用例换，收到的入参与取消信号都记下来。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { VelarSessionsModule } from '../contract/surface'
import type { SessionAnswer, SessionTold } from '../index'
import { SessionsErrorCodes, sessionsOperations, SessionWorkspaces } from '../index'

import {
  DefaultPeers,
  failureOf,
  pendingUntilAborted,
  runModelProgram,
  SessionsDeclarations,
  sessionsSpace,
  typecheckTemplate,
} from './support'

describe('交给宿主的东西', () => {
  test('INV-1 list 不收入参，照宿主的原样交回这个对话里的会话，宿主调一次', async () => {
    const space = sessionsSpace()
    const peers = await sessionsOperations.list(space.context)
    expect(peers).toBe(DefaultPeers)
    expect(peers.filter((peer) => peer.self).map((peer) => peer.id)).toEqual(['project-1'])
    expect(space.record.lists).toBe(1)
  })

  test('INV-2 交给已有的会话：to 去掉首尾空白，task 原样，对象上只有 to 与 task', async () => {
    const space = sessionsSpace()
    const task = '  在京东上买一包 A4 纸，付款前停下来问我。\n'
    await sessionsOperations.ask({ to: '  browser-1\t', task }, space.context)
    expect(space.record.asks.map(({ input }) => input)).toStrictEqual([{ to: 'browser-1', task }])
    // 空白的 root、site 当作没给：只要 to 就够了
    await sessionsOperations.ask(
      { to: 'system-1', root: '   ', site: '', task: '整理下载目录' },
      space.context
    )
    expect(space.record.asks[1]!.input).toStrictEqual({ to: 'system-1', task: '整理下载目录' })
  })

  test('INV-3 开新会话：三种工作区各带各的东西，root 与 site 规范好，没给的字段不在对象上', async () => {
    const space = sessionsSpace()
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { workspace: 'project', root: '  /home/me/shop-api  ', task: '查接口' },
        { workspace: 'project', root: '/home/me/shop-api', task: '查接口' },
      ],
      [
        { workspace: 'project', root: 'D:\\work\\shop', task: '查接口' },
        { workspace: 'project', root: 'D:\\work\\shop', task: '查接口' },
      ],
      [
        { workspace: 'project', root: 'c:/work/shop', task: '查接口' },
        { workspace: 'project', root: 'c:/work/shop', task: '查接口' },
      ],
      [
        { workspace: 'project', root: '\\\\fileserver\\share\\shop', task: '查接口' },
        { workspace: 'project', root: '\\\\fileserver\\share\\shop', task: '查接口' },
      ],
      [
        { workspace: 'browser', site: ' https://WWW.JD.com ', task: '下单' },
        { workspace: 'browser', site: 'https://www.jd.com/', task: '下单' },
      ],
      [
        { workspace: 'browser', task: '下单' },
        { workspace: 'browser', task: '下单' },
      ],
      [
        { workspace: 'system', task: '整理下载目录' },
        { workspace: 'system', task: '整理下载目录' },
      ],
      // 空白的 to 当作没给、null 的字段当作没给
      [
        { to: '  ', workspace: ' system ', root: null, site: null, task: '整理下载目录' },
        { workspace: 'system', task: '整理下载目录' },
      ],
    ]
    for (const [input] of cases) await sessionsOperations.ask(input as never, space.context)
    expect(space.record.asks.map(({ input }) => input)).toStrictEqual(
      cases.map(([, expected]) => expected)
    )
    // 新开的会话在回答里交回它的 id
    const opened = await sessionsOperations.ask(
      { workspace: 'system', task: '看看磁盘' },
      space.context
    )
    expect(opened.session).toBe('system-new')
  })

  test('INV-4 宿主交回的结果原样交回，宿主拒绝时的错误原样抛出', async () => {
    const answers: SessionAnswer[] = [
      { session: 'browser-1', status: 'completed', answer: '下好单了：订单 123', reason: null },
      { session: 'browser-1', status: 'failed', answer: '', reason: '网站要求重新登录' },
      { session: 'browser-1', status: 'cancelled', answer: '', reason: '用户停了' },
      { session: 'browser-1', status: 'waiting', answer: '要付款吗？', reason: null },
    ]
    for (const answer of answers) {
      const space = sessionsSpace({ answer: async () => answer })
      expect(await sessionsOperations.ask({ to: 'browser-1', task: '下单' }, space.context)).toBe(
        answer
      )
    }
    for (const status of ['delivered', 'queued'] as const) {
      const told: SessionTold = { session: 'browser-1', status }
      const space = sessionsSpace({ told: async () => told })
      expect(
        await sessionsOperations.tell({ to: 'browser-1', message: '换个地址' }, space.context)
      ).toBe(told)
    }

    const refusal = new AppError('SESSIONS_DEADLOCK', 'browser-1 正在等你回答，不能反过来等它')
    const refusing = sessionsSpace({
      answer: async () => {
        throw refusal
      },
    })
    let thrown: unknown = null
    try {
      await sessionsOperations.ask({ to: 'browser-1', task: '下单' }, refusing.context)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(refusal)
    const stranger = sessionsSpace({
      told: async () => {
        throw new AppError('SESSIONS_NOT_IN_CONVERSATION', 'other-9 不在这个对话里')
      },
    })
    expect(
      await failureOf(sessionsOperations.tell({ to: 'other-9', message: 'x' }, stranger.context))
    ).toEqual({ code: 'SESSIONS_NOT_IN_CONVERSATION', message: 'other-9 不在这个对话里' })
  })

  test('INV-5 tell：to 去掉首尾空白，message 原样，对象上只有 to 与 message', async () => {
    const space = sessionsSpace()
    const message = '  订单接口改成了 /api/v2/orders\n'
    const told = await sessionsOperations.tell({ to: ' project-2 ', message }, space.context)
    expect(space.record.tells.map(({ input }) => input)).toStrictEqual([
      { to: 'project-2', message },
    ])
    expect(told).toEqual({ session: 'project-2', status: 'delivered' })
  })
})

describe('入参核对', () => {
  test('INV-6 入参不对抛 SessionsErrorCodes 里的码，message 点名字段，宿主一次都不调', async () => {
    const space = sessionsSpace()
    const codes = SessionsErrorCodes
    const asks: Array<[unknown, string, string]> = [
      [null, codes.inputInvalid, '对象'],
      ['下单', codes.inputInvalid, '对象'],
      [{ to: 'browser-1', task: '下单', engine: 'x' }, codes.inputInvalid, '不认 engine'],
      [{ to: 42, task: '下单' }, codes.inputInvalid, 'to 要是字符串'],
      [{ to: 'browser-1', task: 7 }, codes.inputInvalid, 'task 要是字符串'],
      [{ to: 'browser-1' }, codes.taskEmpty, 'task 是空的'],
      [{ to: 'browser-1', task: ' \n\t ' }, codes.taskEmpty, 'task 是空的'],
      [{ task: '下单' }, codes.targetMissing, '没说交给谁'],
      [{ to: '  ', task: '下单' }, codes.targetMissing, '没说交给谁'],
      [{ to: 'browser-1', workspace: 'browser', task: '下单' }, codes.targetConflict, '只能给一个'],
      [{ workspace: 'cloud', task: '下单' }, codes.workspaceUnknown, 'project、system、browser'],
      [{ workspace: 'project', task: '查接口' }, codes.rootInvalid, '要给 root'],
      [{ workspace: 'project', root: 'shop-api', task: '查接口' }, codes.rootInvalid, '绝对路径'],
      [{ workspace: 'project', root: '~/shop-api', task: '查接口' }, codes.rootInvalid, '绝对路径'],
      [{ workspace: 'project', root: 'C:work', task: '查接口' }, codes.rootInvalid, '绝对路径'],
      [{ workspace: 'project', root: '\\work', task: '查接口' }, codes.rootInvalid, '绝对路径'],
      [{ workspace: 'browser', site: 'www.jd.com', task: '下单' }, codes.siteInvalid, 'http'],
      [
        { workspace: 'browser', site: 'file:///etc/hosts', task: '下单' },
        codes.siteInvalid,
        'http',
      ],
      [
        { to: 'browser-1', site: 'https://www.jd.com', task: '下单' },
        codes.optionMismatch,
        '只要 to',
      ],
      [{ to: 'project-2', root: '/home/me/x', task: '查' }, codes.optionMismatch, '只要 to'],
      [
        { workspace: 'system', root: '/home/me/x', task: '查' },
        codes.optionMismatch,
        'root 只给 project',
      ],
      [
        { workspace: 'browser', root: '/home/me/x', task: '查' },
        codes.optionMismatch,
        'root 只给 project',
      ],
      [
        { workspace: 'project', root: '/home/me/x', site: 'https://a.com', task: '查' },
        codes.optionMismatch,
        'site 只给 browser',
      ],
      [
        { workspace: 'system', site: 'https://a.com', task: '查' },
        codes.optionMismatch,
        'site 只给 browser',
      ],
    ]
    for (const [input, code, says] of asks) {
      const failure = await failureOf(sessionsOperations.ask(input as never, space.context))
      expect({ input, code: failure.code, says: failure.message.includes(says) }).toEqual({
        input,
        code,
        says: true,
      })
    }
    const tells: Array<[unknown, string, string]> = [
      [undefined, codes.inputInvalid, '对象'],
      [{ to: 'browser-1', message: 'x', urgent: true }, codes.inputInvalid, '不认 urgent'],
      [{ to: 'browser-1', message: ['x'] }, codes.inputInvalid, 'message 要是字符串'],
      [{ to: 'browser-1' }, codes.messageEmpty, 'message 是空的'],
      [{ to: 'browser-1', message: '   ' }, codes.messageEmpty, 'message 是空的'],
      [{ message: '换地址' }, codes.targetMissing, '没说传给谁'],
      [{ to: ' ', message: '换地址' }, codes.targetMissing, '没说传给谁'],
    ]
    for (const [input, code, says] of tells) {
      const failure = await failureOf(sessionsOperations.tell(input as never, space.context))
      expect({ input, code: failure.code, says: failure.message.includes(says) }).toEqual({
        input,
        code,
        says: true,
      })
    }
    expect(space.record).toEqual({ lists: 0, asks: [], tells: [] })
  })

  test('INV-7 取消：之前就取消的不调宿主；取消信号原样交给宿主；宿主还没回时一取消就以取消原因失败', async () => {
    const before = new AbortController()
    before.abort(new AppError('ABORTED', '用户没等它开始就停了'))
    const idle = sessionsSpace({ abortSignal: before.signal })
    for (const call of [
      sessionsOperations.list(idle.context),
      sessionsOperations.ask({ to: 'browser-1', task: '下单' }, idle.context),
      sessionsOperations.tell({ to: 'browser-1', message: 'x' }, idle.context),
    ])
      expect(await failureOf(call)).toEqual({ code: 'ABORTED', message: '用户没等它开始就停了' })
    expect(idle.record).toEqual({ lists: 0, asks: [], tells: [] })

    // 宿主守约：收到的就是上下文的那个信号，一取消宿主那边以取消原因失败
    const polite = new AbortController()
    const honoring = sessionsSpace({
      abortSignal: polite.signal,
      answer: (_input, signal) => pendingUntilAborted(signal),
    })
    const asked = failureOf(
      sessionsOperations.ask({ workspace: 'system', task: '慢活' }, honoring.context)
    )
    expect(honoring.record.asks[0]!.signal).toBe(polite.signal)
    polite.abort(new AppError('ABORTED', '用户中途停了'))
    expect(await asked).toEqual({ code: 'ABORTED', message: '用户中途停了' })

    // 宿主不理取消：本单元也不陪它等，照样以取消原因失败
    const stubborn = new AbortController()
    const ignoring = sessionsSpace({
      abortSignal: stubborn.signal,
      answer: (_input, signal) => pendingUntilAborted(signal, false),
      told: (_input, signal) => pendingUntilAborted(signal, false),
    })
    const waiting = failureOf(
      sessionsOperations.ask({ to: 'browser-1', task: '下单' }, ignoring.context)
    )
    const telling = failureOf(
      sessionsOperations.tell({ to: 'browser-1', message: '换地址' }, ignoring.context)
    )
    stubborn.abort(new AppError('ABORTED', '不等了'))
    expect(await waiting).toEqual({ code: 'ABORTED', message: '不等了' })
    expect(await telling).toEqual({ code: 'ABORTED', message: '不等了' })
    expect(ignoring.record.tells[0]!.signal).toBe(stubborn.signal)
  })
})

describe('代码面 sessions 命名空间', () => {
  test('INV-8 模型写的程序照生成的声明调到真实操作：list、同时 ask 两件、tell；失败时程序接得住 error.code', async () => {
    const space = sessionsSpace()
    const result = await runModelProgram(
      space,
      `import { ask, list, tell } from 'velaros:sessions'

const peers = await list()
const browser = peers.find((peer) => peer.workspace === 'browser')
const [order, disk] = await Promise.all([
  ask({ to: browser.id, task: '下单' }),
  ask({ workspace: 'system', task: '看看磁盘' }),
])
const told = await tell({ to: ' system-1 ', message: '磁盘满了就清缓存' })
let refused
try {
  await ask({ workspace: 'project', root: 'relative/path', task: '查' })
} catch (error) {
  refused = error.code
}
export default { self: peers.find((peer) => peer.self).id, order: order.status, opened: disk.session, told, refused }`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual({
      self: 'project-1',
      order: 'completed',
      opened: 'system-new',
      told: { session: 'system-1', status: 'delivered' },
      refused: SessionsErrorCodes.rootInvalid,
    })
    expect(space.record.asks.map(({ input }) => input)).toEqual([
      { to: 'browser-1', task: '下单' },
      { workspace: 'system', task: '看看磁盘' },
    ])
  }, 60_000)
})

describe('模型面', () => {
  test('INV-9 代码模版整份照真实声明过类型检查；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(fileURLToPath(new URL('../template.js', import.meta.url)), 'utf8')
    expect(typecheckTemplate(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarSessionsModule.template).toBe(template.trim())
    expect(SessionsDeclarations).not.toContain('的代码模版')
  })

  test('INV-10 三个操作都没有效果；list 不收入参、哪儿都能调，ask 与 tell 只在 execute 里调；工作区与常量表一致；端口不进模型面', () => {
    expect(VelarSessionsModule.specifier).toBe('velaros:sessions')
    expect(VelarSessionsModule.methods).toEqual(['list', 'ask', 'tell'])
    const operations = VelarSessionsModule.operations
    expect([operations.list.effects, operations.ask.effects, operations.tell.effects]).toEqual([
      'none',
      'none',
      'none',
    ])
    expect(operations.list.hasInput).toBe(false)
    expect('allowedModes' in operations.list).toBe(false)
    expect(operations.ask.allowedModes).toEqual(['execute'])
    expect(operations.tell.allowedModes).toEqual(['execute'])
    expect(
      [...SessionsDeclarations.matchAll(/export function (\w+)\(([^)]*)\)/gu)].map((match) => [
        match[1],
        match[2],
      ])
    ).toEqual([
      ['list', ''],
      ['ask', 'input: SessionAskInput'],
      ['tell', 'input: SessionTellInput'],
    ])
    const union = /type SessionWorkspace = (.+)\n/u.exec(SessionsDeclarations)?.[1]
    expect(union?.split(' | ').map((member) => member.replaceAll("'", ''))).toEqual([
      ...SessionWorkspaces,
    ])
    for (const name of [
      'SessionsSpacePort',
      'SessionsOperationContext',
      'abortSignal',
      'AbortSignal',
    ])
      expect({ name, shown: new RegExp(`\\b${name}\\b`, 'u').test(SessionsDeclarations) }).toEqual({
        name,
        shown: false,
      })
  })
})
