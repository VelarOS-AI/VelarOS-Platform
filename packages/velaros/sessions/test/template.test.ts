// 通过 nodeSubprocessCodeRunner 执行模型程序的用例仅适用 POSIX；直接端口测试在所有平台运行。
/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 这里把模版的每个函数接在假宿主上，经真的代码面会话调一遍——和模型交程序是同一条路。
 * 两个对话各跑一遍：一个里已经有浏览器会话和后端项目的会话（交给它们），一个里只有自己（开新会话）。
 */

import { describe, expect, test } from 'bun:test'

import type { SessionAnswer, SessionAskInput, SessionPeer } from '../index'
import { sessionsOperations, VelarSessionsModule } from '../index'
import { DefaultPeers, failureOf, runModelProgram, sessionsSpace } from '../spec/support'

const it = test.skipIf(process.platform === 'win32')

/** 后端项目的会话：正在跑，允许向当前运行追加引导。 */
const BackendPeer: SessionPeer = {
  id: 'project-2',
  workspace: 'project',
  title: '商城后端',
  root: '/home/me/shop-api',
  site: null,
  running: true,
  self: false,
}

/** 同一前端项目的另一个会话，不能把当前发问会话当成这个同伴。 */
const FrontendPeer: SessionPeer = {
  ...BackendPeer,
  id: 'project-web-peer',
  title: '前端同伴',
  root: '/home/me/shop-web',
}

/** 假宿主的回答：下单停在付款前问一句，答复之后做完；项目里的活都做完了，回一张表。 */
async function answerOf(input: SessionAskInput): Promise<SessionAnswer> {
  const session = input.to ?? `${input.workspace}-new`
  if (input.workspace === 'browser' || session.startsWith('browser'))
    return input.task.includes('答复是')
      ? { session, status: 'completed', answer: '订单号 JD123', reason: null }
      : { session, status: 'waiting', answer: '到付款了，要付吗？', reason: null }
  return { session, status: 'completed', answer: `${session} 的接口表`, reason: null }
}

/** 这两次都要跑的那几个函数。 */
const Program = `${VelarSessionsModule.template}
export const order = await placeOrder()
export const done = await answerQuestion(order.session)
export const compared = await compareProjects()
export const notified = await notifyProjects()
`

describe('代码模版', () => {
  test('INV-9 假宿主按真实寻址边界拒绝 ask/tell 自己，不调用结果生产者', async () => {
    let delivered = false
    const space = sessionsSpace({
      answer: async (input) => {
        delivered = true
        return answerOf(input)
      },
      told: async (input) => {
        delivered = true
        return { session: input.to, status: 'queued' }
      },
    })
    expect(
      (await failureOf(sessionsOperations.ask({ to: 'project-1', task: '查接口' }, space.context)))
        .code
    ).toBe('VALIDATION')
    expect(
      (
        await failureOf(
          sessionsOperations.tell({ to: 'project-1', message: '改方向' }, space.context)
        )
      ).code
    ).toBe('VALIDATION')
    expect(delivered).toBe(false)
  })

  it('INV-9 已有合适同伴时复用；通知只交给活动项目，跳过空闲项目与自己', async () => {
    const space = sessionsSpace({
      peers: [
        ...DefaultPeers,
        FrontendPeer,
        BackendPeer,
        { ...BackendPeer, id: 'project-idle', root: '/home/me/idle', running: false },
      ],
      answer: answerOf,
      told: async (input) => ({ session: input.to, status: 'queued' }),
    })
    const outcome = await runModelProgram(space, Program, 60_000)
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.order).toEqual({ session: 'browser-1', question: '到付款了，要付吗？' })
    expect(values.done).toEqual({ status: 'completed', answer: '订单号 JD123' })
    expect(values.compared).toEqual({ web: 'project-web-peer 的接口表', api: 'project-2 的接口表' })
    expect(values.notified).toEqual([
      { session: 'project-web-peer', status: 'queued' },
      { session: 'project-2', status: 'queued' },
    ])
    expect(space.record.tells.map(({ input }) => input.to)).toEqual([
      'project-web-peer',
      'project-2',
    ])
    expect(space.record.asks.map(({ input }) => input.to)).toEqual([
      'browser-1',
      'browser-1',
      'project-web-peer',
      'project-2',
    ])
  }, 90_000)

  it('INV-9 对话里只有自己：开浏览器会话，前后端都按 project/root 创建同组同伴', async () => {
    const space = sessionsSpace({ peers: [DefaultPeers[0]!], answer: answerOf })
    const outcome = await runModelProgram(space, Program, 60_000)
    expect(outcome.failed).toBeUndefined()
    const values = outcome.value as Record<string, any>
    expect(values.order).toEqual({ session: 'browser-new', question: '到付款了，要付吗？' })
    expect(space.record.asks[0]!.input).toMatchObject({
      workspace: 'browser',
      site: 'https://www.jd.com/',
    })
    expect(space.record.asks[2]!.input).toMatchObject({
      workspace: 'project',
      root: '/home/me/shop-web',
    })
    expect(space.record.asks[3]!.input).toMatchObject({
      workspace: 'project',
      root: '/home/me/shop-api',
    })
    expect(space.record.asks.some(({ input }) => input.to === 'project-1')).toBe(false)
    expect(values.compared).toEqual({ web: 'project-new 的接口表', api: 'project-new 的接口表' })
    expect(values.notified).toEqual([])
  }, 90_000)
})
