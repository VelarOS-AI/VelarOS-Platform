import { chmod, unlink } from 'node:fs/promises'
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net'

import { z } from 'zod'

import type {
  ComputerAvailability,
  ComputerRuntimePort,
} from '@velaros-ai/computer/runtime'
import { AppError, isPresent, isUndefined, Log, toNullable } from '@velaros-ai/core'

import type { InstallVelarHostComputerResult } from './computer-installer'
import {
  type VelarHostConfigStore,
  VelarHostConfigUpdateSchema,
} from './config'
import type { VelarHostExtensionBridge } from './extension-bridge'
import type { VelarHostRemoteNode } from './remote-node'

const ManagementProtocolVersion = 1
const MaxRequestBytes = 64 * 1_024
const MaxResponseBytes = 1024 * 1_024
const DefaultRequestTimeoutMs = 5_000

const VelarHostManagementOperationSchema = z.enum([
  'status',
  'config.show',
  'config.apply',
  'computer.probe',
  'computer.install',
  'extension.pair',
  'extension.disconnect',
  'remote.pair',
  'remote.revoke',
])
export type VelarHostManagementOperation = z.infer<
  typeof VelarHostManagementOperationSchema
>

const VelarHostManagementRequestSchema = z.strictObject({
  schemaVersion: z.literal(ManagementProtocolVersion),
  requestId: z.string().uuid(),
  operation: VelarHostManagementOperationSchema,
  payload: z.unknown().optional(),
})

const VelarHostManagementResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    schemaVersion: z.literal(ManagementProtocolVersion),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    schemaVersion: z.literal(ManagementProtocolVersion),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  }),
])

export interface VelarHostManagementStatus {
  readonly kind: 'unix' | 'pipe'
  readonly endpoint: string
}

export interface VelarHostManagementServerOptions {
  readonly endpoint: string
  readonly config: VelarHostConfigStore
  readonly computer: ComputerRuntimePort
  readonly extensionBridge: VelarHostExtensionBridge
  readonly remoteNode: VelarHostRemoteNode
  readonly installComputer?: () => Promise<InstallVelarHostComputerResult>
  readonly getHostStatus: () => unknown
}

export class VelarHostManagementError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'VelarHostManagementError'
  }
}

/** OS-local Host management transport. It never opens a TCP listener or serves UI assets. */
export class VelarHostManagementServer {
  private readonly sockets = new Set<Socket>()
  private server?: Server
  private computerAvailability?: ComputerAvailability
  private computerInstall?: Promise<InstallVelarHostComputerResult>

  public constructor(private readonly options: VelarHostManagementServerOptions) {}

