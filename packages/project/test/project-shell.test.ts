/**
 * 项目空间里的 `velar:shell`：共用的命令操作配上项目端口——工作目录钳在项目内、选项原样交给宿主、输出原样交回。
 * 只有危险命令问人，确认卡片在 approval-context.test.ts。
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ShellLimits } from '@velaros-ai/velar/shell/contracts'

import type { ProjectHostPort } from '../src/contract/requires'

import { failureOf, projectSpaceFixture } from './support/space'

const execute = promisify(execFile)

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'project-shell-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** 一次交给宿主的命令：命令、选项、是不是用户确认过的危险命令。 */
interface HostRun {
  command: string
  options: Parameters<ProjectHostPort['runCommand']>[1]
  allowDangerous?: boolean
}

/** 用真的 /bin/sh 跑前台命令的宿主；不支持后台。每次交过来的命令都记下。 */
function realShell(runs: HostRun[]): ProjectHostPort['runCommand'] {
  return async (command, options, allowDangerous, signal) => {
    runs.push({ command, options, allowDangerous })
    // 能不能起后台进程由宿主在执行时决定；这个宿主不支持后台。
    if (options?.background) throw new Error('这个宿主不允许启动后台项目进程。')
    const result = await execute('/bin/sh', ['-c', command], { cwd: options?.cwd, signal, timeout: options?.timeoutMs ?? 5000 })
    return { command, cwd: options?.cwd ?? root, stdout: result.stdout.slice(0, options?.maxOutputChars), stderr: result.stderr, exitCode: 0, success: true } as never
  }
}

describe('项目空间的 velar:shell', () => {
  test('前台命令真的跑起来，工作目录缺省是项目根，时间与内存上限交给宿主；宿主不许起后台就抛', async () => {
    const runs: HostRun[] = []
    const { call } = await projectSpaceFixture({ root, runCommand: realShell(runs) })
    const result = await call('shell', 'run', { command: 'printf project-tool-check', timeoutMs: 5000 })
    expect(result.stdout).toBe('project-tool-check')
    expect(result.exitCode).toBe(0)
    // 输出不折叠：交给宿主的是只守内存的那个上限。
    expect(runs[0]).toMatchObject({ command: 'printf project-tool-check', options: { cwd: root, timeoutMs: 5000, maxOutputChars: ShellLimits.outputChars, background: false }, allowDangerous: false })
    const background = await failureOf(call('shell', 'run', { command: 'printf background', background: true }))
    expect(background.message).toContain('后台')
  })

  test('挑定的 shell 原样交给宿主端口，宿主没有的那个由宿主拒绝', async () => {
    const seen: Array<string | undefined> = []
    const { call } = await projectSpaceFixture({
      root,
      runCommand: async (command, options) => {
        seen.push(options?.shell)
        // 本机没有挑定的那个时，宿主在执行之前拒绝，不换默认 shell 照跑。
        if (options?.shell === 'pwsh') throw new Error('本机没有 pwsh，可用：posix（默认）。')
        return { command, stdout: command, stderr: '', exitCode: 0, success: true } as never
      },
    })
    await call('shell', 'run', { command: 'ls' })
    await call('shell', 'run', { command: 'ls', shell: 'posix' })
    expect((await failureOf(call('shell', 'run', { command: 'ls', shell: 'pwsh' }))).message).toContain('本机没有 pwsh')
    expect(seen).toEqual([undefined, 'posix', 'pwsh'])
  })

  test('工作目录钳在项目里：项目里的子目录照常，出了项目在任何确认之前就拒', async () => {
    await mkdir(join(root, 'src'))
    const runs: HostRun[] = []
    const { call, confirmations } = await projectSpaceFixture({ root, runCommand: realShell(runs) })
    await call('shell', 'run', { command: 'ls', cwd: 'src' })
    expect(runs[0]!.options?.cwd).toBe(join(root, 'src'))
    for (const cwd of ['..', '/etc']) {
      const outside = await failureOf(call('shell', 'run', { command: 'rm -rf build', cwd }))
      expect(outside.code, cwd).toBe('PERMISSION')
      expect(outside.message, cwd).toContain('项目之内')
    }
    expect(confirmations).toEqual([])
    expect(runs).toHaveLength(1)
  })

  test('会改项目的命令、长驻命令都不问，直接跑；输出原样交回（像密钥的片段也不遮）', async () => {
    const runs: HostRun[] = []
    const { call, confirmations } = await projectSpaceFixture({ root, runCommand: realShell(runs) })
    const secret = ['sk', 'live', '0123456789abcdefghijklmnopqrstuvwxyz'].join('-')
    await call('shell', 'run', { command: 'touch made.txt' })
    const printed = await call('shell', 'run', { command: `printf 'key=${secret}'` })
    expect(printed.stdout).toBe(`key=${secret}`)
    expect(confirmations).toEqual([])
    expect(runs.map((run) => run.command)).toEqual(['touch made.txt', `printf 'key=${secret}'`])
  })

  test('危险命令用户点过头之后，宿主收到「已确认的危险命令」', async () => {
    const runs: Array<{ command: string; allowDangerous?: boolean }> = []
    const { call, confirmations } = await projectSpaceFixture({
      root,
      runCommand: async (command, _options, allowDangerous) => {
        runs.push({ command, allowDangerous })
        return { command, stdout: '', stderr: '', exitCode: 0, success: true } as never
      },
    })
    await call('shell', 'run', { command: 'rm -rf ./dist' })
    expect(confirmations).toHaveLength(1)
    expect(runs).toEqual([{ command: 'rm -rf ./dist', allowDangerous: true }])
  })

  test('后台任务按本会话查', async () => {
    const { call, host, context } = await projectSpaceFixture({ root })
    const asked: unknown[] = []
    host.listBackgroundTasks = async (options) => { asked.push(options); return [] }
    expect(await call('shell', 'listTasks', { onlyRunning: true })).toEqual({ tasks: [] })
    expect(asked[0]).toMatchObject({ onlyRunning: true, sessionId: context.sessionId })
  })
})
