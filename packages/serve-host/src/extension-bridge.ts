import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { basename, dirname } from 'node:path'

import {
  type RawData,
  WebSocket,
  WebSocketServer,
} from 'ws'
import { z } from 'zod'

import {
  ExternalAgentBridgeProtocolDescriptor,
  ExternalAgentBridgeProtocolVersion,
  parseExternalAgentBridgeClientMessage,
} from '@velaros-ai/agent/protocol'
import {
  isBlank,
  isNotNull,
  isNull,
  isPresent,
  isString,
  toNullable,
} from '@velaros-ai/core'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  createProviderSurfaceBinding,
  type ProviderSurfaceBinding,
  type ProviderSurfaceToolCall,
  ProviderSurfaceToolCallSchema,
  type ProviderSurfaceToolResult,
  type ProviderSurfaceWorkspaceCatalog,
  type ProviderSurfaceWorkspaceSpace,
} from '@velaros-ai/surface-protocol'

import type { VelarHostToolGateway } from './tool-gateway'

const BridgeHost = '127.0.0.1'
const DefaultBridgePortStart = 43_137
const DefaultBridgePortEnd = 43_147
const PairingLifetimeMs = 5 * 60_000
const MaxSocketPayloadBytes = 32 * 1_024 * 1_024
const MaxCommands = 100
const MaxProcessedEvents = 256

const PublicExtensionDeviceSchema = z.strictObject({
  id: z.string().min(1),
  provider: z.string().min(1),
  appVersion: z.string().min(1),
  appEdition: z.literal('host'),
  capabilities: z.json(),
  tabUrl: z.string().min(1),
  modelLabel: z.string().nullable(),
  providerSnapshot: z.json().nullable(),
  connectedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
})
type PublicExtensionDevice = z.infer<typeof PublicExtensionDeviceSchema>

const PersistedExtensionCredentialSchema = z.strictObject({
  schemaVersion: z.literal(1),
  token: z.string().min(32),
  device: PublicExtensionDeviceSchema,
})
type PersistedExtensionCredential = z.infer<typeof PersistedExtensionCredentialSchema>

interface BridgeCommand {
  sequence: number
  type:
    | 'provider_surface_contract'
    | 'provider_surface_tool_progress'
    | 'provider_surface_tool_result'
    | 'provider_workspace_catalog'
  payload: Record<string, unknown>
}

interface SurfaceRuntime {
  surfaceId: string
  workspaceBindingId: string
  workspaceSpace: ProviderSurfaceWorkspaceSpace
  binding: ProviderSurfaceBinding
  contractId: string
  activeToolCallId: Nullable<string>
}

interface DeviceRuntime {
  public: PublicExtensionDevice
  token: string
  socket: Nullable<WebSocket>
  commandSequence: number
  commands: BridgeCommand[]
  processedEventIds: Set<string>
  surfaces: Map<string, SurfaceRuntime>
}

export interface VelarHostExtensionBridgeOptions {
  readonly credentialPath: string
  readonly workspaceRoot: string
  readonly toolGateway: VelarHostToolGateway
  readonly hostVersion?: string
  readonly portStart?: number
  readonly portEnd?: number
  /** Deterministic test seam; production generates a six-digit code. */
  readonly pairingCode?: string
  readonly now?: () => number
}

export interface VelarHostExtensionBridgeStatus {
  readonly endpoint: string
  readonly pairingCode: Nullable<string>
  readonly pairingExpiresAt: Nullable<number>
  readonly connected: boolean
  readonly deviceId: Nullable<string>
  readonly provider: Nullable<string>
  readonly surfaceCount: number
  readonly activity: Nullable<{
    readonly eventType: string
    readonly at: number
    readonly toolName: Nullable<string>
    readonly status: Nullable<string>
  }>
}

function requiredString(value: unknown, field: string, maxLength = 512): string {
  if (!isString(value) || isBlank(value)) {
    throw new Error(`Extension event is missing ${field}`)
  }
  return value.trim().slice(0, maxLength)
}

function optionalString(value: unknown, maxLength = 512): Nullable<string> {
  return isString(value) && !isBlank(value)
    ? value.trim().slice(0, maxLength)
    : null
}

