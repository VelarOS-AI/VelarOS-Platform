import { delimiter, dirname } from 'node:path'

import { execa } from 'execa'

import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { NodeExecutionLimits } from '../contract/constants.js'
import type { NodeProcessRequest, NodeProcessResult } from '../types/script.js'

import { resolveNodeExecutable } from './node-executable.js'

/** 独立 Node 库入口的 POSIX 进程组宿主；产品宿主通过 NodeCodeRunnerOptions 注入自己的平台约束。 */
export function executeNativeNode(
  request: NodeProcessRequest,
  onOutput: (text: string) => void,
  signal: AbortSignal
): Promise<NodeProcessResult> {
  signal.throwIfAborted()
  const node = resolveNodeExecutable()
  if (!node || process.platform === 'win32' || request.mode === 'observe')
    throw new AppError('UNAVAILABLE', '此执行需要宿主提供支持当前平台和权限范围的 Node 进程端口')
  const environment = { ...process.env, ...request.environment }
  environment.PATH = [dirname(node), ...(request.binDirectories ?? []), environment.PATH]
    .filter(Boolean)
    .join(delimiter)
  if (request.preload)
    environment.NODE_OPTIONS =
      `${environment.NODE_OPTIONS ?? ''} --import ${JSON.stringify(request.preload)}`.trim()
  return new Promise((resolve, reject) => {
    const child = execa(
      node,
      [
        '--max-old-space-size=512',
        ...(request.entrypoint ? [request.entrypoint] : ['--input-type=module']),
      ],
      {
        cwd: request.cwd,
        env: environment,
        detached: true,
        stdio: 'pipe',
        reject: false,
        buffer: false,
        cleanup: false,
        extendEnv: false,
      }
    )
    let stdout = ''
    let stderr = ''
    let truncated = false
    let failure: unknown
    let cleanupIncomplete = false
    const stop = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          cleanupIncomplete = true
          Log.tag('NodeProcess').caught('无法收束进程组', error)
        }
      }
    }
    const receive = (kind: 'stdout' | 'stderr', text: string) => {
      if (kind === 'stdout') {
        stdout += text
        if (stdout.length > NodeExecutionLimits.previewChars) truncated = true
        stdout = stdout.slice(-NodeExecutionLimits.previewChars)
      } else {
        stderr += text
        if (stderr.length > NodeExecutionLimits.previewChars) truncated = true
        stderr = stderr.slice(-NodeExecutionLimits.previewChars)
      }
      onOutput(text)
    }
    child.stdout.setEncoding('utf8').on('data', (text: string) => receive('stdout', text))
    child.stderr.setEncoding('utf8').on('data', (text: string) => receive('stderr', text))
    void child.catch((error) => {
      failure = error
      stop()
    })
    child.once('error', (error) => {
      failure = error
    })
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        failure = error
        stop()
      }
    })
    child.once('spawn', () => {
      if (signal.aborted) stop()
    })
    signal.addEventListener('abort', stop, { once: true })
    // 根进程退出时仍可能留有继承管道的后代；先收束进程组，再等待 close 排空管道。
    child.once('exit', stop)
    child.once('close', (exitCode, exitSignal) => {
      signal.removeEventListener('abort', stop)
      if (failure) reject(failure)
      else
        resolve({
          exitCode,
          signal: exitSignal,
          stdout,
          stderr,
          truncated,
          cleanupIncomplete,
          aborted: signal.aborted,
        })
    })
    child.stdin.end(request.entrypoint ? undefined : (request.bootstrap ?? request.source))
  })
}
