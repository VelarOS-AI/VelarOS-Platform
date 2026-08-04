import {
  createHash,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmod,
  lstat,
  unlink,
} from 'node:fs/promises'
import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isBlank,
  isEmpty,
  isNotNull,
  isNotUndefined,
  isNull,
  isObject,
  isString,
  isUndefined,
  Log,
  toNullable,
} from '@velaros-ai/core'
import type {
  KernelRpcEndpoint,
  KernelRpcEventFrame,
  KernelRpcFailure,
  KernelRpcRequest,
  KernelRpcServerFrame,
  KernelRpcSuccess,
} from '@velaros-ai/kernel/client/contracts'
import type {
  OpenKernelSessionInput,
  StartKernelRunInput,
} from '@velaros-ai/kernel/contracts'
import type {
  KernelRegistration,
} from '@velaros-ai/kernel/contracts/abi'
import {
  type CapabilityCallFailure,
  CapabilityCallRequestSchema,
  type CapabilityCallResponse,
  CapabilitySessionCloseRequestSchema,
  type CapabilitySessionCloseResponse,
  type CapabilitySessionOpenResponse,
  KernelProtocolVersion,
  ModsInstallFromDirectoryRequestSchema,
  ModsListRequestSchema,
  ModsSetEnabledRequestSchema,
  ScopeRefSchema,
} from '@velaros-ai/kernel/contracts/protocol'
import {
  CapabilitySessionLedger,
  KernelIdentityRegistryError,
  type KernelService,
  KernelServiceLifecycleError,
} from '@velaros-ai/kernel/runtime'

import {
  decodeKernelRpcRequest,
  KernelRpcProtocolError,
  requireNonEmptyString,
  requireRecord,
  rpcFailure,
} from './server-frames'

const log = Log.tag('KernelLocalRpcServer')

export interface KernelLocalRpcServerOptions {
  readonly authToken: string
  readonly endpoint?: KernelRpcEndpoint
  readonly maxFrameBytes?: number
  readonly service: KernelService
}

interface ConnectionContext {
  readonly socket: Socket
  readonly subscriptions: Map<string, KernelRegistration>
  readonly controllers: Map<string, AbortController>
  readonly sessions: CapabilitySessionLedger
  buffer: string
}

const defaultMaxFrameBytes = 4 * 1024 * 1024

export function createDefaultKernelRpcEndpoint(
  name = 'velaros-kernel',
): KernelRpcEndpoint {
  if (process.platform === 'win32') return { kind: 'tcp', host: '127.0.0.1', port: 0 }
  const safeName = name.replaceAll(/[^a-zA-Z0-9._-]/g, '-')
  return {
    kind: 'unix',
    path: join(tmpdir(), `${safeName}-${process.pid}.sock`),
  }
}

/**
 * Newline-delimited JSON RPC server for the local Kernel sidecar.
 *
 * Unix domain sockets are the default. Windows uses an explicit loopback-only
 * TCP endpoint whose resolved port is returned after start.
 */
export class KernelLocalRpcServer {
  private readonly server: Server
  private readonly connections = new Set<ConnectionContext>()
  private readonly maxFrameBytes: number
  private readonly requestedEndpoint: KernelRpcEndpoint
  private resolvedEndpoint?: KernelRpcEndpoint
  private state: 'idle' | 'listening' | 'disposed' = 'idle'

  public constructor(private readonly options: KernelLocalRpcServerOptions) {
    if (options.authToken.length < 32) {
      throw new Error('Kernel RPC auth token must contain at least 32 characters')
    }
    this.maxFrameBytes = options.maxFrameBytes ?? defaultMaxFrameBytes
    if (!Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new Error('maxFrameBytes must be a positive integer')
    }
    this.requestedEndpoint = options.endpoint
      ?? createDefaultKernelRpcEndpoint()
    if (
      this.requestedEndpoint.kind === 'tcp'
      && this.requestedEndpoint.host !== '127.0.0.1'
    ) {
      throw new Error('Kernel TCP RPC endpoint must be loopback-only')
    }
    this.server = createServer((socket) => this.accept(socket))
  }

  public async start(): Promise<KernelRpcEndpoint> {
    switch (this.state) {
      case 'disposed':
        throw new Error('Disposed Kernel RPC server cannot be started')
      case 'listening':
        return this.getEndpoint()
      case 'idle':
        break
    }

    await this.options.service.start()
    try {
      if (this.requestedEndpoint.kind === 'unix') {
        await removeStaleSocket(this.requestedEndpoint.path)
      }
      await listen(this.server, this.requestedEndpoint)
      this.resolvedEndpoint = resolveBoundEndpoint(
        this.server,
        this.requestedEndpoint,
      )
      if (this.resolvedEndpoint.kind === 'unix') {
        await chmod(this.resolvedEndpoint.path, 0o600)
      }
      this.state = 'listening'
      return this.resolvedEndpoint
    } catch (error) {
      await this.options.service.dispose().catch((cleanupError) => {
        log.warn('Kernel service cleanup failed after RPC startup error', { error: cleanupError })
      })
      await this.cleanupSocketPath()
      throw error
    }
  }

