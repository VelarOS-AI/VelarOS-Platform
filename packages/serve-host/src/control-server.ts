import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'

import type {
  ComputerAvailability,
  ComputerRuntimePort,
} from '@velaros-ai/computer/runtime'
import { isNull, isPresent, isString, toNullable } from '@velaros-ai/core'

import type { InstallVelarHostComputerResult } from './computer-installer'
import {
  type VelarHostConfigStore,
  VelarHostConfigUpdateSchema,
} from './config'
import {
  VelarHostControlCss,
  VelarHostControlHtml,
  VelarHostControlJs,
} from './control-page'
import type { VelarHostExtensionBridge } from './extension-bridge'
import type { VelarHostRemoteNode } from './remote-node'

const ControlHost = '127.0.0.1'
const DefaultControlPortStart = 43_160
const DefaultControlPortEnd = 43_170
const MaxRequestBytes = 64 * 1_024

export interface VelarHostControlServerOptions {
  readonly tokenPath: string
  readonly config: VelarHostConfigStore
  readonly computer: ComputerRuntimePort
  readonly extensionBridge: VelarHostExtensionBridge
  readonly remoteNode: VelarHostRemoteNode
  readonly installComputer?: () => Promise<InstallVelarHostComputerResult>
  readonly getHostStatus: () => unknown
  readonly portStart?: number
  readonly portEnd?: number
}

export interface VelarHostControlServerStatus {
  readonly endpoint: string
}

/** Authenticated loopback control plane; it deliberately contains no chat UI. */
export class VelarHostControlServer {
  private readonly sockets = new Set<Socket>()
  private server?: Server
  private endpoint?: string
  private token?: string
  private computerAvailability?: ComputerAvailability
  private computerInstall?: Promise<InstallVelarHostComputerResult>

  public constructor(private readonly options: VelarHostControlServerOptions) {}

