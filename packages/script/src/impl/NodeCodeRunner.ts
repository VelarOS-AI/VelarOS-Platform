import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  isArray,
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

import {
  CodeSurfaceLimits,
  NodeExecutionLimits,
  ScriptOutputLimits,
} from '../contract/constants.js'
import type {
  CodeRunnerApi,
  NodeCodeRunnerOptions,
  NodeRuntimeLease,
} from '../contract/requires.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'
import { shapeExecutionStop, shapeOperationFailure } from '../utils/capability-failure.js'
import {
  nodeCapabilityBridge,
  nodeCapabilityClient,
  nodeCapabilityDeclarations,
  nodeOperationDeclarations,
} from '../utils/node-client.js'
import { nodeProgramSource } from '../utils/node-program.js'
import { createOutputCollector, validateOutputOptions } from '../utils/output-capture.js'
import { describeChildExit } from '../utils/process-error.js'

import { nodeRuntimePackages } from './NodeRuntimePackages.js'

/** 一次标准 Node 程序；宿主端口承担操作系统权限与进程树所有权。 */
class NodeCodeRunner implements CodeRunnerApi {
  public readonly environment = 'node' as const

  public constructor(private readonly options: NodeCodeRunnerOptions) {}

  public get cwd(): string {
    return this.options.cwd
  }

