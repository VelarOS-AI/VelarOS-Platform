import {
  isBlank,
  isEmpty,
  isNotUndefined,
  isNull,
  isObject,
  isString,
  isUndefined,
  Log,
  toNullable,
} from '@velaros-ai/core'

import {
  type KernelEventHandler,
  type KernelRegistration,
  type ScopeRef,
  UnknownKernelCapabilityOperationError,
} from '../../contracts/abi'
import {
  type CapabilityCallFailure,
  type CapabilityCallRequest,
  CapabilityCallRequestSchema,
  type CapabilityCallResponse,
  type CapabilityRequireItem,
  type CapabilitySessionOpenFailure,
  type CapabilitySessionOpenRequest,
  CapabilitySessionOpenRequestSchema,
  type KernelHandshake,
  type KernelModuleDescriptor,
  KernelProtocolVersion,
  type KernelRunIdentity,
  type KernelSessionIdentity,
} from '../../contracts/protocol'
import type {
  KernelServiceHealth,
  KernelServiceModuleHealth,
  OpenKernelSessionInput,
  StartKernelRunInput,
} from '../../contracts/service'
import {
  KernelCapabilityInvoker,
  KernelCapabilityNotCallableError,
  KernelCapabilityOperationMetadataError,
  KernelCapabilityPermissionCheckError,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from '../capability-invocation'
import type {
  KernelCompositionSnapshot,
  KernelModuleHost,
  KernelModuleSnapshot,
} from '../host'

import {
  DenyAllKernelClientAccessBroker,
  type KernelClientAccessBroker,
} from './client-access'
import { KernelIdentityRegistry } from './identity-registry'
import type { KernelModCatalog } from './mod-catalog'

const log = Log.tag('KernelService')

export type KernelServiceStatus = 'idle' | 'started' | 'disposed'

export interface KernelServiceOptions {
  readonly host: KernelModuleHost
  readonly identities?: KernelIdentityRegistry
  readonly kernelVersion: string
  /** Gates capability.session.open. Defaults to deny-all. */
  readonly clientAccessBroker?: KernelClientAccessBroker
  /** Optional ModStore catalog for mods.* RPC. */
  readonly modCatalog?: KernelModCatalog
}

export class KernelServiceLifecycleError extends Error {
  public readonly code = 'KERNEL_NOT_STARTED'

  public constructor() {
    super('Kernel service is not started')
    this.name = 'KernelServiceLifecycleError'
  }
}

function toCatalogRevision(snapshot: KernelModuleSnapshot): string {
  const { id, version } = snapshot.manifest
  return `${id}@${version}#${snapshot.generation}`
}

function toDescriptor(
  snapshot: KernelModuleSnapshot,
): KernelModuleDescriptor {
  const { manifest } = snapshot
  return {
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    provides: manifest.provides.map(({ id, version }) => ({ id, version })),
    requires: manifest.requires.map(({ id, versionRange }) => ({
      id,
      versionRange: toNullable(versionRange),
    })),
    optionalRequires: manifest.optionalRequires.map(
      ({ id, versionRange }) => ({
        id,
        versionRange: toNullable(versionRange),
      }),
    ),
    permissions: [...manifest.permissions],
    isolation: manifest.isolation,
    catalogRevision: toCatalogRevision(snapshot),
  }
}

function failure(
  callId: string,
  code: string,
  message: string,
  retryable = false,
): CapabilityCallFailure {
  return {
    protocolVersion: KernelProtocolVersion,
    callId,
    status: 'error',
    error: {
      code,
      message,
      retryable,
      details: null,
    },
  }
}

function sessionFailure(
  code: string,
  message: string,
  retryable = false,
): CapabilitySessionOpenFailure {
  return {
    protocolVersion: KernelProtocolVersion,
    status: 'error',
    error: {
      code,
      message,
      retryable,
      details: null,
    },
  }
}

function readCallId(input: unknown): string {
  if (!isObject(input) && !isNull(input) || isNull(input)) return 'invalid-call'
  const callId = Reflect.get(input, 'callId')
  return isString(callId) && !isEmpty(callId)
    ? callId
    : 'invalid-call'
}

/**
 * Product-neutral API facade over the module host.
 *
 * Product clients see protocol objects and callable capabilities only. Host
 * internals, concrete module implementations, and thrown errors remain behind
 * this boundary.
 */
export class KernelService {
  private status: KernelServiceStatus = 'idle'
  private startPromise?: Promise<void>
  private disposePromise?: Promise<void>
  private readonly identities: KernelIdentityRegistry
  private readonly clientAccessBroker: KernelClientAccessBroker
  private readonly capabilityInvoker: KernelCapabilityInvoker

  public constructor(private readonly options: KernelServiceOptions) {
    if (isBlank(options.kernelVersion.trim())) {
      throw new Error('Kernel version must not be empty')
    }
    this.identities = options.identities ?? new KernelIdentityRegistry()
    this.clientAccessBroker = options.clientAccessBroker
      ?? new DenyAllKernelClientAccessBroker()
    this.capabilityInvoker = new KernelCapabilityInvoker(options.host)
  }

  public getStatus(): KernelServiceStatus {
    return this.status
  }

  public start(): Promise<void> {
    switch (this.status) {
      case 'disposed':
        return Promise.reject(new Error('Disposed kernel service cannot be started'))
      case 'started':
        return Promise.resolve()
      case 'idle':
        break
    }
    this.startPromise ??= this.startOnce()
    return this.startPromise
  }

  private async startOnce(): Promise<void> {
    await this.options.host.start()
    if (this.status === 'idle') this.status = 'started'
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    if (this.status === 'disposed') return
    this.status = 'disposed'
    this.identities.clear()
    await this.options.host.dispose()
  }

  public handshake(): KernelHandshake {
    return {
      protocolVersion: KernelProtocolVersion,
      kernelVersion: this.options.kernelVersion,
      modules: this.options.host.listModules().map(toDescriptor),
    }
  }

  /** 本机诊断/CLI 可直接 JSON 序列化；远端 wire 仍只走版本化协议。 */
  public describeComposition(): KernelCompositionSnapshot {
    return this.options.host.describeComposition()
  }

  public async health(): Promise<KernelServiceHealth> {
    if (this.status !== 'started')
      return { status: 'stopped', modules: this.moduleHealthSnapshots() }

    const snapshots = await this.options.host.checkHealth()
    const modules = snapshots.map(toModuleHealth)
    const degraded = modules.some(
      (module) =>
        module.status !== 'ready'
        || module.health.status === 'degraded'
        || module.health.status === 'unhealthy',
    )
    return {
      status: degraded ? 'degraded' : 'healthy',
      modules,
    }
  }

  /**
   * Evaluates a capability session open against catalog + access policy.
   *
   * Does not record the session — the RPC / in-process connection ledger owns that.
   */
  public async evaluateCapabilitySessionOpen(
    input: unknown,
  ): Promise<
    | { readonly status: 'ok'; readonly request: CapabilitySessionOpenRequest }
    | CapabilitySessionOpenFailure
  > {
    const parsed = CapabilitySessionOpenRequestSchema.safeParse(input)
    if (!parsed.success) return sessionFailure(
        'INVALID_REQUEST',
        'Capability session open request does not match kernel protocol v2',
      )

    const request = parsed.data
    if (this.status !== 'started') return sessionFailure(
        'KERNEL_NOT_STARTED',
        'Kernel service is not started',
        this.status === 'idle',
      )

    for (const item of request.requires) {
      const evaluation = await this.evaluateRequireItem(item)
      if (isNotUndefined(evaluation)) return evaluation
    }

    return { status: 'ok', request }
  }

  private async evaluateRequireItem(
    item: CapabilityRequireItem,
  ): Promise<CapabilitySessionOpenFailure | undefined> {
    if (isUndefined(this.findCapabilityById(item.capabilityId))) return sessionFailure(
        'CAPABILITY_NOT_AVAILABLE',
        `Capability "${item.capabilityId}" is not loaded`,
      )

    try {
      const decision = await this.clientAccessBroker.requestBind({
        capabilityId: item.capabilityId,
        operations: item.operations,
        scope: item.scope,
      })
      if (decision.status === 'denied') return sessionFailure(
          'CAPABILITY_BIND_DENIED',
          decision.reason,
        )
    } catch (error) {
      log.warn('Capability bind policy failed', { capabilityId: item.capabilityId, error })
      return sessionFailure(
        'CAPABILITY_BIND_FAILED',
        'Capability session bind could not be resolved',
        true,
      )
    }
    return undefined
  }

  public async handleCapabilityCall(
    input: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CapabilityCallResponse> {
    const parsed = CapabilityCallRequestSchema.safeParse(input)
    if (!parsed.success)
      return failure(
        readCallId(input),
        'INVALID_REQUEST',
        'Capability call request does not match kernel protocol v2',
      )

    const request = parsed.data
    if (this.status !== 'started')
      return failure(
        request.callId,
        'KERNEL_NOT_STARTED',
        'Kernel service is not started',
        this.status === 'idle',
      )

    try {
      const output = await this.capabilityInvoker.invoke({
        capabilityId: request.capabilityId,
        operation: request.operation,
        scope: toSdkScope(request.scope),
        input: request.input,
        signal,
      })
      return {
        protocolVersion: KernelProtocolVersion,
        callId: request.callId,
        status: 'ok',
        output,
      }
    } catch (error) {
      if (error instanceof KernelCapabilityUnavailableError) return failure(
          request.callId,
          'CAPABILITY_NOT_FOUND',
          `Capability "${request.capabilityId}" is not available`,
        )
      if (error instanceof KernelCapabilityNotCallableError) return failure(
          request.callId,
          'CAPABILITY_NOT_CALLABLE',
          `Capability "${request.capabilityId}" does not expose the call interface`,
        )
      if (error instanceof UnknownKernelCapabilityOperationError) return failure(
          request.callId,
          'OPERATION_NOT_FOUND',
          `Operation "${request.operation}" is not available`,
        )
      if (error instanceof KernelCapabilityOperationMetadataError) {
        log.warn('Capability operation metadata lookup failed', {
          capabilityId: request.capabilityId,
          error,
          operation: request.operation,
        })
        return failure(
          request.callId,
          'OPERATION_METADATA_FAILED',
          'Capability operation metadata could not be resolved',
        )
      }
      if (error instanceof KernelCapabilityPermissionDeniedError) return failure(
          request.callId,
          'PERMISSION_DENIED',
          'Capability call permission was denied',
        )
      if (error instanceof KernelCapabilityPermissionCheckError) {
        log.warn('Capability permission check failed', {
          capabilityId: request.capabilityId,
          error,
          operation: request.operation,
        })
        return failure(
          request.callId,
          'PERMISSION_CHECK_FAILED',
          'Capability call permission could not be resolved',
          true,
        )
      }
      log.warn('Capability invocation failed', {
        aborted: signal.aborted,
        capabilityId: request.capabilityId,
        error,
        operation: request.operation,
      })
      return failure(
        request.callId,
        signal.aborted ? 'CALL_ABORTED' : 'CAPABILITY_CALL_FAILED',
        signal.aborted
          ? 'Capability call was aborted'
          : 'Capability call failed',
        !signal.aborted,
      )
    }
  }

  private findCapabilityById(capabilityId: string):
    | { readonly token: { readonly id: string; readonly version: string } }
    | undefined {
    const token = this.options.host.getActiveCapabilityToken(capabilityId)
    return isUndefined(token) ? undefined : { token }
  }

  private moduleHealthSnapshots(): readonly KernelServiceModuleHealth[] {
    return this.options.host.listModules().map(toModuleHealth)
  }

  public openSession(
    input: OpenKernelSessionInput,
  ): KernelSessionIdentity {
    this.assertStarted()
    return this.identities.openSession(input)
  }

  public getSession(sessionId: string): KernelSessionIdentity | undefined {
    this.assertStarted()
    return this.identities.getSession(sessionId)
  }

  public listSessions(): readonly KernelSessionIdentity[] {
    this.assertStarted()
    return this.identities.listSessions()
  }

  public closeSession(sessionId: string): boolean {
    this.assertStarted()
    return this.identities.closeSession(sessionId)
  }

  public startRun(input: StartKernelRunInput): KernelRunIdentity {
    this.assertStarted()
    return this.identities.startRun(input)
  }

  public getRun(runId: string): KernelRunIdentity | undefined {
    this.assertStarted()
    return this.identities.getRun(runId)
  }

  public listRuns(): readonly KernelRunIdentity[] {
    this.assertStarted()
    return this.identities.listRuns()
  }

  public finishRun(runId: string): boolean {
    this.assertStarted()
    return this.identities.finishRun(runId)
  }

  public subscribe<TPayload>(
    type: string,
    handler: KernelEventHandler<TPayload>,
  ): KernelRegistration {
    this.assertStarted()
    if (isBlank(type.trim())) {
      throw new Error('Kernel event type must not be empty')
    }
    return this.options.host.subscribe(type, handler)
  }

  public listMods(): ReturnType<KernelModCatalog['list']> {
    this.assertStarted()
    return this.requireModCatalog().list()
  }

  public setModEnabled(
    id: string,
    enabled: boolean,
  ): ReturnType<KernelModCatalog['setEnabled']> {
    this.assertStarted()
    return this.requireModCatalog().setEnabled(id, enabled)
  }

  public installModFromDirectory(
    directory: string,
  ): ReturnType<KernelModCatalog['installFromDirectory']> {
    this.assertStarted()
    return this.requireModCatalog().installFromDirectory(directory)
  }

  private requireModCatalog(): KernelModCatalog {
    if (isUndefined(this.options.modCatalog)) {
      throw Object.assign(new Error('Mod catalog is not available'), {
        code: 'MODS_UNAVAILABLE',
      })
    }
    return this.options.modCatalog
  }

  private assertStarted(): void {
    if (this.status === 'started') return
    throw new KernelServiceLifecycleError()
  }
}

function toModuleHealth(
  snapshot: KernelModuleSnapshot,
): KernelServiceModuleHealth {
  return {
    id: snapshot.manifest.id,
    version: snapshot.manifest.version,
    generation: snapshot.generation,
    status: snapshot.status,
    health: snapshot.health,
    ...(isUndefined(snapshot.error) ? {} : { error: snapshot.error }),
  }
}

function toSdkScope(
  scope: CapabilityCallRequest['scope'],
): ScopeRef | undefined {
  if (isNull(scope)) return undefined
  return {
    id: scope.id,
    ownerModuleId: scope.ownerModuleId,
    ...(isNull(scope.kind) ? {} : { kind: scope.kind }),
  }
}
