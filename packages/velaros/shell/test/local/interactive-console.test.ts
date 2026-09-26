import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type {
  ShellTerminalExit,
  ShellTerminalFactory,
  ShellTerminalProcess,
  ShellTerminalSpawnOptions,
} from '../../contract/requires.js'
import type { LocalShellHostApi } from '../../impl/local/LocalShellHost.js'
import { createLocalShellHost } from '../../impl/local/LocalShellHost.js'
import { shellProcessManager } from '../../impl/local/ShellProcessManager.js'
import type { ShellConsoleOutputEvent } from '../../types/shell-command.js'
import { plainTerminalText, readBoundedOutputSince } from '../../utils/output.js'
import { taskOf } from '../../utils/results.js'
import { ShellTuning } from '../../utils/tuning.js'

/**
 * 假的伪终端：进程是真起的（自成进程组，收尾时整组杀得掉），输出由测试手动吐，写进去的、改过的尺寸都记下来。
 * 真 node-pty 是原生模块，本包不依赖它；它的真机行为在宿主里验。
 */
class FakeTerminal implements ShellTerminalProcess {
  public readonly writes: string[] = []
  public readonly sizes: Array<[number, number]> = []
  private readonly child: ChildProcess
  private readonly dataListeners = new Set<(data: string) => void>()

  constructor(
    public readonly file: string,
    public readonly args: string[],
    public readonly options: ShellTerminalSpawnOptions
  ) {
    this.child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  }

  public get pid(): number {
    return this.child.pid!
  }

  public onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  public onExit(listener: (event: ShellTerminalExit) => void): { dispose(): void } {
    const forward = (code: Nullable<number>, signal: Nullable<NodeJS.Signals>): void =>
      listener({ exitCode: code ?? 0, signal: signal ? 15 : 0 })
    this.child.once('exit', forward)
    return { dispose: () => this.child.off('exit', forward) }
  }

  public write(data: string): void {
    this.writes.push(data)
  }

  public resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }

  public kill(signal?: string): void {
    this.child.kill((signal ?? 'SIGHUP') as NodeJS.Signals)
  }

  /** 替终端吐一段输出。 */
  public emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }
}

/** 等一小会儿，给子进程写输出、响应信号的时间。 */
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一直读控制台的增量输出，直到看到想要的那段或超时；返回到目前为止读到的全部文本。 */
async function readUntil(
  kernel: LocalShellHostApi,
  taskId: string,
  needle: string,
  timeoutMs = 10_000
): Promise<{ text: string; cursor: number }> {
  const deadline = Date.now() + timeoutMs
  let text = ''
  let cursor = 0
  while (Date.now() < deadline) {
    const chunk = await kernel.readConsoleOutput({ taskId, cursor })
    text += chunk.text
    cursor = chunk.cursor
    if (text.includes(needle)) return { text, cursor }
    await tick(25)
  }
  throw new Error(`控制台在 ${timeoutMs}ms 内没有出现「${needle}」，读到的是：${text}`)
}

/** 一直等到任务不再是 running。 */
async function waitUntilExited(
  kernel: LocalShellHostApi,
  taskId: string,
  timeoutMs = 10_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let status = 'running'
  while (Date.now() < deadline) {
    const [task] = await kernel.listBackgroundTasks({ taskId })
    status = task?.status ?? 'unknown'
    if (status !== 'running') return status
    await tick(25)
  }
  return status
}