  public getEndpoint(): KernelRpcEndpoint {
    if (isUndefined(this.resolvedEndpoint)) {
      throw new Error('Kernel RPC server has not started')
    }
    return this.resolvedEndpoint
  }

  public async dispose(): Promise<void> {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    for (const context of this.connections) {
      cleanupConnection(context)
      context.socket.destroy()
    }
    this.connections.clear()
    try {
      await closeServer(this.server)
    } finally {
      try {
        await this.options.service.dispose()
      } finally {
        await this.cleanupSocketPath()
      }
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    const context: ConnectionContext = {
      socket,
      subscriptions: new Map(),
      controllers: new Map(),
      sessions: new CapabilitySessionLedger(),
      buffer: '',
    }
    this.connections.add(context)
    socket.on('data', (chunk: string) => this.read(context, chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      cleanupConnection(context)
      this.connections.delete(context)
    })
  }

  private read(context: ConnectionContext, chunk: string): void {
    context.buffer += chunk

    let newlineIndex = context.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = context.buffer.slice(0, newlineIndex)
      context.buffer = context.buffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.rejectOversizedFrame(context)
        return
      }
      if (!isBlank(line.trim())) {
        void this.handleLine(context, line)
      }
      newlineIndex = context.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(context.buffer, 'utf8') > this.maxFrameBytes) {
      this.rejectOversizedFrame(context)
    }
  }

  private rejectOversizedFrame(context: ConnectionContext): void {
    sendFrame(
      context.socket,
      rpcFailure(
        'invalid-frame',
        'FRAME_TOO_LARGE',
        'RPC frame exceeds the configured size limit',
      ),
    )
    context.socket.destroy()
  }

  private async handleLine(
    context: ConnectionContext,
    line: string,
  ): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(line) as unknown
    } catch (error) {
      log.debug('Rejected malformed Kernel RPC JSON', { error })
      sendFrame(
        context.socket,
        rpcFailure(
          'invalid-frame',
          'INVALID_JSON',
          'RPC frame is not valid JSON',
        ),
      )
      return
    }

    let request: KernelRpcRequest
    try {
      request = decodeKernelRpcRequest(raw)
    } catch (error) {
      log.debug('Rejected invalid Kernel RPC request', { error })
      sendFrame(
        context.socket,
        toRpcFailure(readRequestId(raw), error),
      )
      return
    }
    if (!tokensMatch(request.authToken, this.options.authToken)) {
      sendFrame(
        context.socket,
        rpcFailure(
          request.requestId,
          'UNAUTHORIZED',
          'Kernel RPC authentication failed',
        ),
      )
      return
    }

    const controller = request.method === 'capability.call'
      ? new AbortController()
      : undefined
    if (isNotUndefined(controller)) {
      context.controllers.set(request.requestId, controller)
    }
    try {
      const result = await this.dispatch(context, request, controller?.signal)
      const response: KernelRpcSuccess = {
        type: 'response',
        requestId: request.requestId,
        status: 'ok',
        result,
      }
      if (!sendFrame(context.socket, response)) {
        sendFrame(
          context.socket,
          rpcFailure(
            request.requestId,
            'RESPONSE_SERIALIZATION_FAILED',
            'RPC result is not serializable',
          ),
        )
      }
    } catch (error) {
      log.caught('Kernel RPC request failed', error, { method: request.method })
      sendFrame(context.socket, toRpcFailure(request.requestId, error))
    } finally {
      context.controllers.delete(request.requestId)
    }
  }

  private dispatch(
    context: ConnectionContext,
    request: KernelRpcRequest,
    signal?: AbortSignal,
  ): unknown | Promise<unknown> {
    switch (request.method) {
      case 'handshake':
        return this.options.service.handshake()
      case 'health':
        return this.options.service.health()
      case 'capability.session.open':
        return this.openCapabilitySession(context, request.params)
      case 'capability.session.close':
        return this.closeCapabilitySession(context, request.params)
      case 'capability.call':
        return this.callCapability(context, request.params, signal)
      case 'capability.cancel':
        return this.cancelCall(context, request.params)
      case 'session.open':
        return this.options.service.openSession(
          parseOpenSessionInput(request.params),
        )
      case 'session.get':
        return toNullable(this.options.service.getSession(
          readIdentityId(request.params, 'sessionId'),
        ))
      case 'session.list':
        return this.options.service.listSessions()
      case 'session.close':
        return this.options.service.closeSession(
          readIdentityId(request.params, 'sessionId'),
        )
      case 'run.start':
        return this.options.service.startRun(
          parseStartRunInput(request.params),
        )
      case 'run.get':
        return toNullable(this.options.service.getRun(
          readIdentityId(request.params, 'runId'),
        ))
      case 'run.list':
        return this.options.service.listRuns()
      case 'run.finish':
        return this.options.service.finishRun(
          readIdentityId(request.params, 'runId'),
        )
      case 'events.subscribe':
        return this.subscribe(context, request)
      case 'events.unsubscribe':
        return this.unsubscribe(context, request.params)
      case 'mods.list':
        return this.listMods(request.params)
      case 'mods.setEnabled':
        return this.setModEnabled(request.params)
      case 'mods.installFromDirectory':
        return this.installModFromDirectory(request.params)
    }
  }

  private listMods(params: unknown) {
    const parsed = ModsListRequestSchema.safeParse(params ?? {
      protocolVersion: KernelProtocolVersion,
    })
    if (!parsed.success) {
      throw new KernelRpcProtocolError(
        'INVALID_PARAMS',
        'Mods list request does not match kernel protocol v2',
      )
    }
    return {
      protocolVersion: KernelProtocolVersion,
      packs: this.options.service.listMods(),
    }
  }

  private async setModEnabled(params: unknown) {
    const parsed = ModsSetEnabledRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new KernelRpcProtocolError(
        'INVALID_PARAMS',
        'Mods setEnabled request does not match kernel protocol v2',
      )
    }
    const result = await this.options.service.setModEnabled(
      parsed.data.id,
      parsed.data.enabled,
    )
    return {
      protocolVersion: KernelProtocolVersion,
      ...result,
    }
  }

  private async installModFromDirectory(params: unknown) {
    const parsed = ModsInstallFromDirectoryRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new KernelRpcProtocolError(
        'INVALID_PARAMS',
        'Mods installFromDirectory request does not match kernel protocol v2',
      )
    }
    const result = await this.options.service.installModFromDirectory(
      parsed.data.directory,
    )
    return {
      protocolVersion: KernelProtocolVersion,
      ...result,
    }
  }

  private async openCapabilitySession(
    context: ConnectionContext,
    params: unknown,
  ): Promise<CapabilitySessionOpenResponse> {
    const evaluated = await this.options.service.evaluateCapabilitySessionOpen(
      params,
    )
    if (evaluated.status === 'error') return evaluated
    const session = context.sessions.open(evaluated.request.requires)
    return {
      protocolVersion: KernelProtocolVersion,
      status: 'ok',
      sessionId: session.sessionId,
      requires: evaluated.request.requires,
    }
  }

  private closeCapabilitySession(
    context: ConnectionContext,
    params: unknown,
  ): CapabilitySessionCloseResponse {
    const parsed = CapabilitySessionCloseRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new KernelRpcProtocolError(
        'INVALID_PARAMS',
        'Capability session close request does not match kernel protocol v2',
      )
    }
    return {
      protocolVersion: KernelProtocolVersion,
      closed: context.sessions.close(parsed.data.sessionId),
    }
  }

  private async callCapability(
    context: ConnectionContext,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<CapabilityCallResponse> {
    const parsed = CapabilityCallRequestSchema.safeParse(params)
    if (!parsed.success) return callGrantFailure(
        readCallIdFromParams(params),
        'INVALID_REQUEST',
        'Capability call request does not match kernel protocol v2',
      )
    if (!context.sessions.covers(parsed.data)) return callGrantFailure(
        parsed.data.callId,
        'CAPABILITY_NOT_GRANTED',
        `Capability "${parsed.data.capabilityId}" is not bound on session "${parsed.data.sessionId}"`,
      )
    return this.options.service.handleCapabilityCall(parsed.data, signal)
  }

  private cancelCall(
    context: ConnectionContext,
    params: unknown,
  ): boolean {
    const requestId = readIdentityId(params, 'requestId')
    const controller = context.controllers.get(requestId)
    controller?.abort()
    return isNotUndefined(controller)
  }

  private subscribe(
    context: ConnectionContext,
    request: KernelRpcRequest,
  ): { readonly subscriptionId: string } {
    const params = requireRecord(request.params)
    const eventType = requireNonEmptyString(params.eventType, 'eventType')
    const subscriptionId = request.requestId
    const registration = this.options.service.subscribe(
      eventType,
      (event) => {
        const frame: KernelRpcEventFrame = {
          type: 'event',
          subscriptionId,
          event,
        }
        sendFrame(context.socket, frame)
      },
    )
    context.subscriptions.set(subscriptionId, registration)
    return { subscriptionId }
  }

  private unsubscribe(
    context: ConnectionContext,
    params: unknown,
  ): boolean {
    const subscriptionId = readIdentityId(params, 'subscriptionId')
    const registration = context.subscriptions.get(subscriptionId)
    if (isUndefined(registration)) return false
    registration.dispose()
    context.subscriptions.delete(subscriptionId)
    return true
  }

  private async cleanupSocketPath(): Promise<void> {
    const endpoint = this.resolvedEndpoint ?? this.requestedEndpoint
    if (endpoint.kind !== 'unix') return
    await unlink(endpoint.path).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error
    })
  }
}

