/**
 * 项目里的 `velar:shell`：共用的命令操作配上 `projectCapabilityPorts.shell`——工作目录钳在项目内、前台命令在项目资源门里排队、
 * 选项原样交给宿主、输出原样交回。只有危险命令问人。宿主是假的（`spec/support.ts` 的 createProjectPortsHarness），内核是真的。
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ShellLimits } from '@velaros-ai/velar/shell/contracts'

import type { ProjectHostPort } from '../contract/requires'
import { commandResult, createProjectPortsHarness, failureOf } from '../spec/support'

const execute = promisify(execFile)

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-shell-port-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** 用真的 /bin/sh 跑前台命令的宿主；这个宿主不许起后台进程。 */
const realShell: ProjectHostPort['runCommand'] = async (command, options, _allowDangerous, signal) => {
  if (options?.background) throw new Error('这个宿主不允许启动后台项目进程。')
  const result = await execute('/bin/sh', ['-c', command], { cwd: options?.cwd, signal, timeout: options?.timeoutMs ?? 5000 })
  return commandResult(command, options?.cwd ?? root, { stdout: result.stdout.slice(0, options?.maxOutputChars), stderr: result.stderr })
}

/** 一个等外面放行的承诺。 */
function deferred() {
  let done!: () => void
  const promise = new Promise<void>((resolve) => {
    done = resolve
  })
  return { promise, done }
}

