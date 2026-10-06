import assert from 'node:assert/strict'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGuardedCommand } from '../../release/safe-package-pack.mjs'

// 文件描述符让主动退出的 Node 程序同步落盘；仅在进程组回收后读取有界输出。
export async function runCapturedCommand(
  command,
  args,
  { cwd, env = process.env, timeout = 180000, maxBuffer = 8_000_000 } = {}
) {
  assert(Number.isSafeInteger(maxBuffer) && maxBuffer > 0, 'maxBuffer must be a positive integer')
  const root = await mkdtemp(join(tmpdir(), 'velaros-check-output-'))
  const handles = []
  try {
    for (const name of ['stdout', 'stderr'])
      handles.push(await open(join(root, name), 'wx+', 0o600))
    const controller = new AbortController()
    let limitExceeded = false,
      monitoringFailure,
      pending,
      monitoring = true
    // 按流检查文件增长并通过同一个守护器回收进程组，读取上限仍独立核对。
    const monitor = setInterval(() => {
      if (pending || !monitoring) return
      pending = Promise.all(handles.map((handle) => handle.stat()))
        .then((stats) => {
          if (monitoring && stats.some(({ size }) => size > maxBuffer)) {
            limitExceeded = true
            controller.abort()
          }
        })
        .catch((error) => {
          monitoringFailure = error
          controller.abort()
        })
        .finally(() => {
          pending = undefined
        })
    }, 20)
    let completed, failure
    try {
      completed = await runGuardedCommand({
        command,
        args,
        cwd,
        env,
        timeoutMs: timeout,
        stdio: ['ignore', handles[0].fd, handles[1].fd],
        signal: controller.signal,
      })
    } catch (error) {
      failure = error
    } finally {
      monitoring = false
      clearInterval(monitor)
      await pending
    }
    const captured = []
    for (const handle of handles) {
      const { size } = await handle.stat()
      const buffer = Buffer.alloc(Math.min(size, maxBuffer))
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        assert(bytesRead > 0, 'Command output changed while being read')
        offset += bytesRead
      }
      captured.push({ text: buffer.toString('utf8'), bytes: size, truncated: size > maxBuffer })
    }
    const [stdout, stderr] = captured
    const truncated = limitExceeded || stdout.truncated || stderr.truncated
    const exitCode = completed?.code ?? failure?.code ?? null
    return {
      exitCode: truncated
        ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        : monitoringFailure
          ? null
          : exitCode,
      signal: completed?.signal ?? failure?.signal ?? null,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut: failure?.timedOut === true,
      ...(failure || monitoringFailure ? { error: String(monitoringFailure ?? failure) } : {}),
      ...(truncated
        ? {
            error: `Command output exceeds maxBuffer (${maxBuffer} bytes per stream)${failure ? `; ${failure}` : ''}`,
            processExitCode: exitCode,
            outputTruncated: { stdout: stdout.truncated, stderr: stderr.truncated },
          }
        : {}),
    }
  } finally {
    try {
      await Promise.all(handles.map((handle) => handle.close()))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
