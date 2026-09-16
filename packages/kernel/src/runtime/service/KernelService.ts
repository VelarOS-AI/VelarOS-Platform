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
  toOptional,
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
import { type KernelModCatalog, KernelModCatalogError } from './mod-catalog'

const log = Log.tag('KernelService')

/**
 * `failed` 是启动失败后的终态。
 *
 * 少了它，启动失败后的状态一直停在 `idle`，于是会话打开与能力调用都回「可重试」，而
 * `start()` 只会重放同一个失败——调用方按提示重试，永远得到同一句话。
 */
export type KernelServiceStatus = 'idle' | 'started' | 'failed' | 'disposed'

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

/** 之前已经启动失败过；这不是可重试的状态，要换一个新的 host / service。 */
export class KernelServiceStartFailedError extends Error {
  public readonly code = 'KERNEL_START_FAILED'

  public constructor(cause: unknown) {
    super('Kernel service 已经启动失败过，不会重试；请重建 Kernel 再启动', {
      cause,
    })
    this.name = 'KernelServiceStartFailedError'
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
  details: Nullable<Readonly<Record<string, unknown>>> = null,
): CapabilityCallFailure {
  return {
    protocolVersion: KernelProtocolVersion,
    callId,
    status: 'error',
    error: {
      code,
      message,
      retryable,
      details,
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
  private startFailure?: unknown
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
        return Promise.reject(new Error('已回收的 Kernel service 不能再启动'))
      case 'failed':
        return Promise.reject(
          new KernelServiceStartFailedError(this.startFailure),
        )
      case 'started':
        return Promise.resolve()
      case 'idle':
        break
    }
    this.startPromise ??= this.startOnce()
    return this.startPromise
  }

  private async startOnce(): Promise<void> {
    try {
      await this.options.host.start()
    } catch (error) {
      // 启动失败是终态：同一个 host 不会因为再调一次 start() 就变好。
      if (this.status === 'idle') {
        this.status = 'failed'
        this.startFailure = error
      }
      throw error
    }
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
      // 进程内路径的错误消息就是 broker 给的原因；serve 路径不能把它丢掉，否则同一次拒绝
      // 在两条路径上说的不是一回事，模型也拿不到「为什么被拒」。
      if (error instanceof KernelCapabilityPermissionDeniedError) return failure(
          request.callId,
          'PERMISSION_DENIED',
          `能力调用被权限策略拒绝：${error.reason}`,
          false,
          { permission: error.permission, reason: error.reason },
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

  /**
   * 从目录安装一个 mod pack。
   *
   * 失败原因（目录不存在、`velaros.mod.json` 不合法、入口导不出模块定义……）必须随错误一起
   * 回到调用方：原来它是一个无码的普通错误，RPC 那侧统一投影成「INTERNAL_ERROR，可重试」，
   * 真正的原因只进了守护进程日志。
   */
  public async installModFromDirectory(
    directory: string,
  ): ReturnType<KernelModCatalog['installFromDirectory']> {
    this.assertStarted()
    try {
      return await this.requireModCatalog().installFromDirectory(directory)
    } catch (error) {
      if (error instanceof KernelModCatalogError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      log.warn('Mod pack install failed', { directory, error })
      throw new KernelModCatalogError(
        'MOD_INSTALL_FAILED',
        `从目录安装 mod pack 失败：${reason}`,
        { directory, reason },
        { cause: error },
      )
    }
  }

  private requireModCatalog(): KernelModCatalog {
    if (isUndefined(this.options.modCatalog)) {
      throw new KernelModCatalogError(
        'MODS_UNAVAILABLE',
        '本 Kernel 没有接 ModStore，mods.* 不可用',
      )
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
    error: snapshot.error,
  }
}

function toSdkScope(
  scope: CapabilityCallRequest['scope'],
): ScopeRef | undefined {
  if (isNull(scope)) return undefined
  return {
    id: scope.id,
    ownerModuleId: scope.ownerModuleId,
    kind: toOptional(scope.kind),
  }
}