  public async run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (text: string, stream?: 'stdout' | 'stderr' | 'combined') => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome> {
    const failure = (code: string, message: string): CodeRunOutcome => ({
      ok: false,
      logs: [],
      error: { code, message },
    })
    if (signal?.aborted) {
      const stopped = shapeExecutionStop(signal.reason)
      return failure(stopped.code, stopped.message)
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
      return failure('TIMEOUT', '需要有限的执行时限。')
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    let directory: string | undefined
    let runtimeLease: NodeRuntimeLease | undefined
    let processStarted = false
    let processSettled = false
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
    let pendingAtStop: number[] | undefined
    controller.signal.addEventListener(
      'abort',
      () => {
        pendingAtStop ??= [...pending]
      },
      { once: true }
    )
    const output = createOutputCollector(ScriptOutputLimits, validateOutputOptions, () => {})
    let value: unknown
    let programError: CodeRunOutcome['error']
    let outputFile: string | undefined
    let packageCatalog: string | undefined
    let packagesPublished = false
    const outputIssues: string[] = []
    const collectOutput = async () => {
      if (!outputFile) return
      if ((await stat(outputFile)).size > NodeExecutionLimits.outputBytes)
        throw new AppError('TOO_LARGE', '结构化输出超过采集上限')
      for (const line of (await readFile(outputFile, 'utf8')).split('\n').filter(Boolean)) {
        const event = JSON.parse(line)
        if (event.config) output.output.configure(event.config)
        if (event.block) output.output(event.block.value, event.block.options)
        if (event.issue) {
          outputIssues.push(String(event.issue))
          programError = { code: 'PROGRAM_ERROR', message: String(event.issue) }
        }
      }
    }
    const arm = () => {
      if (stopping || controller.signal.aborted) return
      started = performance.now()
      timer = timers.after(Math.max(0, remaining), () => {
        timedOut = true
        controller.abort(new AppError('TIMEOUT', `Node 程序达到执行时限 ${request.timeoutMs} ms。`))
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
        incoming.method !== 'POST' ||
        !['/', '/result', '/packages'].includes(incoming.url ?? '') ||
        (incoming.url === '/packages' && packagesPublished) ||
        incoming.headers.authorization !== `Bearer ${token}`
      ) {
        reply(403, { error: { code: 'PERMISSION', message: '当前执行没有此能力桥授权。' } })
        incoming.resume()
        return
      }
      if (stopping || controller.signal.aborted) {
        reply(409, { error: shapeExecutionStop(controller.signal.reason) })
        incoming.resume()
        return
      }
      if (incoming.url === '/packages') packagesPublished = true
      if (incoming.url === '/' && (++calls > NodeExecutionLimits.calls || pending.size >= 32)) {
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
        if (response.writableEnded) return
        if (stopping || controller.signal.aborted) {
          reply(409, { error: shapeExecutionStop(controller.signal.reason) })
          return
        }
        let input: unknown
        try {
          input = JSON.parse(body)
        } catch {
          reply(400, { error: { code: 'VALIDATION', message: '需要 JSON 请求。' } })
          return
        }
        if (incoming.url !== '/' && isPlainObject(input)) {
          if (incoming.url === '/packages' && packageCatalog) {
            const path = packageCatalog
            // 子进程只发现实际依赖；内部目录由宿主写入，观察进程仍保持只读权限。
            void readFile(path, 'utf8')
              .then(async (body) => {
                const catalog = JSON.parse(body)
                if (
                  !isArray(input.packages) ||
                  input.packages.length !== catalog.packages.length ||
                  input.packages.some(
                    (pkg, index) => !isPlainObject(pkg) || pkg.name !== catalog.packages[index].name
                  )
                )
                  throw new AppError('VALIDATION', '依赖发现目录与本次运行环境不匹配')
                const execution = input.execution
                if (
                  !isPlainObject(execution) ||
                  !['node', 'executable', 'platform', 'arch', 'cwd'].every((key) =>
                    isString(execution[key])
                  ) ||
                  !isArray(execution.path) ||
                  !execution.path.every(isString)
                )
                  throw new AppError('VALIDATION', '执行环境发现缺少实际 Node 身份或命令路径')
                await writeFile(
                  path,
                  stringifyPretty({
                    ...catalog,
                    packages: input.packages,
                    execution: {
                      node: execution.node,
                      executable: execution.executable,
                      platform: execution.platform,
                      arch: execution.arch,
                      cwd: execution.cwd,
                      path: execution.path,
                    },
                  })
                )
                reply(200, {})
              })
              .catch((cause: unknown) => reply(400, { error: shapeOperationFailure(cause) }))
            return
          }
          try {
            if (incoming.url === '/result') {
              if (JSON.stringify(input).length > ScriptOutputLimits.rawChars)
                throw new AppError('TOO_LARGE', '程序返回值超过归档上限')
              value = input.value
              if (isPlainObject(input.error))
                programError = {
                  code: String(input.error.code),
                  message: String(input.error.message),
                  line: optionalWhen(
                    Number.isSafeInteger(input.error.line),
                    Number(input.error.line)
                  ),
                }
            }
            reply(200, {})
          } catch (error) {
            programError = shapeOperationFailure(error)
            reply(400, { error: programError })
          }
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
    // Bun 的 HTTP 监听暂不支持 Windows 管道；net 接受连接，HTTP 解析、鉴权与响应仍走同一个 server。
    const pipeConnections = new Set<Socket>()
    const pipeServer =
      process.platform === 'win32' && process.versions.bun && server.listenerCount('connection') > 0
        ? createNetServer((connection) => {
            pipeConnections.add(connection)
            connection.once('close', () => pipeConnections.delete(connection))
            server.emit('connection', connection)
          })
        : undefined
    const listener = pipeServer ?? server
    listener.maxConnections = 64
    try {
      if (process.platform === 'win32' && process.versions.bun && !pipeServer)
        throw new AppError(
          'UNAVAILABLE',
          '当前 Bun 不支持通过本地命名管道处理 HTTP 连接；请使用 Node 宿主或支持此连接处理器的 Bun。'
        )
      controller.signal.throwIfAborted()
      // 准备不使用运行期的停表时钟；控制调用取消后不得继续生成整份能力目录。
      const preparation = timers.after(
        Math.min(request.timeoutMs, CodeSurfaceLimits.timeoutMs),
        () => {
          timedOut = true
          controller.abort(new AppError('TIMEOUT', 'Node 执行环境准备超过时限。'))
        }
      )
      runtimeLease = await this.options.acquireRuntime?.(controller.signal)
      controller.signal.throwIfAborted()
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      controller.signal.throwIfAborted()
      directory = await realpath(await mkdtemp(join(this.options.directory, 'node-')))
      controller.signal.throwIfAborted()
      const catalog = join(directory, 'host')
      packageCatalog = join(catalog, 'index.json')
      await mkdir(catalog, { mode: 0o700 })
      controller.signal.throwIfAborted()
      await writeFile(join(catalog, 'bridge.mjs'), nodeCapabilityBridge(), {
        mode: 0o600,
        signal: controller.signal,
      })
      const index: Array<{
        module: string
        member?: string
        namespace?: string
        summary: string
        client: string
        documentation: string
        documentationPath: string
        operationPaths: Readonly<Record<string, string>>
        operations: readonly string[]
        operationDirectory?: string
      }> = []
      const clients: Record<string, string> = Object.create(null)
      for (const [namespace, operations] of Object.entries(request.operations)) {
        controller.signal.throwIfAborted()
        const name = `host-${encodeURIComponent(namespace)}`
        const client = `${name}.mjs`
        const documentation = `${name}.d.ts`
        const operationDirectory = `${name}-operations`
        const operationDocs = nodeOperationDeclarations(
          request.host?.modules[namespace]?.declarations ?? '',
          namespace,
          operations
        )
        controller.signal.throwIfAborted()
        if (!isEmpty(Object.keys(operationDocs))) {
          await mkdir(join(catalog, operationDirectory), { mode: 0o700 })
          for (const [operation, text] of Object.entries(operationDocs)) {
            controller.signal.throwIfAborted()
            await writeFile(
              join(catalog, operationDirectory, `${encodeURIComponent(operation)}.d.ts`),
              text,
              { mode: 0o600, signal: controller.signal }
            )
          }
        }
        controller.signal.throwIfAborted()
        clients[namespace] = client
        await writeFile(join(catalog, client), nodeCapabilityClient(namespace, operations), {
          mode: 0o600,
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        await writeFile(
          join(catalog, documentation),
          nodeCapabilityDeclarations(
            request.host?.modules[namespace]?.declarations ?? '',
            namespace
          ),
          { mode: 0o600, signal: controller.signal }
        )
        const entry = {
          module: namespace,
          summary: request.host?.modules[namespace]?.summary ?? namespace,
          client,
          documentation,
          documentationPath: join(catalog, documentation),
          operationPaths: Object.fromEntries(
            Object.keys(operationDocs).map((operation) => [
              operation,
              join(catalog, operationDirectory, `${encodeURIComponent(operation)}.d.ts`),
            ])
          ),
          operations,
          operationDirectory: optionalWhen(
            !isEmpty(Object.keys(operationDocs)),
            operationDirectory
          ),
        }
        index.push(entry)
        // 组合包的公开导入和底层模块共享同一份声明，发现面与实际 exports 保持一致。
        for (const pkg of request.packages ?? [])
          for (const [member, target] of Object.entries(pkg.exports))
            if (target === namespace)
              index.push({ ...entry, module: pkg.specifier, member, namespace })
      }
      controller.signal.throwIfAborted()
      await writeFile(
        join(catalog, 'index.json'),
        stringifyPretty({
          environment: runtimeLease?.environment.id ?? this.options.runtime?.id ?? 'base',
          importer: resolve(this.options.cwd, request.path ?? '__velaros_program__.mjs'),
          packages: nodeRuntimePackages.references([
            ...new Map(
              [
                ...nodeRuntimePackages.defaults(this.options.packageDirectory),
                ...(runtimeLease?.environment.packages ?? this.options.runtime?.packages ?? []),
              ].map((pkg) => [pkg.name, pkg])
            ).values(),
          ]),
          skills: (runtimeLease?.environment.skills ?? this.options.runtime?.skills ?? []).map(
            (skill) => ({
              ...skill,
              capabilities: skill.capabilities.filter((module) =>
                Object.hasOwn(request.operations, module)
              ),
            })
          ),
          capabilities: index,
        }),
        { mode: 0o600, signal: controller.signal }
      )
      controller.signal.throwIfAborted()
      const socket =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\velaros-node-${randomUUID()}`
          : join(
              (socketDirectory = await realpath(await mkdtemp(join(tmpdir(), 'vn-')))),
              'rpc.sock'
            )
      controller.signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(socket, () => {
          listener.off('error', reject)
          resolve()
        })
      })
      controller.signal.throwIfAborted()
      server.on('error', (error) => controller.abort(error))
      pipeServer?.on('error', (error) => controller.abort(error))
      const logPath = join(directory, 'output.log')
      log = openSync(logPath, 'wx', 0o600)
      controller.signal.throwIfAborted()
      outputFile = join(directory, 'output.ndjson')
      await writeFile(outputFile, '', { mode: 0o600, signal: controller.signal })
      controller.signal.throwIfAborted()
      const program = await nodeProgramSource(
        request,
        catalog,
        this.options.cwd,
        clients,
        this.options.packageDirectory,
        runtimeLease?.environment ?? this.options.runtime
      )
      controller.signal.throwIfAborted()
      // 用户审批不消耗准备额度，后续执行仍从完整计时额度开始并保留宿主等待停表。
      preparation.cancel()
      const processRequest = {
        binDirectories: runtimeLease?.binDirectories,
        source: request.source,
        language: request.language,
        mode: request.mode,
        bootstrap: program.bootstrap,
        preload: program.preload,
        entrypoint: program.entrypoint,
        cwd: this.options.cwd,
        sessionId: request.host?.sessionId,
        executionId: request.host?.executionId,
        environment: {
          VELAROS_HOST_DIR: catalog,
          VELAROS_OUTPUT_FILE: outputFile,
          VELAROS_HOST_SOCKET: socket,
          VELAROS_HOST_TOKEN: token,
        },
      }
      await this.options.authorize?.(processRequest, controller.signal)
      controller.signal.throwIfAborted()
      arm()
      processStarted = true
      const result = await this.options.execute(
        processRequest,
        (text, stream) => {
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
            onLog(text, stream)
          } catch (error) {
            Log.tag('NodeCodeRunner').caught('无法归档或投递进程输出，执行已取消', error)
            controller.abort(error)
          }
        },
        controller.signal
      )
      processSettled = !result.cleanupIncomplete
      try {
        await collectOutput()
      } catch (error) {
        Log.tag('NodeCodeRunner').caught('结构化输出归档校验失败', error)
        programError = shapeOperationFailure(error)
      }
      const code =
        timedOut || result.timedOut
          ? 'TIMEOUT'
          : logTruncated || /heap out of memory|Allocation failed/u.test(result.stderr)
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
        !result.cleanupIncomplete &&
        !programError
      const snapshot = output.snapshot()
      const captured = { ...snapshot, issues: [...snapshot.issues, ...outputIssues] }
      if (!isEmpty(captured.blocks))
        value = {
          default:
            captured.blocks.length === 1
              ? captured.blocks[0]!.value
              : captured.blocks.map((block) => block.value),
        }
      return {
        ok,
        value,
        output:
          !isEmpty(captured.blocks) ||
          !isEmpty(captured.issues) ||
          !isEmpty(Object.keys(captured.config))
            ? captured
            : undefined,
        logs: [],
        pendingCalls: pendingAtStop ?? [...pending],
        process: {
          ...result,
          stdout: result.stdout.slice(-NodeExecutionLimits.previewChars),
          stderr: result.stderr.slice(-NodeExecutionLimits.previewChars),
          logPath,
          logBytes,
          logTruncated,
          launched: true,
        },
        error: optionalWhen(
          !ok,
          (signal?.aborted ? shapeExecutionStop(signal.reason) : undefined) ??
            programError ??
            (/heap out of memory|Allocation failed/u.test(result.stderr)
              ? describeChildExit(result.exitCode, result.stderr)
              : {
                  code,
                  message: `Node 执行失败：${code}${timedOut ? `（程序计时时限 ${request.timeoutMs} ms，直接等待子进程也计时）` : ''}；exitCode=${result.exitCode}；signal=${result.signal ?? 'none'}。查看 stderr 与 ${logPath}。`,
                })
        ),
      }
    } catch (error) {
      const stopped = signal?.aborted ? shapeExecutionStop(signal.reason) : undefined
      return {
        ...failure(
          stopped?.code ?? (timedOut ? 'TIMEOUT' : shapeOperationFailure(error).code),
          stopped?.message ?? String(error)
        ),
        pendingCalls: pendingAtStop ?? [...pending],
      }
    } finally {
      stopping = true
      timers.dispose()
      signal?.removeEventListener('abort', cancel)
      controller.abort(new AppError('CANCELLED', '执行已经结束。'))
      for (const connection of pipeConnections) connection.destroy()
      server.closeAllConnections()
      if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()))
      if (!isUndefined(log)) closeSync(log)
      if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true })
      if (runtimeLease) {
        try {
          if (!processStarted || processSettled) await runtimeLease.release()
          else await runtimeLease.retain?.()
        } catch (error) {
          Log.tag('NodeCodeRunner').caught('依赖环境租约保留，等待后续回收', error)
        }
      }
    }
  }
}

/** 宿主显式选择并注入经批准的标准 Node 进程环境。 */
export function createNodeCodeRunner(options: NodeCodeRunnerOptions): CodeRunnerApi {
  return new NodeCodeRunner(options)
}
