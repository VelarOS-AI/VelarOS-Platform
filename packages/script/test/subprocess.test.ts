import { describe, expect, test } from 'bun:test'

import { CodeSurfaceErrorCodes } from '../src/contract/constants'
import type { ScriptProcessEvents, SubprocessCodeRunnerOptions } from '../src/contract/requires'
import { codeProgramChecker } from '../src/impl/CodeProgramChecker'
import { createCodeSurfaceSession } from '../src/impl/CodeSurfaceSession'
import { nodeSubprocessCodeRunner } from '../src/impl/NodeSubprocessCodeRunner'
import { createSubprocessCodeRunner } from '../src/impl/SubprocessCodeRunner'
import type { CodeRunRequest } from '../src/types/runner'
import type { ScriptWorkerCommand } from '../src/types/worker'

const request: CodeRunRequest = {
  source: 'return 1',
  modules: {},
  blobs: {},
  input: null,
  operations: {},
  timeoutMs: 1000,
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const fixture = () => {
  let events!: ScriptProcessEvents
  const sent: ScriptWorkerCommand[] = []
  let terminated = 0
  const closed = deferred<void>()
  const options: SubprocessCodeRunnerOptions = {
    launch: (received) => {
      events = received
      return {
        send: (message) => {
          sent.push(message)
        },
        terminate: () => {
          terminated += 1
          return closed.promise
        },
      }
    },
  }
  return { options, sent, closed, events: () => events, terminated: () => terminated }
}

void describe('INV-28 宿主进程注入与回收', () => {
  test('真实 Node 能力同步抛错后恢复墙钟，guest 永久等待仍会超时', async () => {
    let calls = 0
    const controller = new AbortController()
    // 外层保护用于让计时回归失败也能回收真实子进程；不能把它误作运行器超时。
    const safety = setTimeout(() => controller.abort(new Error('外层测试保护超时')), 4000)
    const session = createCodeSurfaceSession({
      checker: codeProgramChecker,
      runner: nodeSubprocessCodeRunner,
      capabilities: {
        listOperations: () => ({ demo: ['fail'] }),
        invoke: () => {
          calls += 1
          throw new Error('同步宿主失败')
        },
      },
    })
    try {
      const outcome = await session.submit({
        program: {
          source:
            "import { fail } from 'velaros:demo'\ntry { await fail({}) } catch {}\nawait new Promise(() => {})\nexport default true",
        },
        granted: [
          {
            namespace: 'demo',
            declarations:
              "declare module 'velaros:demo' { export function fail(input: {}): Promise<void> }",
          },
        ],
        timeoutMs: 1000,
        signal: controller.signal,
      })
      expect(outcome.checked).toBe(true)
      if (!outcome.checked) throw new Error('应通过类型检查')
      expect(calls).toBe(1)
      expect(controller.signal.aborted).toBe(false)
      expect(outcome.result.failed?.code).toBe(CodeSurfaceErrorCodes.timeout)
      expect(outcome.result.unsettled).toBeUndefined()
    } finally {
      clearTimeout(safety)
    }
  }, 6000)

  test('预取消不启动进程；启动异常成为可观察失败', async () => {
    let launches = 0
    const runner = createSubprocessCodeRunner({
      launch: () => {
        launches += 1
        throw new Error('launch refused')
      },
    })
    const aborted = await runner.run(
      request,
      async () => ({}),
      () => {},
      AbortSignal.abort()
    )
    expect(aborted.error?.code).toBe(CodeSurfaceErrorCodes.aborted)
    expect(launches).toBe(0)
    const rejected = await runner.run(
      request,
      async () => ({}),
      () => {}
    )
    expect(rejected.error?.message).toContain('launch refused')
    expect(launches).toBe(1)
  })

  test('创建期间取消也回收返回的句柄，并等待退出', async () => {
    const controller = new AbortController()
    const closed = deferred<void>()
    let terminated = 0
    const runner = createSubprocessCodeRunner({
      launch: () => {
        controller.abort()
        return {
          send: () => {
            throw new Error('must not send')
          },
          terminate: () => {
            terminated += 1
            return closed.promise
          },
        }
      },
    })
    let settled = false
    const running = runner
      .run(
        request,
        async () => ({}),
        () => {},
        controller.signal
      )
      .then((value) => {
        settled = true
        return value
      })
    await Promise.resolve()
    expect(terminated).toBe(1)
    expect(settled).toBe(false)
    closed.resolve()
    expect((await running).error?.code).toBe(CodeSurfaceErrorCodes.aborted)
  })

  test('ready可在launch返回前到达；正常终态等待退出且不重复回收', async () => {
    const f = fixture()
    const launch = f.options.launch
    const runner = createSubprocessCodeRunner({
      launch: (events) => {
        events.onMessage({ type: 'ready', confined: true })
        return launch(events)
      },
    })
    const logs: string[] = []
    let settled = false
    const running = runner
      .run(
        request,
        async () => ({}),
        (line) => logs.push(line)
      )
      .then((value) => {
        settled = true
        return value
      })
    expect(f.sent[0]?.type).toBe('program')
    f.events().onMessage({ type: 'log', line: 'live' })
    f.events().onMessage({ type: 'done', ok: true, value: 7, logs: ['live'] })
    f.events().onExit(0)
    await Promise.resolve()
    expect(f.terminated()).toBe(1)
    expect(settled).toBe(false)
    f.closed.resolve()
    expect(await running).toMatchObject({ ok: true, value: 7, logs: ['live'] })
    expect(logs).toEqual(['live'])
  })

  test('异步发送失败停止本轮并等待回收', async () => {
    const f = fixture()
    const runner = createSubprocessCodeRunner({
      launch: (events) => {
        const child = f.options.launch(events)
        return {
          ...child,
          send: async () => {
            throw new Error('port closed')
          },
        }
      },
    })
    const running = runner.run(
      request,
      async () => ({}),
      () => {}
    )
    f.events().onMessage({ type: 'ready', confined: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(f.terminated()).toBe(1)
    f.closed.resolve()
    expect((await running).error?.message).toContain('port closed')
  })

  test('完成后的能力回执不会再次发送，停表恢复不会重启定时器', async () => {
    const f = fixture()
    const result = deferred<{ value: number }>()
    let release!: () => void
    const running = createSubprocessCodeRunner(f.options).run(
      request,
      async (_call, hold) => {
        release = hold()
        return result.promise
      },
      () => {}
    )
    f.events().onMessage({ type: 'ready', confined: true })
    f.events().onMessage({
      type: 'call',
      callId: 1,
      namespace: 'demo',
      operation: 'read',
      input: null,
    })
    f.events().onMessage({ type: 'done', ok: true, logs: [] })
    f.closed.resolve()
    expect(await running).toMatchObject({ ok: true, pendingCalls: [1] })
    result.resolve({ value: 1 })
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.sent.map((message) => message.type)).toEqual(['program'])
    expect(f.terminated()).toBe(1)
  })

  test('隔离自证失败与超时都终止进程', async () => {
    const f = fixture()
    const failed = createSubprocessCodeRunner(f.options).run(
      request,
      async () => ({}),
      () => {}
    )
    f.events().onMessage({ type: 'ready', confined: false })
    f.closed.resolve()
    expect((await failed).error?.code).toBe(CodeSurfaceErrorCodes.runnerCrashed)
    expect(f.sent).toEqual([])
    const timeout = fixture()
    const running = createSubprocessCodeRunner(timeout.options).run(
      { ...request, timeoutMs: 10 },
      async () => ({}),
      () => {}
    )
    timeout.closed.resolve()
    expect((await running).error?.code).toBe(CodeSurfaceErrorCodes.timeout)
    expect(timeout.terminated()).toBe(1)
  })
})