describe('交互式命令的控制台', () => {
  test('cursor 之后的增量输出如实给出，缓冲区挤掉的部分报成 droppedChars', () => {
    // 一共产生了 10 个字符，缓冲区只留下末尾 4 个。
    const since = readBoundedOutputSince('6789', 10, 8)
    expect(since).toEqual({ text: '89', cursor: 10, droppedChars: 0 })

    const dropped = readBoundedOutputSince('6789', 10, 2)
    expect(dropped).toEqual({ text: '6789', cursor: 10, droppedChars: 4 })

    const caughtUp = readBoundedOutputSince('6789', 10, 10)
    expect(caughtUp).toEqual({ text: '', cursor: 10, droppedChars: 0 })
  })

  test.skipIf(process.platform === 'win32')(
    '读 stdin 的命令跑在控制台里：看得到提示、写得进输入、中断得掉',
    async () => {
      const workingDirectory = await mkdtemp(join(tmpdir(), 'velaros-console-'))
      const kernel = createLocalShellHost({ cwd: workingDirectory })
      try {
        const started = await kernel.runCommand(
          `printf 'name? '; read -r answer; printf 'hi %s\\n' "$answer"; sleep 30`,
          { background: true, interactive: true, sessionId: 'session-console' }
        )

        const taskId = started.backgroundProcess?.taskId
        expect(taskId).toBeTruthy()
        expect(started.backgroundProcess?.console).toMatchObject({
          taskId,
          channel: 'pipe',
          acceptsInput: true,
        })

        // 命令先问一句，然后停在 read 上等输入。
        const prompt = await readUntil(kernel, taskId!, 'name? ')

        const written = await kernel.writeConsoleInput({ taskId: taskId!, text: 'velaros' })
        expect(written).toMatchObject({ taskId, accepted: true, status: 'running' })

        const answered = await readUntil(kernel, taskId!, 'hi velaros')
        expect(answered.text.slice(prompt.text.length)).toContain('hi velaros')

        // 相当于用户按 Ctrl+C：整个进程组收到 SIGINT。
        const interrupted = await kernel.interruptConsole({ taskId: taskId! })
        expect(interrupted.accepted).toBe(true)
        expect(await waitUntilExited(kernel, taskId!)).toBe('exited')

        // 进程没了，控制台还在任务上，只是不再接受输入。
        const afterExit = await kernel.readConsoleOutput({ taskId: taskId! })
        expect(afterExit.acceptsInput).toBe(false)
        expect(afterExit.text).toContain('hi velaros')

        const refused = await kernel.writeConsoleInput({ taskId: taskId!, text: 'late' })
        expect(refused.accepted).toBe(false)
      } finally {
        await kernel.dispose()
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
    30_000
  )

  test.skipIf(process.platform === 'win32')(
    '给了伪终端工厂：交互式任务在终端里跑，输出推给订阅方，回车、Ctrl+C、尺寸都经终端',
    async () => {
      const workingDirectory = await mkdtemp(join(tmpdir(), 'velaros-terminal-'))
      const spawned: FakeTerminal[] = []
      const terminal: ShellTerminalFactory = {
        spawn: (file, args, options) => {
          const fake = new FakeTerminal(file, args, options)
          spawned.push(fake)
          return fake
        },
      }
      const kernel = createLocalShellHost({ cwd: workingDirectory, terminal })
      try {
        const started = await kernel.runCommand('python3', {
          background: true,
          interactive: true,
          sessionId: 'session-terminal',
        })
        const taskId = started.backgroundProcess!.taskId!
        expect(started.backgroundProcess?.console).toMatchObject({
          channel: 'pty',
          acceptsInput: true,
        })
        const [fake] = spawned
        expect(fake?.options).toMatchObject({
          cwd: resolve(workingDirectory),
          cols: ShellTuning.command.consoleColumns,
          rows: ShellTuning.command.consoleRows,
          name: 'xterm-256color',
        })
        expect(fake?.options.env.TERM).toBe('xterm-256color')
        expect(fake?.args.join(' ')).toContain('python3')

        // 订阅之后吐的输出推过来，cursor 和读增量输出是同一把尺子。
        const events: ShellConsoleOutputEvent[] = []
        const stop = kernel.watchConsoleOutput({ taskId, sessionId: 'session-terminal' }, (event) =>
          events.push(event)
        )
        fake!.emit('\u001b[32m>>> \u001b[0m')
        expect(events).toEqual([{ taskId, text: '\u001b[32m>>> \u001b[0m', cursor: 13 }])
        stop()
        fake!.emit('1+1\r\n2\r\n')
        expect(events).toHaveLength(1)
        const read = await kernel.readConsoleOutput({ taskId, cursor: 13 })
        expect(read).toMatchObject({ text: '1+1\r\n2\r\n', cursor: 21, acceptsInput: true })

        // 回车在终端里是 \r，按键原样写；Ctrl+C 也是写进终端的一个字符。
        await kernel.writeConsoleInput({ taskId, text: 'print(1)' })
        await kernel.writeConsoleInput({ taskId, text: '\u001b[A', submit: false })
        expect((await kernel.interruptConsole({ taskId })).accepted).toBe(true)
        expect(fake!.writes).toEqual(['print(1)\r', '\u001b[A', '\u0003'])

        expect((await kernel.resizeConsole({ taskId, cols: 100, rows: 40 })).accepted).toBe(true)
        expect(fake!.sizes).toEqual([[100, 40]])
        await expect(kernel.resizeConsole({ taskId, cols: 0, rows: 40 })).rejects.toThrow('正整数')

        // 给模型看的输出去掉了颜色与回车。
        const [record] = await kernel.listBackgroundTasks({ taskId })
        expect(taskOf(record!).output).toBe('>>> 1+1\n2\n')

        // 停掉任务：进程组收掉，任务记下怎么结束的，控制台不再收输入。
        await kernel.terminateBackgroundTask({ taskId, sessionId: 'session-terminal' })
        expect(await waitUntilExited(kernel, taskId)).toBe('exited')
        const [ended] = await kernel.listBackgroundTasks({ taskId })
        expect(ended).toMatchObject({ status: 'exited', signal: 'SIGTERM', exitCode: null })
        expect(ended?.finishedAt).toBeNumber()
        expect(ended?.console?.acceptsInput).toBe(false)
        const refused = await kernel.writeConsoleInput({ taskId, text: 'late' })
        expect(refused.accepted).toBe(false)
      } finally {
        await kernel.dispose()
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
    30_000
  )

  test.skipIf(process.platform === 'win32')(
    '没给伪终端工厂时是管道：没有终端尺寸可改',
    async () => {
      const workingDirectory = await mkdtemp(join(tmpdir(), 'velaros-console-'))
      const kernel = createLocalShellHost({ cwd: workingDirectory })
      try {
        const started = await kernel.runCommand('sleep 30', { background: true, interactive: true })
        const taskId = started.backgroundProcess!.taskId!
        expect(started.backgroundProcess?.console?.channel).toBe('pipe')
        const resized = await kernel.resizeConsole({ taskId, cols: 80, rows: 24 })
        expect(resized.accepted).toBe(false)
        expect(resized.message).toContain('不在终端里')
      } finally {
        await kernel.dispose()
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
    30_000
  )

  test('终端输出整成纯文本：去掉控制序列，回车覆盖的只留最后一版，退格往回退', () => {
    expect(plainTerminalText('\u001b[1;31merror\u001b[0m: boom\r\n')).toBe('error: boom\n')
    expect(plainTerminalText('10%\r55%\r100%\ndone')).toBe('100%\ndone')
    expect(plainTerminalText('\u001b]0;标题\u0007$ ls\u001b[K\r\n')).toBe('$ ls\n')
    expect(plainTerminalText('ab\b \bc\u0007')).toBe('ac')
    expect(plainTerminalText('\u001b(B\u001b=中文')).toBe('中文')
  })

  test.skipIf(process.platform === 'win32')(
    '普通后台任务没有控制台，写输入被如实拒绝，跨会话读取被挡住',
    async () => {
      const workingDirectory = await mkdtemp(join(tmpdir(), 'velaros-console-'))
      const kernel = createLocalShellHost({ cwd: workingDirectory })
      try {
        const started = await kernel.runCommand('sleep 30', {
          background: true,
          sessionId: 'session-console',
        })
        const taskId = started.backgroundProcess?.taskId
        expect(started.backgroundProcess?.console).toBeUndefined()

        const written = await kernel.writeConsoleInput({ taskId: taskId!, text: 'anything' })
        expect(written.accepted).toBe(false)
        expect(written.message).toContain('不是交互式')

        await expect(
          kernel.readConsoleOutput({ taskId: taskId!, sessionId: 'another-session' })
        ).rejects.toThrow('不属于当前会话')
      } finally {
        await kernel.dispose()
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
    30_000
  )

  test.skipIf(process.platform === 'win32')(
    '控制台的输入管道挂着 error 监听，进程不读输入时大段写入在时限内返回',
    async () => {
      const workingDirectory = await mkdtemp(join(tmpdir(), 'velaros-console-'))
      const kernel = createLocalShellHost({ cwd: workingDirectory })
      try {
        const started = await kernel.runCommand('sleep 30', { background: true, interactive: true })
        const taskId = started.backgroundProcess!.taskId!
        // 结构断言：管道断开时的 EPIPE 有人接，不会变成宿主进程的未捕获异常（bun 下 EPIPE 不抛，下一条用例在 Node 里实跑）。
        const stdin = shellProcessManager.find(started.backgroundProcess!.pid!)?.child?.stdin
        expect(stdin?.listenerCount('error')).toBeGreaterThan(0)

        // 进程一直不读输入：写 1 MB 也在时限内返回，不会让调用方一直挂着。
        const began = Date.now()
        const pasted = await kernel.writeConsoleInput({ taskId, text: 'x'.repeat(1024 * 1024) })
        expect(Date.now() - began).toBeLessThan(ShellTuning.command.consoleWriteTimeoutMs + 1_500)
        expect(pasted.accepted).toBe(true)
      } finally {
        await kernel.dispose()
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
    30_000
  )

  test.skipIf(process.platform === 'win32' || !Bun.which('node'))(
    '在 Node 里实跑：进程关了输入后再写、写到一半进程被停，宿主进程都不崩',
    async () => {
      const workingDirectory = await mkdtemp(join(tmpdir(), 'velaros-console-node-'))
      try {
        // 宿主跑在 Node（Electron 主进程）里，EPIPE 没人接会直接抛成未捕获异常；bun 下复现不了，所以把本机实现入口（`./local`）打包后交给 node 跑。
        await writeFile(
          join(workingDirectory, 'entry.ts'),
          `export { createLocalShellHost } from ${JSON.stringify(resolve(import.meta.dir, '../../local.ts'))}\n`
        )
        const built = await Bun.build({
          entrypoints: [join(workingDirectory, 'entry.ts')],
          outdir: workingDirectory,
          target: 'node',
          format: 'esm',
          naming: '[name].mjs',
        })
        expect(built.success).toBe(true)
        await writeFile(
          join(workingDirectory, 'scenario.mjs'),
          [
            "import { createLocalShellHost } from './entry.mjs'",
            "process.on('uncaughtException', (error) => { console.log('UNCAUGHT', error.code); process.exit(3) })",
            'const kernel = createLocalShellHost({ cwd: process.cwd() })',
            "const closed = await kernel.runCommand('exec 0<&-; sleep 5', { background: true, interactive: true })",
            'await new Promise((done) => setTimeout(done, 400))',
            "const refused = await kernel.writeConsoleInput({ taskId: closed.backgroundProcess.taskId, text: 'y' })",
            "const idle = await kernel.runCommand('sleep 20', { background: true, interactive: true })",
            "await kernel.writeConsoleInput({ taskId: idle.backgroundProcess.taskId, text: 'x'.repeat(1024 * 1024) })",
            'await kernel.dispose()',
            'await new Promise((done) => setTimeout(done, 300))',
            "console.log('survived', refused.accepted)",
          ].join('\n')
        )
        const run = Bun.spawnSync(['node', join(workingDirectory, 'scenario.mjs')], {
          cwd: workingDirectory,
          timeout: 30_000,
        })
        expect({ code: run.exitCode, stdout: run.stdout.toString().trim() }).toEqual({
          code: 0,
          stdout: 'survived false',
        })
      } finally {
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
    60_000
  )
})
