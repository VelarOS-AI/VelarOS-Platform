// 真实 Node 程序在 POSIX 运行；输入与取消验收适用于所有平台。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { SessionAnswer } from '../index'
import { SessionsErrorCodes, sessionsOperations, VelarSessionsModule } from '../index'

import {
  DefaultPeers,
  failureOf,
  pendingUntilAborted,
  runModelProgram,
  SessionsDeclarations,
  sessionsSpace,
  typecheckTemplate,
} from './support'

const it = test.skipIf(process.platform === 'win32')

describe('现有会话投递', () => {
  test('INV-1 list 原样返回目录，宿主只被调用一次', async () => {
    const host = sessionsSpace()
    expect(await sessionsOperations.list(host.context)).toBe(DefaultPeers)
    expect(host.record.lists).toBe(1)
  })

  test('INV-2 身份去除空白，任务原样交给宿主', async () => {
    const host = sessionsSpace()
    const task = '  核对接口定义\n'
    await sessionsOperations.ask({ to: ' browser-1 ', task }, host.context)
    expect(host.record.asks[0]!.input).toEqual({ to: 'browser-1', task })
  })

  test('INV-5 身份去除空白，引导原样交给宿主并返回接纳结果', async () => {
    const host = sessionsSpace()
    const message = '  按新定义继续\n'
    expect(await sessionsOperations.tell({ to: ' browser-1 ', message }, host.context)).toEqual({
      session: 'browser-1',
      status: 'queued',
    })
    expect(host.record.tells[0]!.input).toEqual({ to: 'browser-1', message })
  })

  test('INV-4 结果及宿主拒绝原样返回，不新增运行或转换错误', async () => {
    for (const status of ['completed', 'failed', 'cancelled', 'waiting'] as const) {
      const answer: SessionAnswer = {
        session: 'browser-1',
        status,
        answer: '宿主答复',
        reason: null,
      }
      const host = sessionsSpace({ answer: async () => answer })
      expect(await sessionsOperations.ask({ to: 'browser-1', task: '核验' }, host.context)).toBe(
        answer
      )
    }
    const refusal = new AppError('CONFLICT', '目标正在等待来源会话，无法反向等待')
    const host = sessionsSpace({
      answer: async () => {
        throw refusal
      },
      told: async () => {
        throw refusal
      },
    })
    expect(
      await sessionsOperations
        .ask({ to: 'browser-1', task: '核验' }, host.context)
        .catch((error: unknown) => error)
    ).toBe(refusal)
    expect(
      await sessionsOperations
        .tell({ to: 'browser-1', message: '核验' }, host.context)
        .catch((error: unknown) => error)
    ).toBe(refusal)
  })
})