function parseOpenSessionInput(input: unknown): OpenKernelSessionInput {
  const params = requireRecord(input)
  const scope = ScopeRefSchema.nullable().safeParse(params.scope)
  if (!scope.success) {
    throw new KernelRpcProtocolError(
      'INVALID_PARAMS',
      'RPC field "scope" must be a valid opaque scope or null',
    )
  }
  return {
    id: requireNonEmptyString(params.id, 'id'),
    ownerModuleId: requireNonEmptyString(
      params.ownerModuleId,
      'ownerModuleId',
    ),
    scope: scope.data,
  }
}

function parseStartRunInput(input: unknown): StartKernelRunInput {
  const params = requireRecord(input)
  const sessionId = params.sessionId
  if (isNotNull(sessionId) && !isString(sessionId)) {
    throw new KernelRpcProtocolError(
      'INVALID_PARAMS',
      'RPC field "sessionId" must be a string or null',
    )
  }
  return {
    id: requireNonEmptyString(params.id, 'id'),
    ownerModuleId: requireNonEmptyString(
      params.ownerModuleId,
      'ownerModuleId',
    ),
    sessionId,
  }
}

function readIdentityId(params: unknown, field: string): string {
  return requireNonEmptyString(requireRecord(params)[field], field)
}

function readRequestId(input: unknown): string {
  if (!isObject(input) && !isNull(input) || isNull(input)) return 'invalid-frame'
  const requestId = Reflect.get(input, 'requestId')
  return isString(requestId) && !isEmpty(requestId)
    ? requestId
    : 'invalid-frame'
}

