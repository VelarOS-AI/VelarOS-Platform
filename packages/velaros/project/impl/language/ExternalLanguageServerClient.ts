import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isArray, isNull, isNumber, isPlainObject, isString, Log } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  ExternalLanguageDiagnosticsOutcome,
  ExternalLanguageOpenDocument,
  ExternalLanguagePendingDiagnostics,
  ExternalLanguagePendingResponse,
} from '../../types/external-language.js'
import type {
  ExternalLanguageHover,
  ExternalLanguageLocation,
  ExternalLanguageServerSpec,
  ExternalLanguageStatus,
} from '../../types/project.js'
import {
  abortError,
  encodeLspFrame,
  errorMessage,
  filePathFromUri,
  markupText,
  normalizeLspDiagnostic,
  normalizeLspLocation,
  notifyLanguageServer,
  positionParams,
} from '../../utils/language/lsp.js'
import { DevelopmentTuning } from '../../utils/tuning.js'

const log = Log.tag('ExternalLanguageServerClient')

/**
 * 一个外部语言服务进程的 stdio JSON-RPC 客户端：拉起、握手、开文档、问一件事、收摊。
 *
 * 实例由 `ExternalLanguageService` 按规格各造一个，所以这里不给单例。所有等待都有超时租约，
 * 进程挂掉时在等的请求一律被拒、在等的诊断一律按空结果收尾，不会把调用方吊死。
 */