describe('输入及取消', () => {
  test('INV-3 旧工作区创建字段直接拒绝，不调用宿主', async () => {
    const host = sessionsSpace()
    for (const field of ['workspace', 'root', 'site'])
      expect(
        (
          await failureOf(
            sessionsOperations.ask(
              { to: 'browser-1', task: '核验', [field]: '旧配置' },
              host.context
            )
          )
        ).code
      ).toBe(SessionsErrorCodes.inputInvalid)
    expect(host.record).toEqual({ lists: 0, asks: [], tells: [] })
  })

  test('INV-6 缺失目标及非法输入均不调用宿主', async () => {
    const host = sessionsSpace()
    const cases: Array<[unknown, string]> = [
      [null, SessionsErrorCodes.inputInvalid],
      ['task', SessionsErrorCodes.inputInvalid],
      [{ to: 42, task: '核验' }, SessionsErrorCodes.inputInvalid],
      [{ to: 'browser-1', task: 42 }, SessionsErrorCodes.inputInvalid],
      [{ to: 'browser-1' }, SessionsErrorCodes.taskEmpty],
      [{ to: 'browser-1', task: ' \n ' }, SessionsErrorCodes.taskEmpty],
      [{ task: '核验' }, SessionsErrorCodes.targetMissing],
      [{ to: '  ', task: '核验' }, SessionsErrorCodes.targetMissing],
    ]
    for (const [input, code] of cases)
      expect((await failureOf(sessionsOperations.ask(input as never, host.context))).code).toBe(
        code
      )
    for (const input of [
      undefined,
      { to: 'browser-1', message: ['x'] },
      { to: 'browser-1', message: 'x', urgent: true },
    ])
      expect((await failureOf(sessionsOperations.tell(input as never, host.context))).code).toBe(
        SessionsErrorCodes.inputInvalid
      )
    expect(
      (await failureOf(sessionsOperations.tell({ to: 'browser-1', message: ' ' }, host.context)))
        .code
    ).toBe(SessionsErrorCodes.messageEmpty)
    expect(
      (await failureOf(sessionsOperations.tell({ to: '', message: '核验' }, host.context))).code
    ).toBe(SessionsErrorCodes.targetMissing)
    expect(host.record).toEqual({ lists: 0, asks: [], tells: [] })
  })

  test('INV-7 预取消不投递，运行取消转交原信号且不再等待宿主', async () => {
    const before = new AbortController()
    before.abort(new AppError('CANCELLED', '开始前取消'))
    const idle = sessionsSpace({ abortSignal: before.signal })
    for (const pending of [
      sessionsOperations.list(idle.context),
      sessionsOperations.ask({ to: 'browser-1', task: '核验' }, idle.context),
      sessionsOperations.tell({ to: 'browser-1', message: '核验' }, idle.context),
    ])
      expect((await failureOf(pending)).code).toBe('CANCELLED')
    expect(idle.record).toEqual({ lists: 0, asks: [], tells: [] })

    for (const honor of [true, false]) {
      const controller = new AbortController()
      const host = sessionsSpace({
        abortSignal: controller.signal,
        answer: (_, signal) => pendingUntilAborted(signal, honor),
        told: (_, signal) => pendingUntilAborted(signal, honor),
      })
      const asked = failureOf(
        sessionsOperations.ask({ to: 'browser-1', task: '慢任务' }, host.context)
      )
      const told = failureOf(
        sessionsOperations.tell({ to: 'browser-1', message: '引导' }, host.context)
      )
      expect(host.record.asks[0]!.signal).toBe(controller.signal)
      expect(host.record.tells[0]!.signal).toBe(controller.signal)
      controller.abort(new AppError('CANCELLED', '停止等待'))
      expect(await asked).toEqual({ code: 'CANCELLED', message: '停止等待' })
      expect(await told).toEqual({ code: 'CANCELLED', message: '停止等待' })
    }
  })
})

describe('模型面', () => {
  it('INV-8 真实程序可并行寻址现有会话并处理未知字段错误', async () => {
    const host = sessionsSpace()
    const result = await runModelProgram(
      host,
      `import {ask,list,tell} from 'velaros:sessions';
const peers=await list();
const results=await Promise.all(peers.filter(peer=>!peer.self).map(peer=>ask({to:peer.id,task:'核验'})));
const told=await tell({to:'browser-1',message:'继续'});
let refused;
try { await ask({to:'browser-1',task:'核验',workspace:'browser'}); } catch(error) {refused=error.code;}
export default {sessions:results.map(result=>result.session),told,refused};`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual({
      sessions: ['browser-1', 'system-1'],
      told: { session: 'browser-1', status: 'queued' },
      refused: SessionsErrorCodes.inputInvalid,
    })
  }, 60_000)

  test('INV-9 模板整份通过真实声明检查，只有一个 import', () => {
    const template = readFileSync(fileURLToPath(new URL('../template.js', import.meta.url)), 'utf8')
    expect(typecheckTemplate(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarSessionsModule.template).toBe(template.replace(/\r\n/g, '\n').trim())
  })

  test('INV-10 模型面只有现有会话协作，私有端口及工作区合同不外泄', () => {
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
    for (const name of [
      'SessionWorkspace',
      'SessionsSpacePort',
      'SessionsOperationContext',
      'AbortSignal',
      'workspace:',
      'root:',
      'site:',
    ])
      expect(SessionsDeclarations.includes(name)).toBe(false)
    expect(SessionsDeclarations).toContain('to: string')
  })
})