describe('项目里的 velar:shell', () => {
  test.skipIf(process.platform === 'win32')('前台命令真的跑起来，工作目录缺省是项目根，时间与内存上限交给宿主；宿主不许起后台就抛', async () => {
    const { call, runs } = await createProjectPortsHarness(root, { runCommand: realShell })
    const result = await call('shell', 'run', { command: 'printf project-tool-check', timeoutMs: 5000 })
    expect(result.stdout).toBe('project-tool-check')
    expect(result.exitCode).toBe(0)
    // 输出不折叠：交给宿主的是只守内存的那个上限。
    expect(runs[0]).toMatchObject({ command: 'printf project-tool-check', options: { cwd: root, timeoutMs: 5000, maxOutputChars: ShellLimits.outputChars, background: false }, allowDangerous: false })
    const background = await failureOf(call('shell', 'run', { command: 'printf background', background: true }))
    expect(background.message).toContain('后台')
  })

  test('挑定的 shell 原样交给宿主，宿主没有的那个由宿主拒绝', async () => {
    const { call, runs } = await createProjectPortsHarness(root, {
      runCommand: async (command, options) => {
        // 本机没有挑定的那个时，宿主在执行之前拒绝，不换默认 shell 照跑。
        if (options?.shell === 'pwsh') throw new Error('本机没有 pwsh，可用：posix（默认）。')
        return commandResult(command, options?.cwd ?? root)
      },
    })
    await call('shell', 'run', { command: 'ls' })
    await call('shell', 'run', { command: 'ls', shell: 'posix' })
    expect((await failureOf(call('shell', 'run', { command: 'ls', shell: 'pwsh' }))).message).toContain('本机没有 pwsh')
    expect(runs.map((run) => run.options?.shell)).toEqual([undefined, 'posix', 'pwsh'])
  })

  test('工作目录钳在项目里：项目里的子目录照常，出了项目在任何确认之前就拒', async () => {
    await mkdir(join(root, 'src'))
    const { call, runs, confirmations } = await createProjectPortsHarness(root)
    await call('shell', 'run', { command: 'ls', cwd: 'src' })
    expect(runs[0]?.options?.cwd).toBe(join(root, 'src'))
    for (const cwd of ['..', '/etc']) {
      const outside = await failureOf(call('shell', 'run', { command: 'rm -rf build', cwd }))
      expect(outside.code, cwd).toBe('PERMISSION')
      expect(outside.message, cwd).toContain('项目之内')
    }
    // 名字以 .. 开头的目录在项目之内，照常接受。
    await mkdir(join(root, '..cache'))
    await call('shell', 'run', { command: 'ls', cwd: '..cache' })
    expect(runs.map((run) => run.options?.cwd)).toEqual([join(root, 'src'), join(root, '..cache')])
    expect(confirmations).toEqual([])
  })

  test('危险命令的确认卡片点名原样的命令与工作目录，必须用户亲自点、不记住答案；被拒不起进程，点了头宿主收到「已确认」', async () => {
    const denied = await createProjectPortsHarness(root, { approve: false })
    expect((await failureOf(denied.call('shell', 'run', { command: 'rm -rf ./dist' }))).code).toBe('PERMISSION')
    expect(denied.confirmations).toHaveLength(1)
    expect(denied.confirmations[0]!.options).toMatchObject({
      approvalRisk: 'high',
      riskScope: 'project-command:dangerous',
      // 任何权限档都要弹卡、也不记住答案：审批端口会用操作键覆盖 riskScope，只靠后缀挡不住自动放行。
      requireManualApproval: true,
      rememberRiskScope: false,
      operation: { label: 'rm -rf ./dist', target: root },
    })
    expect(denied.runs).toEqual([])

    const approved = await createProjectPortsHarness(root)
    await approved.call('shell', 'run', { command: 'rm -rf ./dist' })
    expect(approved.confirmations).toHaveLength(1)
    expect(approved.runs.map(({ command, allowDangerous }) => ({ command, allowDangerous }))).toEqual([{ command: 'rm -rf ./dist', allowDangerous: true }])
  })

  test('前台命令在项目资源门里排队：会改项目的独占，排在后面的只读命令等它跑完；后台命令交给宿主，不占门', async () => {
    const release = deferred()
    const writerStarted = deferred()
    const started: string[] = []
    const { call } = await createProjectPortsHarness(root, {
      runCommand: async (command, options) => {
        started.push(command)
        if (command === 'touch a.txt') {
          writerStarted.done()
          await release.promise
        }
        return commandResult(command, options?.cwd ?? root)
      },
    })
    const writing = call('shell', 'run', { command: 'touch a.txt' })
    await writerStarted.promise
    const reading = call('shell', 'run', { command: 'ls' })
    // 长驻命令自动转后台：交给宿主的任务管理，不排在门外，写者还没跑完它就起来了。
    const background = await call('shell', 'run', { command: 'npm run dev' })
    expect(background.exitCode).toBe(0)
    expect(started).toEqual(['touch a.txt', 'npm run dev'])
    release.done()
    await Promise.all([writing, reading])
    expect(started).toEqual(['touch a.txt', 'npm run dev', 'ls'])
  })

  test('只读的前台命令之间不互相等', async () => {
    const release = deferred()
    const readerStarted = deferred()
    const { call } = await createProjectPortsHarness(root, {
      runCommand: async (command, options) => {
        if (command === 'cat a.txt') {
          readerStarted.done()
          await release.promise
        }
        return commandResult(command, options?.cwd ?? root, { stdout: command })
      },
    })
    const first = call('shell', 'run', { command: 'cat a.txt' })
    await readerStarted.promise
    // 第一条只读命令还没跑完，第二条只读命令照样跑完。
    expect((await call('shell', 'run', { command: 'ls' })).stdout).toBe('ls')
    release.done()
    expect((await first).stdout).toBe('cat a.txt')
  })

  test('后台任务按本会话查、按本会话停；刷新命令环境交给宿主', async () => {
    const { call, host } = await createProjectPortsHarness(root, { sessionId: 'session-7' })
    const asked: unknown[] = []
    const stopped: unknown[] = []
    let refreshed = 0
    host.listBackgroundTasks = async (options) => {
      asked.push(options)
      return []
    }
    host.terminateBackgroundTask = async (request) => {
      stopped.push(request)
      return { terminated: true, statusAfter: 'exited', message: '后台进程已发送终止信号。' }
    }
    host.refreshShellEnvironment = async () => {
      refreshed += 1
      return { shell: '/bin/zsh', variableCount: 3, refreshedAt: 1 }
    }
    const listed = await call('shell', 'listTasks', { onlyRunning: true })
    expect(listed).toEqual({ tasks: [] })
    expect(asked[0]).toMatchObject({ onlyRunning: true, sessionId: 'session-7' })
    const stop = await call('shell', 'stop', { taskId: 'task-1' })
    expect(stop).toEqual({ taskId: 'task-1', stopped: true, status: 'exited' })
    expect(stopped).toEqual([{ taskId: 'task-1', sessionId: 'session-7', force: false }])
    const environment = await call('shell', 'refreshEnvironment')
    expect(environment).toEqual({ shell: '/bin/zsh', shells: [] })
    expect(refreshed).toBe(1)
  })
})