  public async start(): Promise<VelarHostControlServerStatus> {
    if (isPresent(this.endpoint)) return { endpoint: this.endpoint }
    this.token = await loadOrCreateToken(this.options.tokenPath)
    const portStart = this.options.portStart ?? DefaultControlPortStart
    const portEnd = this.options.portEnd ?? DefaultControlPortEnd
    if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart > portEnd) {
      throw new Error('Invalid control server port range')
    }
    for (let port = portStart; port <= portEnd; port += 1) {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          const isRequestError = error instanceof SyntaxError
            || (error instanceof Error && error.name === 'ZodError')
            || message.startsWith('Explicit confirmation required:')
            || message.includes(' requires ')
          this.json(response, isRequestError ? 400 : 500, { error: message })
        })
      })
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
      })
      try {
        const actualPort = await listen(server, port)
        this.server = server
        this.endpoint = `http://${ControlHost}:${actualPort}`
        return { endpoint: this.endpoint }
      } catch (error) {
        server.close()
        if (!isNodeError(error, 'EADDRINUSE')) throw error
      }
    }
    throw new Error(`No control server port is available in ${portStart}-${portEnd}`)
  }

  public getControlUrl(): string {
    if (!isPresent(this.endpoint) || !isPresent(this.token)) {
      throw new Error('Velar Host control server is not started')
    }
    return `${this.endpoint}/#token=${encodeURIComponent(this.token)}`
  }

  public async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    this.endpoint = undefined
    this.token = undefined
    if (!isPresent(server)) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.securityHeaders(response)
    const url = new URL(request.url ?? '/', this.endpoint ?? 'http://127.0.0.1')
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/control')) {
      this.text(response, 200, 'text/html; charset=utf-8', VelarHostControlHtml)
      return
    }
    if (request.method === 'GET' && url.pathname === '/control.css') {
      this.text(response, 200, 'text/css; charset=utf-8', VelarHostControlCss)
      return
    }
    if (request.method === 'GET' && url.pathname === '/control.js') {
      this.text(response, 200, 'text/javascript; charset=utf-8', VelarHostControlJs)
      return
    }
    if (!this.isAuthorized(request)) {
      this.json(response, 401, { error: 'Velar Host control token is required' })
      return
    }
    if (!this.hasTrustedMutationOrigin(request)) {
      this.json(response, 403, { error: 'Velar Host control request origin is not trusted' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      this.json(response, 200, this.statusPayload())
      return
    }
    if (request.method === 'PUT' && url.pathname === '/v1/config') {
      const update = VelarHostConfigUpdateSchema.parse(await readJsonBody(request))
      await this.options.config.update(update)
      this.json(response, 200, this.statusPayload())
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/computer/probe') {
      this.computerAvailability = await this.options.computer.ensureAvailable()
      this.json(response, 200, this.statusPayload())
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/computer/install') {
      if (!isPresent(this.options.installComputer)) {
        this.json(response, 501, { error: 'Computer runtime installation is unavailable' })
        return
      }
      this.computerInstall ??= this.options.installComputer()
        .finally(() => { this.computerInstall = undefined })
      const installation = await this.computerInstall
      this.computerAvailability = await this.options.computer.ensureAvailable()
      this.json(response, 200, { ...this.statusPayload(), installation })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/extension/pairing') {
      this.options.extensionBridge.startPairing()
      this.json(response, 200, this.statusPayload())
      return
    }
    if (request.method === 'DELETE' && url.pathname === '/v1/extension') {
      await this.options.extensionBridge.disconnectDevice()
      this.options.extensionBridge.startPairing()
      this.json(response, 200, this.statusPayload())
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/remote-node/pairing') {
      if (!this.options.remoteNode.isEnabled()) {
        this.json(response, 409, { error: 'Remote node access is disabled' })
        return
      }
      // 配对码只在这一条已鉴权的应答里出现；它不进 statusPayload，故也不会流向 host.json。
      const pairing = this.options.remoteNode.startPairing()
      this.json(response, 200, { ...this.statusPayload(), pairing })
      return
    }
    if (request.method === 'DELETE' && url.pathname === '/v1/remote-node') {
      if (!this.options.remoteNode.isEnabled()) {
        this.json(response, 409, { error: 'Remote node access is disabled' })
        return
      }
      await this.options.remoteNode.revokePairing()
      this.json(response, 200, this.statusPayload())
      return
    }
    this.json(response, 404, { error: 'Not found' })
  }

  private statusPayload(): Record<string, unknown> {
    return {
      host: this.options.getHostStatus(),
      config: this.options.config.snapshot(),
      computerAvailability: toNullable(this.computerAvailability),
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const expected = this.token
    const authorization = request.headers.authorization
    if (!isPresent(expected) || !isString(authorization)) return false
    const supplied = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : ''
    const expectedBytes = Buffer.from(expected)
    const suppliedBytes = Buffer.from(supplied)
    return expectedBytes.length === suppliedBytes.length
      && timingSafeEqual(expectedBytes, suppliedBytes)
  }

  private hasTrustedMutationOrigin(request: IncomingMessage): boolean {
    if (request.method === 'GET') return true
    const origin = request.headers.origin
    return !isPresent(origin) || origin === this.endpoint
  }

  private securityHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    this.text(response, status, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`)
  }

  private text(
    response: ServerResponse,
    status: number,
    contentType: string,
    value: string,
  ): void {
    if (response.headersSent || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': contentType })
    response.end(value)
  }
}

async function loadOrCreateToken(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const token = (await readFile(path, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) {
      throw new Error('Velar Host control token file is invalid')
    }
    await chmod(path, 0o600)
    return token
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
    const token = randomBytes(32).toString('base64url')
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
    return token
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (isNull(address) || isString(address)) {
        reject(new Error('Velar Host control server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, ControlHost)
  })
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MaxRequestBytes) throw new Error('Velar Host control request is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
