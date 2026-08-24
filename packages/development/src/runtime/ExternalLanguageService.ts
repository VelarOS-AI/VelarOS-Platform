import { type ChildProcessWithoutNullStreams,spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface ExternalLanguageDiagnostic {
  readonly severity: 'error' | 'warning' | 'info'
  readonly path: string
  readonly line: number
  readonly column: number
  readonly endLine: number | null
  readonly endColumn: number | null
  readonly code: string | null
  readonly source: string
  readonly message: string
}

export interface ExternalLanguageStatus {
  readonly state: 'idle' | 'ready' | 'unavailable' | 'error'
  readonly server: string
  readonly openFiles: number
  readonly error: string | null
}

export interface ExternalLanguageLocation {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly endLine: number | null
  readonly endColumn: number | null
  readonly preview: string | null
}

export interface ExternalLanguageHover {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly kind: string | null
  readonly display: string
  readonly documentation: string
}

export interface ExternalLanguageServerSpec {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  readonly extensions: readonly string[]
  readonly languageId: string
}

export const BuiltinExternalLanguageServers: readonly ExternalLanguageServerSpec[] = [
  { id: 'basedpyright', command: 'basedpyright-langserver', args: ['--stdio'], extensions: ['.py', '.pyi'], languageId: 'python' },
  { id: 'pyright', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py', '.pyi'], languageId: 'python' },
  { id: 'gopls', command: 'gopls', args: ['serve'], extensions: ['.go'], languageId: 'go' },
  { id: 'rust-analyzer', command: 'rust-analyzer', args: [], extensions: ['.rs'], languageId: 'rust' },
  { id: 'clangd', command: 'clangd', args: ['--background-index=0'], extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'], languageId: 'cpp' },
  { id: 'json', command: 'vscode-json-language-server', args: ['--stdio'], extensions: ['.json', '.jsonc'], languageId: 'json' },
  { id: 'css', command: 'vscode-css-language-server', args: ['--stdio'], extensions: ['.css', '.less', '.scss'], languageId: 'css' },
  { id: 'html', command: 'vscode-html-language-server', args: ['--stdio'], extensions: ['.html', '.htm'], languageId: 'html' },
  { id: 'vue', command: 'vue-language-server', args: ['--stdio'], extensions: ['.vue'], languageId: 'vue' },
]

interface PendingResponse {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly removeAbort: () => void
}

interface PendingDiagnostics {
  readonly resolve: (value: readonly ExternalLanguageDiagnostic[]) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface OpenDocument {
  readonly languageId: string
  version: number
}

/** A bounded stdio JSON-RPC client for project language servers already installed by the user. */
export class ExternalLanguageService {
  private readonly clients = new Map<string, ExternalLanguageServerClient>()
  private readonly unavailable = new Map<string, string>()

  public constructor(
    private readonly projectRoot: string,
    private readonly specs: readonly ExternalLanguageServerSpec[] = BuiltinExternalLanguageServers,
  ) {}

  public supports(path: string): boolean {
    const extension = extname(path).toLowerCase()
    return this.specs.some((spec) => spec.extensions.includes(extension))
  }

  public status(): ExternalLanguageStatus {
    const clients = [...this.clients.values()]
    const errors = [...this.unavailable.values()]
    const ready = clients.some((client) => client.status().state === 'ready')
    return {
      state: ready ? 'ready' : errors.length > 0 ? 'unavailable' : 'idle',
      server: clients.map((client) => client.spec.id).join(', ') || 'external',
      openFiles: clients.reduce((total, client) => total + client.status().openFiles, 0),
      error: ready ? null : errors.at(-1) ?? null,
    }
  }

  public async diagnostics(paths: readonly string[], signal?: AbortSignal): Promise<readonly ExternalLanguageDiagnostic[]> {
    const files = await this.resolveFiles(paths)
    const results: ExternalLanguageDiagnostic[] = []
    for (const file of files) {
      const client = await this.clientFor(file, signal)
      if (!client) continue
      results.push(...await client.diagnostics(file, signal))
    }
    return results
  }

  public async hover(path: string, line: number, column: number, signal?: AbortSignal): Promise<ExternalLanguageHover | null> {
    const file = await this.resolveFile(path)
    const client = await this.requireClient(file, signal)
    return client.hover(file, line, column, signal)
  }

  public async definition(path: string, line: number, column: number, signal?: AbortSignal): Promise<readonly ExternalLanguageLocation[]> {
    const file = await this.resolveFile(path)
    const client = await this.requireClient(file, signal)
    return client.locations('textDocument/definition', file, line, column, signal)
  }

  public async references(path: string, line: number, column: number, signal?: AbortSignal): Promise<readonly ExternalLanguageLocation[]> {
    const file = await this.resolveFile(path)
    const client = await this.requireClient(file, signal)
    return client.locations('textDocument/references', file, line, column, signal)
  }

  public async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop()))
    this.clients.clear()
  }

  private async requireClient(file: string, signal?: AbortSignal): Promise<ExternalLanguageServerClient> {
    const client = await this.clientFor(file, signal)
    if (client) return client
    const extension = extname(file).toLowerCase()
    if (!this.supports(file)) throw new Error(`No language-server adapter is registered for ${extension || 'this file type'}.`)
    throw new Error(`No installed language server is available for ${extension}.`)
  }

  private async clientFor(file: string, signal?: AbortSignal): Promise<ExternalLanguageServerClient | null> {
    const extension = extname(file).toLowerCase()
    const candidates = this.specs.filter((spec) => spec.extensions.includes(extension))
    for (const spec of candidates) {
      const existing = this.clients.get(spec.id)
      if (existing) return existing
      if (this.unavailable.has(spec.id)) continue
      const client = new ExternalLanguageServerClient(this.projectRoot, spec)
      try {
        await client.start(signal)
        this.clients.set(spec.id, client)
        return client
      } catch (error) {
        await client.stop().catch(() => undefined)
        this.unavailable.set(spec.id, `${spec.id}: ${errorMessage(error)}`)
      }
    }
    return null
  }

  private async resolveFiles(paths: readonly string[]): Promise<string[]> {
    const files: string[] = []
    for (const path of paths) {
      const file = await this.resolveFile(path)
      if (this.supports(file)) files.push(file)
    }
    return [...new Set(files)]
  }

  private async resolveFile(path: string): Promise<string> {
    const root = await realpath(resolve(this.projectRoot))
    const candidate = await realpath(resolve(root, path))
    const rel = relative(root, candidate)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Language diagnostics path escapes the project boundary: ${path}`)
    }
    return candidate
  }
}

class ExternalLanguageServerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private stdout = Buffer.alloc(0)
  private readonly responses = new Map<number, PendingResponse>()
  private readonly pendingDiagnostics = new Map<string, PendingDiagnostics[]>()
  private readonly documents = new Map<string, OpenDocument>()
  private state: ExternalLanguageStatus['state'] = 'idle'
  private error: string | null = null

  public constructor(
    private readonly projectRoot: string,
    public readonly spec: ExternalLanguageServerSpec,
  ) {}

  public status(): ExternalLanguageStatus {
    return { state: this.state, server: this.spec.id, openFiles: this.documents.size, error: this.error }
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
      if (message) this.error = message.slice(0, 4_000)
    })
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, exitSignal) => {
      if (this.child !== child) return
      this.child = null
      this.fail(new Error(`${this.spec.id} exited (${code ?? exitSignal ?? 'unknown'}).`))
    })
    const rootUri = pathToFileURL(resolve(this.projectRoot)).href
    await this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'VelarOS Agent project' }],
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {},
        },
      },
      clientInfo: { name: 'VelarOS Agent Host', version: '0.1.0' },
    }, signal)
    this.notify('initialized', {})
    this.state = 'ready'
    this.error = null
  }

  public async diagnostics(file: string, signal?: AbortSignal): Promise<readonly ExternalLanguageDiagnostic[]> {
    const uri = pathToFileURL(file).href
    const waiting = new Promise<readonly ExternalLanguageDiagnostic[]>((resolveDone, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const finish = (value: readonly ExternalLanguageDiagnostic[], error?: Error): void => {
        const entries = this.pendingDiagnostics.get(uri)
        if (!entries) return
        const index = entries.indexOf(pending)
        if (index >= 0) entries.splice(index, 1)
        if (entries.length === 0) this.pendingDiagnostics.delete(uri)
        clearTimeout(pending.timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolveDone(value)
      }
      const onAbort = () => finish([], abortError())
      const pending: PendingDiagnostics = {
        resolve: finish,
        timer: setTimeout(() => finish([]), 8_000),
      }
      const entries = this.pendingDiagnostics.get(uri) ?? []
      entries.push(pending)
      this.pendingDiagnostics.set(uri, entries)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    await this.open(file)
    return waiting
  }

  public async hover(file: string, line: number, column: number, signal?: AbortSignal): Promise<ExternalLanguageHover | null> {
    await this.open(file)
    const value = await this.request('textDocument/hover', positionParams(file, line, column), signal)
    if (!isRecord(value)) return null
    const display = markupText(value.contents)
    if (!display) return null
    return { path: file, line, column, kind: null, display, documentation: '' }
  }

  public async locations(
    method: 'textDocument/definition' | 'textDocument/references',
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<readonly ExternalLanguageLocation[]> {
    await this.open(file)
    const params = method === 'textDocument/references'
      ? { ...positionParams(file, line, column), context: { includeDeclaration: true } }
      : positionParams(file, line, column)
    const value = await this.request(method, params, signal)
    const entries = Array.isArray(value) ? value : value ? [value] : []
    return entries.flatMap((entry) => {
      const location = normalizeLspLocation(entry)
      return location ? [location] : []
    })
  }

  public async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.state = 'idle'
    if (!child) return
    try {
      await this.requestWithChild(child, 'shutdown', {}, undefined, 1_000)
      this.notifyWithChild(child, 'exit', {})
    } catch {
      child.kill('SIGTERM')
    }
    child.stdin.end()
    await Promise.race([
      new Promise<void>((resolveDone) => child.once('exit', () => resolveDone())),
      new Promise<void>((resolveDone) => setTimeout(resolveDone, 1_000)),
    ])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

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

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error(`${this.spec.id} is not running.`))
    return this.requestWithChild(child, method, params, signal)
  }

  private requestWithChild(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError())
    const id = ++this.sequence
    this.write(child, { jsonrpc: '2.0', id, method, params })
    return new Promise((resolveDone, reject) => {
      const finish = (value?: unknown, error?: Error): void => {
        const pending = this.responses.get(id)
        if (!pending) return
        this.responses.delete(id)
        clearTimeout(pending.timer)
        pending.removeAbort()
        if (error) reject(error)
        else resolveDone(value)
      }
      const onAbort = () => finish(undefined, abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
      this.responses.set(id, {
        resolve: (value) => finish(value),
        reject: (error) => finish(undefined, error),
        timer: setTimeout(() => finish(undefined, new Error(`${this.spec.id} request timed out: ${method}`)), timeoutMs),
        removeAbort: () => signal?.removeEventListener('abort', onAbort),
      })
    })
  }

  private notify(method: string, params: unknown): void {
    const child = this.child
    if (!child) throw new Error(`${this.spec.id} is not running.`)
    this.notifyWithChild(child, method, params)
  }

  private notifyWithChild(child: ChildProcessWithoutNullStreams, method: string, params: unknown): void {
    this.write(child, { jsonrpc: '2.0', method, params })
  }

  private write(child: ChildProcessWithoutNullStreams, value: unknown): void {
    const body = JSON.stringify(value)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

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
        this.error = `Invalid ${this.spec.id} message: ${errorMessage(error)}`
      }
    }
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value)) return
    if (typeof value.id === 'number' && ('result' in value || 'error' in value)) {
      const pending = this.responses.get(value.id)
      if (!pending) return
      if (isRecord(value.error)) pending.reject(new Error(typeof value.error.message === 'string' ? value.error.message : 'Language request failed.'))
      else pending.resolve(value.result)
      return
    }
    if (value.method !== 'textDocument/publishDiagnostics' || !isRecord(value.params)) return
    const uri = typeof value.params.uri === 'string' ? value.params.uri : null
    if (!uri) return
    let path: string
    try {
      path = fileURLToPath(uri)
    } catch {
      return
    }
    const diagnostics = Array.isArray(value.params.diagnostics)
      ? value.params.diagnostics.flatMap((entry) => {
          const normalized = normalizeLspDiagnostic(path, this.spec.id, entry)
          return normalized ? [normalized] : []
        })
      : []
    for (const pending of this.pendingDiagnostics.get(uri) ?? []) pending.resolve(diagnostics)
  }

  private fail(error: Error): void {
    this.state = 'error'
    this.error = error.message
    for (const pending of this.responses.values()) pending.reject(error)
    for (const entries of this.pendingDiagnostics.values()) {
      for (const pending of entries) pending.resolve([])
    }
  }
}

function positionParams(path: string, line: number, column: number): Record<string, unknown> {
  return {
    textDocument: { uri: pathToFileURL(path).href },
    position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
  }
}

function normalizeLspDiagnostic(path: string, source: string, value: unknown): ExternalLanguageDiagnostic | null {
  if (!isRecord(value) || !isRecord(value.range) || !isRecord(value.range.start)) return null
  const start = value.range.start
  const end = isRecord(value.range.end) ? value.range.end : null
  const message = typeof value.message === 'string' ? value.message.trim() : ''
  if (typeof start.line !== 'number' || typeof start.character !== 'number' || !message) return null
  const severity = value.severity === 2 ? 'warning' : value.severity === 3 || value.severity === 4 ? 'info' : 'error'
  return {
    severity,
    path,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end && typeof end.line === 'number' ? end.line + 1 : null,
    endColumn: end && typeof end.character === 'number' ? end.character + 1 : null,
    code: typeof value.code === 'string' || typeof value.code === 'number' ? String(value.code) : null,
    source,
    message,
  }
}

function normalizeLspLocation(value: unknown): ExternalLanguageLocation | null {
  if (!isRecord(value)) return null
  const uri = typeof value.uri === 'string' ? value.uri : typeof value.targetUri === 'string' ? value.targetUri : null
  const range = isRecord(value.range) ? value.range : isRecord(value.targetSelectionRange) ? value.targetSelectionRange : null
  if (!uri || !range || !isRecord(range.start)) return null
  const start = range.start
  const end = isRecord(range.end) ? range.end : null
  if (typeof start.line !== 'number' || typeof start.character !== 'number') return null
  try {
    return {
      path: fileURLToPath(uri),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end && typeof end.line === 'number' ? end.line + 1 : null,
      endColumn: end && typeof end.character === 'number' ? end.character + 1 : null,
      preview: null,
    }
  } catch {
    return null
  }
}

function markupText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(markupText).filter(Boolean).join('\n')
  if (!isRecord(value)) return ''
  if (typeof value.language === 'string' && typeof value.value === 'string') return `\`\`\`${value.language}\n${value.value}\n\`\`\``
  if (typeof value.value === 'string') return value.value.trim()
  return ''
}

function abortError(): Error {
  return Object.assign(new Error('Language request aborted.'), { name: 'AbortError' })
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