export interface ExternalLanguageServerClientApi {
  /** 这个客户端对应的语言服务规格。 */
  readonly spec: ExternalLanguageServerSpec
  /** 本客户端的状态；完整性由上层按整批文件统计，这里恒报完整。 */
  status(): ExternalLanguageStatus
  /** 拉起进程并完成 initialize 握手；已经起来了就直接返回，启动失败时抛错。 */
  start(signal?: AbortSignal): Promise<void>
  /** 同步一个文件的正文并等它的诊断；返回诊断以及「是不是等到超时才收摊」。 */
  diagnostics(file: string, signal?: AbortSignal): Promise<ExternalLanguageDiagnosticsOutcome>
  /** 问一个位置的悬停说明；语言服务没有内容时给 `null`。 */
  hover(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<Nullable<ExternalLanguageHover>>
  /** 问一个位置的定义或引用；`method` 决定问哪一件。 */
  locations(
    method: 'textDocument/definition' | 'textDocument/references',
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageLocation[]>
  /** 走 shutdown / exit 握手关掉进程；握手不成就终止它，最后一定释放定时器。 */
  stop(): Promise<void>
}

/** 一个外部语言服务进程的客户端，见接口说明；由 `ExternalLanguageService` 按规格各造一个。 */
export class ExternalLanguageServerClient implements ExternalLanguageServerClientApi {
  private child: Nullable<ChildProcessWithoutNullStreams> = null
  private readonly timers = new TimerScope({ name: 'ExternalLanguageServerClient' })
  private sequence = 0
  private stdout = Buffer.alloc(0)
  private readonly responses = new Map<number, ExternalLanguagePendingResponse>()
  private readonly pendingDiagnostics = new Map<string, ExternalLanguagePendingDiagnostics[]>()
  private readonly documents = new Map<string, ExternalLanguageOpenDocument>()
  private state: ExternalLanguageStatus['state'] = 'idle'
  private error: Nullable<string> = null

  /** 握手时报给语言服务的客户端身份，与 VelarOS 的版本无关，不随发版变。 */
  private static readonly clientInfo = { name: 'VelarOS Agent Host', version: '0.1.0' }

  /** 工作区在握手里的名字。 */
  private static readonly workspaceName = 'VelarOS Agent project'

  public constructor(
    private readonly projectRoot: string,
    public readonly spec: ExternalLanguageServerSpec
  ) {}

  public status(): ExternalLanguageStatus {
    return {
      state: this.state,
      server: this.spec.id,
      openFiles: this.documents.size,
      error: this.error,
      // 单个客户端不汇总超时，完整性由上层 ExternalLanguageService 按整批文件统计。
      diagnosticsTimedOutFiles: 0,
      diagnosticsComplete: true,
    }
  }

  public async start(signal?: AbortSignal): Promise<void> {
    if (this.child) return
    if (signal?.aborted) throw abortError()
    const child = spawn(this.spec.command, [...this.spec.args], {
      cwd: resolve(this.projectRoot),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message)
        this.error = message.slice(0, DevelopmentTuning.externalLanguageServer.stderrChars)
    })
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, exitSignal) => {
      if (this.child !== child) return
      this.child = null
      this.fail(new Error(`语言服务 ${this.spec.id} 已退出（${code ?? exitSignal ?? '原因未知'}）。`))
    })
    const rootUri = pathToFileURL(resolve(this.projectRoot)).href
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: ExternalLanguageServerClient.workspaceName }],
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
          },
        },
        clientInfo: ExternalLanguageServerClient.clientInfo,
      },
      signal
    )
    this.notify('initialized', {})
    this.state = 'ready'
    this.error = null
  }

  public async diagnostics(
    file: string,
    signal?: AbortSignal
  ): Promise<ExternalLanguageDiagnosticsOutcome> {
    const uri = pathToFileURL(file).href
    let timedOut = false
    const waiting = new Promise<ExternalLanguageDiagnosticsOutcome['diagnostics']>(
      (resolveDone, reject) => {
        if (signal?.aborted) {
          reject(abortError())
          return
        }
        const finish = (
          value: ExternalLanguageDiagnosticsOutcome['diagnostics'],
          error?: Error
        ): void => {
          const entries = this.pendingDiagnostics.get(uri)
          if (!entries) return
          const index = entries.indexOf(pending)
          if (index >= 0) entries.splice(index, 1)
          if (entries.length === 0) this.pendingDiagnostics.delete(uri)
          pending.timer.cancel()
          signal?.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolveDone(value)
        }
        const onAbort = (): void => finish([], abortError())
        const pending: ExternalLanguagePendingDiagnostics = {
          resolve: finish,
          timer: this.timers.after(
            DevelopmentTuning.externalLanguageServer.diagnosticsTimeoutMs,
            () => {
              timedOut = true
              finish([])
            },
            { label: `${this.spec.id}.diagnostics` }
          ),
        }
        const entries = this.pendingDiagnostics.get(uri) ?? []
        entries.push(pending)
        this.pendingDiagnostics.set(uri, entries)
        signal?.addEventListener('abort', onAbort, { once: true })
      }
    )
    await this.open(file)
    return { diagnostics: await waiting, timedOut }
  }

  public async hover(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<Nullable<ExternalLanguageHover>> {
    await this.open(file)
    const value = await this.request(
      'textDocument/hover',
      positionParams(file, line, column),
      signal
    )
    if (!isPlainObject(value)) return null
    const display = markupText(value.contents)
    if (!display) return null
    return { path: file, line, column, kind: null, display, documentation: '' }
  }

  public async locations(
    method: 'textDocument/definition' | 'textDocument/references',
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal
  ): Promise<readonly ExternalLanguageLocation[]> {
    await this.open(file)
    const params =
      method === 'textDocument/references'
        ? { ...positionParams(file, line, column), context: { includeDeclaration: true } }
        : positionParams(file, line, column)
    const value = await this.request(method, params, signal)
    const entries = isArray(value) ? value : value ? [value] : []
    return entries.flatMap((entry) => {
      const location = normalizeLspLocation(entry)
      return location ? [location] : []
    })
  }

  public async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.state = 'idle'
    if (!child) {
      this.timers.dispose()
      return
    }
    try {
      await this.requestWithChild(
        child,
        'shutdown',
        {},
        undefined,
        DevelopmentTuning.externalLanguageServer.shutdownTimeoutMs
      )
      notifyLanguageServer(child, 'exit', {})
    } catch (error) {
      log.debug('语言服务关闭握手失败，改为终止进程。', { error, server: this.spec.id })
      child.kill('SIGTERM')
    }
    child.stdin.end()
    await Promise.race([
      new Promise<void>((resolveDone) => child.once('exit', () => resolveDone())),
      this.timers.sleep(DevelopmentTuning.externalLanguageServer.shutdownTimeoutMs, {
        label: `${this.spec.id}.stop`,
      }),
    ])
    if (isNull(child.exitCode) && isNull(child.signalCode)) child.kill('SIGKILL')
    this.timers.dispose()
  }

  /** 首次打开发 didOpen，之后每次同步正文发 didChange 并把版本号加一。 */
  private async open(file: string): Promise<void> {
    const uri = pathToFileURL(file).href
    const text = await readFile(file, 'utf8')
    const current = this.documents.get(file)
    if (!current) {
      this.documents.set(file, { languageId: this.spec.languageId, version: 1 })
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.spec.languageId, version: 1, text },
      })
      return
    }
    current.version += 1
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: current.version },
      contentChanges: [{ text }],
    })
  }

  /** 发一条请求；进程没起来就直接拒。 */
  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error(`语言服务 ${this.spec.id} 没有在运行。`))
    return this.requestWithChild(child, method, params, signal)
  }

  /** 发一条请求给指定进程，带超时与中止；收尾时一定摘掉定时器与监听器。 */
  private requestWithChild(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs: number = DevelopmentTuning.externalLanguageServer.requestTimeoutMs
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError())
    const id = ++this.sequence
    child.stdin.write(encodeLspFrame({ jsonrpc: '2.0', id, method, params }))
    return new Promise((resolveDone, reject) => {
      const finish = (value?: unknown, error?: Error): void => {
        const pending = this.responses.get(id)
        if (!pending) return
        this.responses.delete(id)
        pending.timer.cancel()
        pending.removeAbort()
        if (error) reject(error)
        else resolveDone(value)
      }
      const onAbort = (): void => finish(undefined, abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
      this.responses.set(id, {
        resolve: (value) => finish(value),
        reject: (error) => finish(undefined, error),
        timer: this.timers.after(
          timeoutMs,
          () => finish(undefined, new Error(`语言服务 ${this.spec.id} 的 ${method} 请求超时。`)),
          { label: `${this.spec.id}.${method}` }
        ),
        removeAbort: () => signal?.removeEventListener('abort', onAbort),
      })
    })
  }

  /** 发一条通知（不等回执）；进程没起来就抛。 */
  private notify(method: string, params: unknown): void {
    const child = this.child
    if (!child) throw new Error(`语言服务 ${this.spec.id} 没有在运行。`)
    notifyLanguageServer(child, method, params)
  }

  /** 攒 stdout 并逐帧切出完整消息；帧头缺失就跳过这一段。 */
  private consumeStdout(chunk: Buffer): void {
    this.stdout = Buffer.concat([this.stdout, chunk])
    for (;;) {
      const headerEnd = this.stdout.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.stdout.subarray(0, headerEnd).toString('ascii')
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)
      if (!match) {
        this.stdout = this.stdout.subarray(headerEnd + 4)
        continue
      }
      const length = Number.parseInt(match[1]!, 10)
      const start = headerEnd + 4
      if (this.stdout.length < start + length) return
      const body = this.stdout.subarray(start, start + length).toString('utf8')
      this.stdout = this.stdout.subarray(start + length)
      try {
        this.handleMessage(JSON.parse(body) as unknown)
      } catch (error) {
        this.error = `语言服务 ${this.spec.id} 发来的消息不是合法 JSON：${errorMessage(error)}`
        log.debug('语言服务忽略了非法的 JSON-RPC 消息。', { error, server: this.spec.id })
      }
    }
  }

  /** 分派一条消息：请求回执兑现在等的请求，publishDiagnostics 兑现在等的诊断。 */
  private handleMessage(value: unknown): void {
    if (!isPlainObject(value)) return
    if (isNumber(value.id) && ('result' in value || 'error' in value)) {
      const pending = this.responses.get(value.id)
      if (!pending) return
      if (isPlainObject(value.error)) {
        pending.reject(
          new Error(isString(value.error.message) ? value.error.message : '语言服务请求失败。')
        )
      } else {
        pending.resolve(value.result)
      }
      return
    }
    if (value.method !== 'textDocument/publishDiagnostics' || !isPlainObject(value.params)) return
    const uri = isString(value.params.uri) ? value.params.uri : null
    if (!uri) return
    const path = filePathFromUri(uri, this.spec.id)
    if (!path) return
    const diagnostics = isArray(value.params.diagnostics)
      ? value.params.diagnostics.flatMap((entry) => {
          const normalized = normalizeLspDiagnostic(path, this.spec.id, entry)
          return normalized ? [normalized] : []
        })
      : []
    for (const pending of this.pendingDiagnostics.get(uri) ?? []) pending.resolve(diagnostics)
  }

  /** 进程出错或退出：在等的请求全部拒掉，在等的诊断按空结果收尾。 */
  private fail(error: Error): void {
    this.state = 'error'
    this.error = error.message
    for (const pending of this.responses.values()) pending.reject(error)
    for (const entries of this.pendingDiagnostics.values()) {
      for (const pending of entries) pending.resolve([])
    }
  }
}
