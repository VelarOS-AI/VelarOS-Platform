// 模板通过真实代码面运行；Node 子进程执行在 POSIX 验收。
import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { sessionsOperations, VelarSessionsModule } from '../index'
import { DefaultPeers, failureOf, runModelProgram, sessionsSpace } from '../spec/support'

const it = test.skipIf(process.platform === 'win32')

describe('会话协作模板', () => {
  test('INV-9 假宿主拒绝向自身发送任务或引导，不进入结果生产者', async () => {
    let delivered = false
    const space = sessionsSpace({
      answer: async () => {
        delivered = true
        throw new AppError('INVARIANT', 'Unreachable test producer')
      },
      told: async () => {
        delivered = true
        throw new AppError('INVARIANT', 'Unreachable test producer')
      },
    })
    expect(
      (await failureOf(sessionsOperations.ask({ to: 'project-1', task: '核验' }, space.context)))
        .code
    ).toBe('VALIDATION')
    expect(
      (
        await failureOf(
          sessionsOperations.tell({ to: 'project-1', message: '核验' }, space.context)
        )
      ).code
    ).toBe('VALIDATION')
    expect(delivered).toBe(false)
  })

  it('INV-9 模板只寻址现有会话，支持等待回答、并行任务与活动运行引导', async () => {
    const space = sessionsSpace({
      peers: DefaultPeers,
      answer: async ({ to, task }) => ({
        session: to,
        status: task === '核验订单' ? 'waiting' : 'completed',
        answer: task === '核验订单' ? '需要确认地址' : to,
        reason: null,
      }),
    })
    const result = await runModelProgram(
      space,
      `${VelarSessionsModule.template}
export const waiting = await delegateTask('browser-1', '核验订单')
export const continued = await answerQuestion(waiting.session, '沿用默认地址')
export const compared = await compareTasks('browser-1', 'system-1')
export const notified = await notifyRunning('按新接口定义继续工作')
`,
      60_000
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual({
      waiting: { session: 'browser-1', question: '需要确认地址' },
      continued: { session: 'browser-1', status: 'completed', answer: 'browser-1', reason: null },
      compared: { first: 'browser-1', second: 'system-1' },
      notified: [{ session: 'browser-1', status: 'queued' }],
    })
    expect(space.record.asks.map(({ input }) => input.to)).toEqual([
      'browser-1',
      'browser-1',
      'browser-1',
      'system-1',
    ])
    expect(space.record.tells.map(({ input }) => input.to)).toEqual(['browser-1'])
  }, 90_000)
})