function isChromeExtensionOrigin(origin: unknown): origin is string {
  return isString(origin)
    && /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

/** Local-loopback External Agent Bridge implementation owned by Velar Host. */
export class VelarHostExtensionBridge {
  private timers = new TimerScope({ name: 'VelarHostExtensionBridge' })
  private readonly now: () => number
  private readonly statusListeners = new Set<(status: VelarHostExtensionBridgeStatus) => void>()
  private readonly workspaceSpacesById: ReadonlyMap<string, ProviderSurfaceWorkspaceSpace>
  private readonly workspaceCatalog: ProviderSurfaceWorkspaceCatalog
  private httpServer?: Server
  private webSocketServer?: WebSocketServer
  private readonly networkSockets = new Set<Socket>()
  private endpoint?: string
  private pairingCode?: string
  private pairingExpiresAt?: number
  private pairingTimer?: TimerLease
  private device: Nullable<DeviceRuntime> = null
  private activity: VelarHostExtensionBridgeStatus['activity'] = null
  private pairingFailures = 0
  private pairingBlockedUntil = 0

  public constructor(private readonly options: VelarHostExtensionBridgeOptions) {
    this.now = options.now ?? Date.now
    const projectWorkspaceBindingId = createHash('sha256')
      .update(options.workspaceRoot)
      .digest('base64url')
      .slice(0, 32)
    const systemWorkspaceBindingId = createHash('sha256')
      .update('velar-host:system')
      .digest('base64url')
      .slice(0, 32)
    const workspaces = [
      {
        id: systemWorkspaceBindingId,
        space: 'system' as const,
        label: 'System',
        description: 'Observe and control this computer through Velar Host.',
      },
      {
        id: projectWorkspaceBindingId,
        space: 'project' as const,
        label: basename(options.workspaceRoot) || 'Project',
        description: options.workspaceRoot,
      },
    ]
    this.workspaceSpacesById = new Map(
      workspaces.map((workspace) => [workspace.id, workspace.space]),
    )
    this.workspaceCatalog = {
      revision: createHash('sha256')
        .update(JSON.stringify(workspaces))
        .digest('base64url')
        .slice(0, 20),
      workspaces,
    }
  }

  public async start(): Promise<VelarHostExtensionBridgeStatus> {
    if (isPresent(this.endpoint)) return this.getStatus()
    if (this.timers.isDisposed) {
      this.timers = new TimerScope({ name: 'VelarHostExtensionBridge' })
    }
    await mkdir(dirname(this.options.credentialPath), { recursive: true, mode: 0o700 })
    const credential = await this.loadCredential()
    if (isNotNull(credential)) this.device = this.createDeviceRuntime(credential)
    await this.listen()
    this.startPairing()
    return this.getStatus()
  }

  public startPairing(): VelarHostExtensionBridgeStatus {
    if (!isPresent(this.endpoint)) throw new Error('Extension bridge is not started')
    this.pairingTimer?.cancel()
    this.pairingCode = this.options.pairingCode ?? String(randomInt(100_000, 1_000_000))
    this.pairingExpiresAt = this.now() + PairingLifetimeMs
    this.pairingFailures = 0
    this.pairingBlockedUntil = 0
    this.pairingTimer = this.timers.after(PairingLifetimeMs, () => {
      this.pairingCode = undefined
      this.pairingExpiresAt = undefined
      this.pairingTimer = undefined
      this.emitStatus()
    }, { label: 'pairing-expiry', unref: true })
    this.emitStatus()
    return this.getStatus()
  }

  public async disconnectDevice(): Promise<void> {
    const device = this.device
    this.send(toNullable(device?.socket), {
      version: ExternalAgentBridgeProtocolVersion,
      type: 'disconnected',
    })
    device?.socket?.close(4000, 'Disconnected by Velar Host control')
    device?.surfaces.clear()
    this.device = null
    await unlink(this.options.credentialPath).catch((error) => {
      if (!isNodeError(error, 'ENOENT')) throw error
    })
    this.emitStatus()
  }

  public subscribeStatus(
    listener: (status: VelarHostExtensionBridgeStatus) => void,
  ): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  public getStatus(): VelarHostExtensionBridgeStatus {
    if (!isPresent(this.endpoint)) throw new Error('Extension bridge is not started')
    const pairingAvailable = this.isPairingAvailable()
    return {
      endpoint: this.endpoint,
      pairingCode: pairingAvailable ? toNullable(this.pairingCode) : null,
      pairingExpiresAt: pairingAvailable ? toNullable(this.pairingExpiresAt) : null,
      connected: this.device?.socket?.readyState === WebSocket.OPEN,
      deviceId: toNullable(this.device?.public.id),
      provider: toNullable(this.device?.public.provider),
      surfaceCount: this.device?.surfaces.size ?? 0,
      activity: this.activity,
    }
  }

  public async stop(): Promise<void> {
    this.pairingTimer?.cancel()
    this.pairingTimer = undefined
    this.timers.dispose()
    const device = this.device
    if (device?.socket?.readyState === WebSocket.OPEN) {
      device.socket.close(1001, 'Velar Host stopped')
    }
    device?.surfaces.clear()
    for (const client of this.webSocketServer?.clients ?? []) client.terminate()
    for (const socket of this.networkSockets) socket.destroy()
    this.networkSockets.clear()
    // `ws` in noServer mode owns no listening handle. After all upgraded TCP
    // sockets are destroyed above, close only transitions its in-memory state;
    // waiting for the optional callback is unreliable across Node-compatible
    // runtimes because no underlying server was ever attached to this instance.
    this.webSocketServer?.close()
    this.httpServer?.closeAllConnections()
    this.httpServer?.close()
    this.webSocketServer = undefined
    this.httpServer = undefined
    this.endpoint = undefined
    this.statusListeners.clear()
  }

  private isPairingAvailable(): boolean {
    return isPresent(this.pairingCode)
      && (this.pairingExpiresAt ?? 0) > this.now()
      && this.pairingBlockedUntil <= this.now()
  }

  private async listen(): Promise<void> {
    const portStart = this.options.portStart ?? DefaultBridgePortStart
    const portEnd = this.options.portEnd ?? DefaultBridgePortEnd
    if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart > portEnd) {
      throw new Error('Invalid extension bridge port range')
    }
    for (let port = portStart; port <= portEnd; port += 1) {
      const webSocketServer = new WebSocketServer({
        noServer: true,
        maxPayload: MaxSocketPayloadBytes,
      })
      const server = createServer((_request, response) => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found')
      })
      server.on('connection', (socket) => {
        this.networkSockets.add(socket)
        socket.once('close', () => this.networkSockets.delete(socket))
      })
      server.on('upgrade', (request, socket, head) => {
        const origin = request.headers.origin
        if (
          request.url !== ExternalAgentBridgeProtocolDescriptor.socketPath
          || !isChromeExtensionOrigin(origin)
        ) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request)
        })
      })
      webSocketServer.on('connection', (socket) => this.accept(socket))
      try {
        const actualPort = await this.listenServer(server, port)
        this.webSocketServer = webSocketServer
        this.httpServer = server
        this.endpoint = `ws://${BridgeHost}:${actualPort}${ExternalAgentBridgeProtocolDescriptor.socketPath}`
        return
      } catch (error) {
        webSocketServer.close()
        server.close()
        if (!isNodeError(error, 'EADDRINUSE')) throw error
      }
    }
    throw new Error(`No extension bridge port is available in ${portStart}-${portEnd}`)
  }

  private listenServer(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        if (isNull(address) || isString(address)) {
          reject(new Error('Extension bridge did not bind a TCP port'))
          return
        }
        resolve(address.port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, BridgeHost)
    })
  }

  private accept(socket: WebSocket): void {
    let attached: Nullable<DeviceRuntime> = null
    let processing = Promise.resolve()
    socket.on('message', (data, isBinary) => {
      processing = processing
        .then(async () => {
          attached = await this.handleMessage(socket, attached, data, isBinary)
        })
        .catch((error) => {
          this.send(socket, {
            version: ExternalAgentBridgeProtocolVersion,
            type: 'error',
            code: 'BRIDGE_REQUEST_FAILED',
            error: error instanceof Error ? error.message : String(error),
          })
        })
    })
    socket.on('close', () => {
      if (attached?.socket === socket) {
        attached.socket = null
        attached.public.lastSeenAt = this.now()
        this.emitStatus()
      }
    })
  }

  private async handleMessage(
    socket: WebSocket,
    attached: Nullable<DeviceRuntime>,
    data: RawData,
    isBinary: boolean,
  ): Promise<Nullable<DeviceRuntime>> {
    if (isBinary) throw new Error('Binary extension bridge frames are not supported')
    const message = parseExternalAgentBridgeClientMessage(JSON.parse(data.toString()))
    if (message.type === 'probe') {
      this.send(socket, {
        version: ExternalAgentBridgeProtocolVersion,
        type: 'hello',
        service: ExternalAgentBridgeProtocolDescriptor.service,
        protocol: ExternalAgentBridgeProtocolVersion,
        pairingAvailable: this.isPairingAvailable(),
        deviceId: toNullable(this.device?.public.id),
      })
      return attached
    }
    if (message.type === 'pair') {
      if (isNotNull(attached)) throw new Error('WebSocket is already paired')
      const device = await this.pair(message)
      this.attach(device, socket)
      this.send(socket, {
        version: ExternalAgentBridgeProtocolVersion,
        type: 'paired',
        token: device.token,
        device: device.public,
      })
      this.replay(device, 0)
      return device
    }
    if (message.type === 'resume') {
      if (isNotNull(attached)) throw new Error('WebSocket is already paired')
      const device = this.device
      if (
        isNull(device)
        || message.deviceId !== device.public.id
        || !tokensEqual(message.token, device.token)
      ) {
        throw new Error('Extension bridge resume token is invalid')
      }
      const after = Math.min(message.after, device.commandSequence)
      this.attach(device, socket)
      this.send(socket, {
        version: ExternalAgentBridgeProtocolVersion,
        type: 'resumed',
        device: device.public,
        after,
      })
      this.replay(device, after)
      return device
    }
    if (isNull(attached) || attached.socket !== socket) {
      throw new Error('WebSocket has not paired or resumed')
    }
    attached.public.lastSeenAt = this.now()
    if (message.type === 'ping') {
      this.send(socket, {
        version: ExternalAgentBridgeProtocolVersion,
        type: 'pong',
        at: this.now(),
      })
      return attached
    }
    if (message.type === 'ack') {
      if (message.sequence > attached.commandSequence) {
        throw new Error('Extension bridge acknowledgement is out of range')
      }
      attached.commands = attached.commands.filter(
        (command) => command.sequence > message.sequence,
      )
      return attached
    }
    if (message.type === 'event') {
      if (!attached.processedEventIds.has(message.eventId)) {
        await this.handleEvent(attached, message.event)
        attached.processedEventIds.add(message.eventId)
        if (attached.processedEventIds.size > MaxProcessedEvents) {
          const oldest = attached.processedEventIds.values().next().value
          if (isPresent(oldest)) attached.processedEventIds.delete(oldest)
        }
      }
      this.send(socket, {
        version: ExternalAgentBridgeProtocolVersion,
        type: 'event_ack',
        eventId: message.eventId,
      })
      return attached
    }
    if (message.type === 'disconnect') {
      await this.disconnectDevice()
      this.startPairing()
      return null
    }
    throw new Error('Unsupported extension bridge message')
  }

  private async pair(message: {
    code: string
    provider: string
    capabilities: unknown
    tabUrl: string
    modelLabel: Nullable<string>
    providerSnapshot: Nullable<unknown>
  }): Promise<DeviceRuntime> {
    if (!this.isPairingAvailable() || message.code.trim() !== this.pairingCode) {
      this.pairingFailures += 1
      if (this.pairingFailures >= 5) {
        this.pairingFailures = 0
        this.pairingBlockedUntil = this.now() + 30_000
      }
      throw new Error('Pairing code is invalid or expired')
    }
    const provider = message.provider.trim()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(provider)) {
      throw new Error('Provider identifier is invalid')
    }
    const tabUrl = new URL(message.tabUrl)
    if (tabUrl.protocol !== 'https:') throw new Error('Provider page must use HTTPS')
    const now = this.now()
    const credential: PersistedExtensionCredential = {
      schemaVersion: 1,
      token: randomBytes(32).toString('base64url'),
      device: {
        id: randomUUID(),
        provider,
        appVersion: this.options.hostVersion ?? '0.1.0',
        appEdition: 'host',
        capabilities: z.json().parse(message.capabilities),
        tabUrl: tabUrl.toString(),
        modelLabel: optionalString(message.modelLabel),
        providerSnapshot: isNull(message.providerSnapshot)
          ? null
          : z.json().parse(message.providerSnapshot),
        connectedAt: now,
        lastSeenAt: now,
      },
    }
    this.device?.socket?.close(4001, 'Replaced by a new pairing')
    this.device = this.createDeviceRuntime(credential)
    await this.saveCredential(credential)
    this.pairingCode = undefined
    this.pairingExpiresAt = undefined
    this.pairingTimer?.cancel()
    this.pairingTimer = undefined
    this.pairingFailures = 0
    return this.device
  }

  private createDeviceRuntime(credential: PersistedExtensionCredential): DeviceRuntime {
    return {
      public: credential.device,
      token: credential.token,
      socket: null,
      commandSequence: 0,
      commands: [],
      processedEventIds: new Set(),
      surfaces: new Map(),
    }
  }

  private attach(device: DeviceRuntime, socket: WebSocket): void {
    if (isNotNull(device.socket) && device.socket !== socket) {
      device.socket.close(4001, 'Replaced by another connection')
    }
    device.socket = socket
    device.public.lastSeenAt = this.now()
    this.emitStatus()
  }

  private async handleEvent(device: DeviceRuntime, event: Record<string, unknown>): Promise<void> {
    const type = requiredString(event.type, 'type', 128)
    if (type === 'heartbeat' || type === 'page_state' || type === 'provider_snapshot') return
    this.recordActivity(type)
    if (type === 'provider_workspace_catalog') {
      this.enqueue(device, 'provider_workspace_catalog', {
        correlationId: requiredString(event.correlationId, 'correlationId', 128),
        catalog: this.workspaceCatalog,
      })
      return
    }
    if (type === 'provider_project_workspace_pick') {
      this.enqueue(device, 'provider_workspace_catalog', {
        correlationId: requiredString(event.correlationId, 'correlationId', 128),
        catalog: this.workspaceCatalog,
        selectedWorkspaceBindingId: null,
        canceled: true,
      })
      return
    }
    if (type === 'provider_surface_prepare') {
      this.prepareSurface(device, event)
      return
    }
    if (type === 'provider_surface_tool_call') {
      await this.executeToolCall(device, event)
      return
    }
    if (type === 'provider_surface_release') {
      const surfaceId = optionalString(event.surfaceId)
      if (isNotNull(surfaceId)) device.surfaces.delete(surfaceId)
      this.emitStatus()
      return
    }
    if (type === 'provider_surface_state' || type === 'provider_surface_transcript') return
    throw new Error(`Unsupported provider surface event: ${type}`)
  }

  private prepareSurface(device: DeviceRuntime, event: Record<string, unknown>): void {
    const correlationId = requiredString(event.correlationId, 'correlationId', 128)
    const surfaceId = requiredString(event.surfaceId, 'surfaceId')
    const workspaceBindingId = optionalString(event.workspaceBindingId, 128)
    if (isNull(workspaceBindingId)) {
      device.surfaces.delete(surfaceId)
      this.enqueue(device, 'provider_surface_contract', {
        correlationId,
        surfaceId,
        binding: null,
        toolCatalog: null,
        workspaceRequired: true,
      })
      return
    }
    const workspaceSpace = this.workspaceSpacesById.get(workspaceBindingId)
    if (!isPresent(workspaceSpace)) {
      throw new Error('Selected Velar Host workspace is no longer available')
    }
    const catalog = this.options.toolGateway.snapshot(workspaceSpace)
    const now = this.now()
    const contractId = createHash('sha256')
      .update(
        `${device.public.id}\u0000${surfaceId}\u0000${workspaceBindingId}\u0000${catalog.revision}`,
      )
      .digest('base64url')
      .slice(0, 32)
    const previous = device.surfaces.get(surfaceId)
    const providerConversationId = optionalString(event.providerConversationId)
    const providerParentMessageId = optionalString(event.providerParentMessageId)
    const binding: ProviderSurfaceBinding = {
      ...(previous?.workspaceSpace === workspaceSpace
        ? previous.binding
        : createProviderSurfaceBinding(device.public.provider, workspaceSpace, now)),
      providerConversationId:
        isNotNull(providerConversationId)
          ? providerConversationId
          : toNullable(previous?.binding.providerConversationId),
      providerParentMessageId:
        isNotNull(providerParentMessageId)
          ? providerParentMessageId
          : toNullable(previous?.binding.providerParentMessageId),
      toolContract: {
        id: contractId,
        catalogRevision: catalog.revision,
        renewedAt: now,
        acknowledgedAt: null,
        turnsSinceRefresh: 0,
        needsRefresh: false,
      },
      updatedAt: now,
    }
    device.surfaces.set(surfaceId, {
      surfaceId,
      workspaceBindingId,
      workspaceSpace,
      binding,
      contractId,
      activeToolCallId: null,
    })
    this.emitStatus()
    this.enqueue(device, 'provider_surface_contract', {
      correlationId,
      surfaceId,
      workspaceBindingId,
      binding,
      toolCatalog: catalog,
    })
  }

  private async executeToolCall(
    device: DeviceRuntime,
    event: Record<string, unknown>,
  ): Promise<void> {
    const correlationId = requiredString(event.correlationId, 'correlationId', 128)
    const surfaceId = requiredString(event.surfaceId, 'surfaceId')
    const parsedCall = ProviderSurfaceToolCallSchema.safeParse(event.call)
    if (!parsedCall.success) throw new Error('Provider tool call is invalid')
    const call = parsedCall.data
    this.recordActivity('provider_surface_tool_call', call.toolName, 'running')
    const surface = device.surfaces.get(surfaceId)
    this.enqueue(device, 'provider_surface_tool_progress', {
      correlationId,
      surfaceId,
      toolCallId: call.toolCallId,
      phase: 'running',
    })
    let result: ProviderSurfaceToolResult
    if (
      !isPresent(surface)
      || call.contractId !== surface.contractId
      || call.catalogRevision !== surface.binding.toolContract?.catalogRevision
    ) {
      result = this.deniedResult(
        call,
        isPresent(surface)
          ? this.options.toolGateway.snapshot(surface.workspaceSpace).revision
          : call.catalogRevision,
        '工具调用使用了失效的 Host 契约，本次调用未执行。',
      )
    } else if (isNotNull(surface.activeToolCallId)) {
      result = this.deniedResult(
        call,
        surface.binding.toolContract?.catalogRevision ?? call.catalogRevision,
        '同一官网会话一次只能执行一个 Velar Host 工具。',
      )
    } else {
      surface.activeToolCallId = call.toolCallId
      try {
        result = await this.options.toolGateway.execute(call, surface.workspaceSpace)
      } finally {
        surface.activeToolCallId = null
      }
    }
    this.enqueue(device, 'provider_surface_tool_result', {
      correlationId,
      surfaceId,
      result,
    })
    this.recordActivity('provider_surface_tool_result', call.toolName, result.status)
  }

  private recordActivity(
    eventType: string,
    toolName: Nullable<string> = null,
    status: Nullable<string> = null,
  ): void {
    this.activity = {
      eventType,
      at: this.now(),
      toolName,
      status,
    }
    this.emitStatus()
  }

  private deniedResult(
    call: ProviderSurfaceToolCall,
    catalogRevision: string,
    error: string,
  ): ProviderSurfaceToolResult {
    return {
      protocolVersion: call.protocolVersion,
      contractId: call.contractId,
      catalogRevision,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      status: 'denied',
      error,
    }
  }

  private enqueue(
    device: DeviceRuntime,
    type: BridgeCommand['type'],
    payload: Record<string, unknown>,
  ): void {
    const command = { sequence: ++device.commandSequence, type, payload }
    device.commands = [...device.commands, command].slice(-MaxCommands)
    this.send(device.socket, {
      version: ExternalAgentBridgeProtocolVersion,
      type: 'command',
      command,
    })
  }

  private replay(device: DeviceRuntime, after: number): void {
    for (const command of device.commands) {
      if (command.sequence > after) {
        this.send(device.socket, {
          version: ExternalAgentBridgeProtocolVersion,
          type: 'command',
          command,
        })
      }
    }
  }

  private send(socket: Nullable<WebSocket>, message: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  private emitStatus(): void {
    if (!isPresent(this.endpoint)) return
    const status = this.getStatus()
    for (const listener of this.statusListeners) listener(status)
  }

  private async loadCredential(): Promise<Nullable<PersistedExtensionCredential>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.options.credentialPath, 'utf8'))
      const parsed = PersistedExtensionCredentialSchema.safeParse(value)
      return parsed.success ? parsed.data : null
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  private async saveCredential(credential: PersistedExtensionCredential): Promise<void> {
    const temporaryPath = `${this.options.credentialPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(credential)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.options.credentialPath)
  }
}