function toRpcFailure(
  requestId: string,
  error: unknown,
): KernelRpcFailure {
  if (error instanceof KernelRpcProtocolError) return rpcFailure(requestId, error.code, error.message)
  if (error instanceof KernelIdentityRegistryError) return rpcFailure(requestId, error.code, error.message)
  if (error instanceof KernelServiceLifecycleError) return rpcFailure(requestId, error.code, error.message, true)
  return rpcFailure(
    requestId,
    'INTERNAL_ERROR',
    'Kernel RPC request failed',
    true,
  )
}

function sendFrame(socket: Socket, frame: KernelRpcServerFrame): boolean {
  try {
    socket.write(`${JSON.stringify(frame)}\n`)
    return true
  } catch (error) {
    log.warn('Kernel RPC response could not be serialized or written', { error })
    return false
  }
}

function cleanupConnection(context: ConnectionContext): void {
  for (const controller of context.controllers.values()) controller.abort()
  context.controllers.clear()
  for (const registration of context.subscriptions.values()) {
    registration.dispose()
  }
  context.subscriptions.clear()
  context.sessions.clear()
}

function callGrantFailure(
  callId: string,
  code: string,
  message: string,
): CapabilityCallFailure {
  return {
    protocolVersion: KernelProtocolVersion,
    callId,
    status: 'error',
    error: {
      code,
      message,
      retryable: false,
      details: null,
    },
  }
}

function readCallIdFromParams(input: unknown): string {
  if (!isObject(input) && !isNull(input) || isNull(input)) return 'invalid-call'
  const callId = Reflect.get(input, 'callId')
  return isString(callId) && !isEmpty(callId)
    ? callId
    : 'invalid-call'
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (!stat.isSocket()) {
      throw new Error(
        `Refusing to replace non-socket Kernel RPC path "${path}"`,
      )
    }
    await unlink(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

function listen(
  server: Server,
  endpoint: KernelRpcEndpoint,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    if (endpoint.kind === 'unix') {
      server.listen(endpoint.path)
    } else {
      server.listen(endpoint.port, endpoint.host)
    }
  })
}

function resolveBoundEndpoint(
  server: Server,
  requested: KernelRpcEndpoint,
): KernelRpcEndpoint {
  if (requested.kind === 'unix') return requested
  const address = server.address() as Nullable<AddressInfo>
  if (isNull(address)) throw new Error('Kernel RPC server has no address')
  return {
    kind: 'tcp',
    host: '127.0.0.1',
    port: address.port,
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (isUndefined(error)) resolve()
      else reject(error)
    })
  })
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code
}

function tokensMatch(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}
