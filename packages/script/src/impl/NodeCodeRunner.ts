import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isEmpty,
  isPlainObject,
  isString,
  isUndefined,
  Log,
  optionalWhen,
  stringifyPretty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { NodeExecutionLimits } from '../contract/constants.js'
import type { CodeRunnerApi, NodeCodeRunnerOptions } from '../contract/requires.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'
import { shapeOperationFailure } from '../utils/capability-failure.js'
import { nodeCapabilityClient } from '../utils/node-client.js'

/** 一次标准 Node 程序；宿主端口承担操作系统权限与进程树所有权。 */
class NodeCodeRunner implements CodeRunnerApi {
  public readonly environment = 'node' as const

  public constructor(private readonly options: NodeCodeRunnerOptions) {}

  public async run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (text: string) => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome> {
    const failure = (code: string, message: string): CodeRunOutcome => ({
      ok: false,
      logs: [],
      error: { code, message },
    })
    if (signal?.aborted) return failure('ABORTED', '执行已取消。')
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
      return failure('TIMEOUT', '需要有限的执行时限。')
    if (
      !isEmpty(Object.keys(request.modules)) ||
      !isEmpty(Object.keys(request.blobs)) ||
      !isUndefined(request.input)
    )
      return failure('PROGRAM_ERROR', '标准 Node 程序通过普通文件读写模块、参数和跨轮状态。')
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    let directory: string | undefined
    let socketDirectory: string | undefined
    let log: number | undefined
    let logBytes = 0
    let logTruncated = false
    const timers = new TimerScope({ name: 'NodeCodeRunner' })
    let timer: Optional<TimerLease>
    let remaining = request.timeoutMs
    let started = 0
    let holds = 0
    let stopping = false
    let timedOut = false
    let calls = 0
    const pending = new Set<number>()
    const arm = () => {
      if (stopping || controller.signal.aborted) return
      started = performance.now()
      timer = timers.after(Math.max(0, remaining), () => {
        timedOut = true
        controller.abort(new AppError('TIMEOUT', 'Node 程序达到执行时限。'))
      })
    }
    const holdClock = () => {
      if (holds++ === 0) {
        timer?.cancel()
        remaining -= performance.now() - started
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (--holds === 0) arm()
      }
    }
    const token = randomBytes(32).toString('hex')
    const server = createServer((incoming, response) => {
      const reply = (status: number, value: unknown) => {
        if (response.destroyed || response.writableEnded) return
        const body = JSON.stringify(value)
        if (Buffer.byteLength(body) > NodeExecutionLimits.responseBytes) {
          response.writeHead(413, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              error: { code: 'LIMIT', message: '能力结果超过传输预算，请缩小查询。' },
            })
          )
        } else {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(body)
        }
      }
      if (
        stopping ||
        controller.signal.aborted ||
        incoming.method !== 'POST' ||
        incoming.url !== '/' ||
        incoming.headers.authorization !== `Bearer ${token}`
      ) {
        reply(403, { error: { code: 'PERMISSION', message: '当前执行没有此能力桥授权。' } })
        incoming.resume()
        return
      }
      if (++calls > NodeExecutionLimits.calls || pending.size >= 32) {
        reply(429, { error: { code: 'LIMIT', message: '能力调用超过本次预算。' } })
        incoming.resume()
        return
      }
      const callId = calls
      let body = ''
      let bytes = 0
      incoming.setEncoding('utf8')
      incoming.on('error', () => response.destroy())
      incoming.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > NodeExecutionLimits.requestBytes) {
          reply(413, { error: { code: 'LIMIT', message: '能力参数超过传输预算。' } })
          incoming.destroy()
        } else body += chunk
      })
      incoming.on('end', () => {
        if (stopping || controller.signal.aborted || response.writableEnded) return
        let input: unknown
        try {
          input = JSON.parse(body)
        } catch {
          reply(400, { error: { code: 'VALIDATION', message: '需要 JSON 请求。' } })
          return
        }
        if (
          !isPlainObject(input) ||
          !isString(input.namespace) ||
          !isString(input.operation) ||
          !Object.hasOwn(request.operations, input.namespace) ||
          !request.operations[input.namespace]!.includes(input.operation)
        ) {
          reply(403, { error: { code: 'PERMISSION', message: '操作不在当前会话的授权目录。' } })
          return
        }
        pending.add(callId)
        void dispatch(
          { callId, namespace: input.namespace, operation: input.operation, input: input.input },
          holdClock
        )
          .then(
            (value) => reply(200, value),
            (error) => reply(500, { error: { code: 'OPERATION_FAILED', message: String(error) } })
          )
          .finally(() => pending.delete(callId))
      })
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    server.maxConnections = 64
    try {
      controller.signal.throwIfAborted()
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      directory = await mkdtemp(join(this.options.directory, 'node-'))
      const catalog = join(directory, 'host')
      await mkdir(catalog, { mode: 0o700 })
      const index: Array<{
        module: string
        summary: string
        client: string
        documentation: string
        operations: readonly string[]
      }> = []
      for (const [namespace, operations] of Object.entries(request.operations)) {
        const name = `${index.length}-${namespace.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
        const client = `${name}.mjs`
        const documentation = `${name}.d.ts`
        await writeFile(join(catalog, client), nodeCapabilityClient(namespace, operations), {
          mode: 0o600,
        })
        await writeFile(
          join(catalog, documentation),
          request.host?.modules[namespace]?.declarations ?? '',
          { mode: 0o600 }
        )
        index.push({
          module: namespace,
          summary: request.host?.modules[namespace]?.summary ?? namespace,
          client,
          documentation,
          operations,
        })
      }
      await writeFile(join(catalog, 'index.json'), stringifyPretty(index), { mode: 0o600 })
      const socket =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\velaros-node-${randomUUID()}`
          : join((socketDirectory = await mkdtemp(join(tmpdir(), 'vn-'))), 'rpc.sock')
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socket, () => {
          server.off('error', reject)
          resolve()
        })
      })
      server.on('error', (error) => controller.abort(error))
      const logPath = join(directory, 'output.log')
      log = openSync(logPath, 'wx', 0o600)
      controller.signal.throwIfAborted()
      const processRequest = {
        source: request.source,
        cwd: this.options.cwd,
        sessionId: request.host?.sessionId,
        executionId: request.host?.executionId,
        environment: {
          VELAROS_HOST_DIR: catalog,
          VELAROS_HOST_SOCKET: socket,
          VELAROS_HOST_TOKEN: token,
        },
      }
      await this.options.authorize?.(processRequest, controller.signal)
      controller.signal.throwIfAborted()
      arm()
      const result = await this.options.execute(
        processRequest,
        (text) => {
          if (stopping || isUndefined(log)) return
          try {
            const buffer = Buffer.from(text)
            const stored = buffer.subarray(0, Math.max(0, NodeExecutionLimits.logBytes - logBytes))
            if (stored.length) writeSync(log, stored)
            logBytes += stored.length
            if (stored.length < buffer.length) {
              logTruncated = true
              controller.abort(new AppError('LIMIT', '输出归档达到上限，程序已停止。'))
            }
            onLog(text.slice(-NodeExecutionLimits.previewChars))
          } catch (error) {
            Log.tag('NodeCodeRunner').caught('无法归档或投递进程输出，执行已取消', error)
            controller.abort(error)
          }
        },
        controller.signal
      )
      const code =
        timedOut || result.timedOut
          ? 'TIMEOUT'
          : logTruncated
            ? 'TOO_LARGE'
            : signal?.aborted || result.aborted
              ? 'ABORTED'
              : result.cleanupIncomplete
                ? 'RUNNER_CRASHED'
                : 'PROGRAM_ERROR'
      const ok =
        result.exitCode === 0 &&
        !controller.signal.aborted &&
        !result.aborted &&
        !result.timedOut &&
        !result.cleanupIncomplete
      return {
        ok,
        logs: [],
        pendingCalls: [...pending],
        process: {
          ...result,
          stdout: result.stdout.slice(-NodeExecutionLimits.previewChars),
          stderr: result.stderr.slice(-NodeExecutionLimits.previewChars),
          logPath,
          logBytes,
          logTruncated,
          launched: true,
        },
        error: optionalWhen(!ok, {
          code,
          message: `Node 执行失败：${code}；exitCode=${result.exitCode}；signal=${result.signal ?? 'none'}。查看 stderr 与 ${logPath}。`,
        }),
      }
    } catch (error) {
      return {
        ...failure(signal?.aborted ? 'ABORTED' : shapeOperationFailure(error).code, String(error)),
        pendingCalls: [...pending],
      }
    } finally {
      stopping = true
      timers.dispose()
      signal?.removeEventListener('abort', cancel)
      controller.abort(new AppError('CANCELLED', '执行已经结束。'))
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      if (!isUndefined(log)) closeSync(log)
      if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true })
    }
  }
}

/** 宿主显式选择并注入经批准的标准 Node 进程环境。 */
export function createNodeCodeRunner(options: NodeCodeRunnerOptions): CodeRunnerApi {
  return new NodeCodeRunner(options)
}