  public async start(): Promise<VelarHostManagementStatus> {
    if (isPresent(this.server)) return this.status()
    if (process.platform !== 'win32') {
      await unlink(this.options.endpoint).catch((error) => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    }
    const server = createServer((socket) => this.accept(socket))
    await listen(server, this.options.endpoint)
    this.server = server
    if (process.platform !== 'win32') {
      try {
        await chmod(this.options.endpoint, 0o600)
      } catch (error) {
        await this.stop()
        throw error
      }
    }
    return this.status()
  }

  public async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    if (isPresent(server)) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (process.platform !== 'win32') {
      await unlink(this.options.endpoint).catch((error) => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    }
  }

  private status(): VelarHostManagementStatus {
    return {
      kind: process.platform === 'win32' ? 'pipe' : 'unix',
      endpoint: this.options.endpoint,
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    let bytes = 0
    let input = ''
    let handled = false
    socket.on('data', (chunk: Buffer) => {
      if (handled) return
      bytes += chunk.length
      if (bytes > MaxRequestBytes) {
        handled = true
        this.writeFailure(socket, 'REQUEST_TOO_LARGE', 'Host management request is too large')
        return
      }
      input += chunk.toString('utf8')
      const lineEnd = input.indexOf('\n')
      if (lineEnd < 0) return
      handled = true
      const line = input.slice(0, lineEnd)
      void this.handleLine(socket, line)
    })
    socket.once('end', () => {
      if (!handled) socket.end()
    })
    socket.once('error', () => undefined)
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let requestId = '00000000-0000-4000-8000-000000000000'
    try {
      const request = VelarHostManagementRequestSchema.parse(JSON.parse(line) as unknown)
      requestId = request.requestId
      const result = await this.dispatch(request.operation, request.payload)
      socket.end(`${JSON.stringify({
        schemaVersion: ManagementProtocolVersion,
        requestId,
        ok: true,
        result,
      })}\n`)
    } catch (error) {
      const message = AppError.getMessage(error)
      const requestError = error instanceof SyntaxError
        || (error instanceof Error && error.name === 'ZodError')
        || message.startsWith('Explicit confirmation required:')
        || message.includes(' requires ')
        || message.endsWith(' is disabled')
      if (!requestError) {
        Log.tag('VelarHostManagement').warn('Host 本地管理操作执行失败。', { error, requestId })
      }
      this.writeFailure(socket, requestError ? 'REQUEST_ERROR' : 'EXECUTION_ERROR', message, requestId)
    }
  }

  private async dispatch(
    operation: VelarHostManagementOperation,
    payload: unknown,
  ): Promise<unknown> {
    switch (operation) {
      case 'status':
        return this.statusPayload()
      case 'config.show': {
        const current = this.options.config.snapshot().value
        return {
          capabilities: current.capabilities,
          computer: current.computer,
          remoteNode: current.remoteNode,
          confirmations: [],
        }
      }
      case 'config.apply':
        await this.options.config.update(VelarHostConfigUpdateSchema.parse(payload))
        return this.statusPayload()
      case 'computer.probe':
        this.computerAvailability = await this.options.computer.ensureAvailable()
        return this.statusPayload()
      case 'computer.install': {
        if (!isPresent(this.options.installComputer)) {
          throw new Error('Computer runtime installation is unavailable')
        }
        this.computerInstall ??= this.options.installComputer()
          .finally(() => { this.computerInstall = undefined })
        const installation = await this.computerInstall
        this.computerAvailability = await this.options.computer.ensureAvailable()
        return { ...this.statusPayload(), installation }
      }
      case 'extension.pair':
        this.options.extensionBridge.startPairing()
        return this.statusPayload()
      case 'extension.disconnect':
        await this.options.extensionBridge.disconnectDevice()
        this.options.extensionBridge.startPairing()
        return this.statusPayload()
      case 'remote.pair': {
        if (!this.options.remoteNode.isEnabled()) throw new Error('Remote node access is disabled')
        const pairing = this.options.remoteNode.startPairing()
        return { ...this.statusPayload(), pairing }
      }
      case 'remote.revoke':
        if (!this.options.remoteNode.isEnabled()) throw new Error('Remote node access is disabled')
        await this.options.remoteNode.revokePairing()
        return this.statusPayload()
    }
  }

  private statusPayload(): Record<string, unknown> {
    return {
      host: this.options.getHostStatus(),
      config: this.options.config.snapshot(),
      computerAvailability: toNullable(this.computerAvailability),
    }
  }

  private writeFailure(
    socket: Socket,
    code: string,
    message: string,
    requestId = '00000000-0000-4000-8000-000000000000',
  ): void {
    if (socket.destroyed) return
    socket.end(`${JSON.stringify({
      schemaVersion: ManagementProtocolVersion,
      requestId,
      ok: false,
      error: { code, message },
    })}\n`)
  }
}

export async function callVelarHostManagement<Result = unknown>(
  endpoint: string,
  operation: VelarHostManagementOperation,
  payload?: unknown,
  timeoutMs = DefaultRequestTimeoutMs,
): Promise<Result> {
  const requestId = crypto.randomUUID()
  const response = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(endpoint)
    let bytes = 0
    let input = ''
    let settled = false
    const finish = (operation_: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      operation_()
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        schemaVersion: ManagementProtocolVersion,
        requestId,
        operation,
        ...(isUndefined(payload) ? {} : { payload }),
      })}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MaxResponseBytes) {
        finish(() => reject(new Error('Host management response is too large')))
        return
      }
      input += chunk.toString('utf8')
      const lineEnd = input.indexOf('\n')
      if (lineEnd < 0) return
      try {
        finish(() => resolve(JSON.parse(input.slice(0, lineEnd)) as unknown))
      } catch (error) {
        finish(() => reject(error))
      }
    })
    socket.once('timeout', () => finish(() => reject(new Error('Host management request timed out'))))
    socket.once('error', (error) => finish(() => reject(error)))
    socket.once('end', () => {
      if (!settled) finish(() => reject(new Error('Host management connection closed without a response')))
    })
  })
  const parsed = VelarHostManagementResponseSchema.parse(response)
  if (parsed.requestId !== requestId) throw new Error('Host management response did not match request')
  if (!parsed.ok) throw new VelarHostManagementError(parsed.error.code, parsed.error.message)
  return parsed.result as Result
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ path: endpoint, readableAll: false, writableAll: false })
  })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
