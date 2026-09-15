import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { LocalSystemKernelApi } from '../src/impl/LocalSystemKernel.js'
import { createLocalSystemKernel } from '../src/impl/LocalSystemKernel.js'
import { systemProcessManager } from '../src/impl/SystemProcessManager.js'
import { readBoundedOutputSince } from '../src/utils/text.js'
import { SystemTuning } from '../src/utils/tuning.js'

/** 等一小会儿，给子进程写输出、响应信号的时间。 */
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一直读控制台的增量输出，直到看到想要的那段或超时；返回到目前为止读到的全部文本。 */
async function readUntil(
  kernel: LocalSystemKernelApi,
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
async function waitUntilExited(kernel: LocalSystemKernelApi, taskId: string, timeoutMs = 10_000): Promise<string> {
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
      const kernel = createLocalSystemKernel({ cwd: workingDirectory })
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

        const written = await kernel.writeConsoleInput({ taskId: taskId!, text: 'velar' })
        expect(written).toMatchObject({ taskId, accepted: true, status: 'running' })

        const answered = await readUntil(kernel, taskId!, 'hi velar')
        expect(answered.text.slice(prompt.text.length)).toContain('hi velar')

        // 相当于用户按 Ctrl+C：整个进程组收到 SIGINT。
        const interrupted = await kernel.interruptConsole({ taskId: taskId! })
        expect(interrupted.accepted).toBe(true)
        expect(await waitUntilExited(kernel, taskId!)).toBe('exited')

        // 进程没了，控制台还在任务上，只是不再接受输入。
        const afterExit = await kernel.readConsoleOutput({ taskId: taskId! })
        expect(afterExit.acceptsInput).toBe(false)
        expect(afterExit.text).toContain('hi velar')

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
    '普通后台任务没有控制台，写输入被如实拒绝，跨会话读取被挡住',
    async () => {
      const workingDirectory = await mkdtemp(join(tmpdir(), 'velaros-console-'))
      const kernel = createLocalSystemKernel({ cwd: workingDirectory })
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
      const kernel = createLocalSystemKernel({ cwd: workingDirectory })
      try {
        const started = await kernel.runCommand('sleep 30', { background: true, interactive: true })
        const taskId = started.backgroundProcess!.taskId!
        // 结构断言：管道断开时的 EPIPE 有人接，不会变成宿主进程的未捕获异常（bun 下 EPIPE 不抛，下一条用例在 Node 里实跑）。
        const stdin = systemProcessManager.find(started.backgroundProcess!.pid!)?.child.stdin
        expect(stdin?.listenerCount('error')).toBeGreaterThan(0)

        // 进程一直不读输入：写 1 MB 也在时限内返回，不会让调用方一直挂着。
        const began = Date.now()
        const pasted = await kernel.writeConsoleInput({ taskId, text: 'x'.repeat(1024 * 1024) })
        expect(Date.now() - began).toBeLessThan(SystemTuning.command.consoleWriteTimeoutMs + 1_500)
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
        // 宿主跑在 Node（Electron 主进程）里，EPIPE 没人接会直接抛成未捕获异常；bun 下复现不了，所以打包后交给 node 跑。
        await writeFile(join(workingDirectory, 'entry.ts'), `export { createLocalSystemKernel } from ${JSON.stringify(resolve(import.meta.dir, '../src/impl/LocalSystemKernel.ts'))}\n`)
        const built = await Bun.build({ entrypoints: [join(workingDirectory, 'entry.ts')], outdir: workingDirectory, target: 'node', format: 'esm', naming: '[name].mjs' })
        expect(built.success).toBe(true)
        await writeFile(join(workingDirectory, 'scenario.mjs'), [
          "import { createLocalSystemKernel } from './entry.mjs'",
          "process.on('uncaughtException', (error) => { console.log('UNCAUGHT', error.code); process.exit(3) })",
          'const kernel = createLocalSystemKernel({ cwd: process.cwd() })',
          "const closed = await kernel.runCommand('exec 0<&-; sleep 5', { background: true, interactive: true })",
          'await new Promise((done) => setTimeout(done, 400))',
          "const refused = await kernel.writeConsoleInput({ taskId: closed.backgroundProcess.taskId, text: 'y' })",
          "const idle = await kernel.runCommand('sleep 20', { background: true, interactive: true })",
          "await kernel.writeConsoleInput({ taskId: idle.backgroundProcess.taskId, text: 'x'.repeat(1024 * 1024) })",
          'await kernel.dispose()',
          'await new Promise((done) => setTimeout(done, 300))',
          "console.log('survived', refused.accepted)",
        ].join('\n'))
        const run = Bun.spawnSync(['node', join(workingDirectory, 'scenario.mjs')], { cwd: workingDirectory, timeout: 30_000 })
        expect({ code: run.exitCode, stdout: run.stdout.toString().trim() }).toEqual({ code: 0, stdout: 'survived false' })
      } finally {
        await rm(workingDirectory, { recursive: true, force: true })
      }
    },
    60_000
  )
})
