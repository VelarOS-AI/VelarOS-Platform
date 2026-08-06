// 域：远程能力节点在 Velar Host 里的落位。
//
// 这台机器在这条链路上是 **Node**（无头能力提供者）：零会话权威、零 Agent 主干，只把本机
// 已授权的能力面摊给唯一一台已配对的 Client。所有跨机行为的真值仍然在别处——可见性归
// `VelarHostToolGateway`，权限归 `VelarHostPermissionBroker`，开关归 `VelarHostConfigStore`；
// 本文件只做端口实现与生命周期，不额外持有任何一份会漂移的授权副本。
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

import {
  AppError,
  isNull,
  isPresent,
  isTrue,
  isUndefined,
  Log,
  toNullable,
} from '@velaros-ai/core'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import type {
  KernelModuleDescriptor,
  RemoteNodeCapabilityDescriptor,
  RemoteNodeManifest,
  RemoteNodeToolDescriptor,
} from '@velaros-ai/kernel/contracts/protocol'
import { createManifest } from '@velaros-ai/remote-host'
import {
  createRemoteNodeFileAuditLog,
  createRemoteNodeFileCredentialStore,
  type RemoteNodeAuditSink,
  type RemoteNodeCapabilityInvoker,
  type RemoteNodeCapabilityInvokeRequest,
  type RemoteNodeCapabilityInvokeResult,
  type RemoteNodeCredentialStore,
  type RemoteNodeManifestSource,
  type RemoteNodePairedCredential,
  RemoteNodeServer,
} from '@velaros-ai/remote-host/node'

import type { VelarHostConfig, VelarHostConfigStore } from './config'
import type { VelarHostToolGateway, VelarHostToolRoute } from './tool-gateway'

const RemoteNodeLog = Log.tag('VelarHostRemoteNode')

/**
 * 状态轮询间隔。
 *
 * `RemoteNodeServer` 不提供状态订阅——配对与连接都在 wire 上完成，Node 侧没有回调位。因此这里
 * 主动拉取并按内容去重，节奏跟控制页自己的刷新（2.5s）同量级，不追求更快。
 */
const RemoteNodeStatusPollMs = 2_000

/** 配对票据只在 HTTP 应答里出现一次；它绝不进入 `host.json`，也不进入任何状态广播。 */
export interface VelarHostRemoteNodePairing {
  readonly code: string
  readonly expiresAt: number
}

export interface VelarHostRemoteNodeStatus {
  readonly enabled: boolean
  readonly address: Nullable<string>
  readonly paired: Nullable<{
    readonly clientId: string
    readonly clientName: string
    readonly pairedAt: number
  }>
  readonly connected: boolean
}

/** 能力令牌 → 提供它的模块身份；Client 侧据此注册 `isolation: 'remote'` 的代理模块。 */
interface RemoteNodeCapabilityIdentity {
  readonly moduleId: string
  readonly version: string
}

/**
 * 能力派发端口。
 *
 * 复用工具面同一条 Kernel 会话：同一套 requires 绑定、同一个权限 broker。跨机调用因此不可能
 * 拿到比网页会话更宽的授权面，两者的收窄也永远同步。
 */
class VelarHostRemoteNodeInvoker implements RemoteNodeCapabilityInvoker {
  public constructor(private readonly gateway: VelarHostToolGateway) {}

  public async invoke(
    request: RemoteNodeCapabilityInvokeRequest,
    signal: AbortSignal,
  ): Promise<RemoteNodeCapabilityInvokeResult> {
    // 清单新鲜度门在 Server 侧，这里再按**当前**开关核一次：两次判定之间开关可能刚被关掉，
    // 收窄必须立刻生效，不能等下一份清单推送到对端。
    const exposed = this.gateway.remoteRoutes().some(
      (route) => route.capabilityId === request.capabilityId
        && route.operation === request.operation,
    )
    if (!exposed) return {
      status: 'denied',
      error: {
        code: 'CAPABILITY_NOT_EXPOSED',
        message: `Operation "${request.capabilityId}.${request.operation}" is not exposed by this node`,
      },
    }
    const response = await this.gateway.callCapability({
      capabilityId: request.capabilityId,
      operation: request.operation,
      scope: request.scope,
      input: request.input,
    }, signal)
    if (response.status === 'ok') return { status: 'success', output: response.output }
    // 只有权限拒绝是「派发后的策略事实」，如实回给模型；其余故障抛出去由 Server 统一翻成
    // wire 上的 error——把校验失败也塞进 denied 会让模型以为是权限问题而去请求授权。
    if (response.error.code !== 'PERMISSION_DENIED') {
      throw new AppError(response.error.code, response.error.message, undefined, {
        capabilityId: request.capabilityId,
        operation: request.operation,
      })
    }
    return {
      status: 'denied',
      error: { code: response.error.code, message: response.error.message },
    }
  }
}

/**
 * 清单来源。
 *
 * 工具面与能力面都从 `gateway.remoteRoutes()` 一处派生，故一个开关翻转必然同时改变两者与
 * revision；`publish()` 按 revision 去重，无关字段（如 Computer 资源目录）变化不会白白让对端
 * 重注册整张工具面。
 */
class VelarHostRemoteNodeManifestSource implements RemoteNodeManifestSource {
  private readonly listeners = new Set<(manifest: RemoteNodeManifest) => void>()
  private lastRevision: Nullable<string> = null

  public constructor(
    private readonly gateway: VelarHostToolGateway,
    private readonly capabilities: ReadonlyMap<string, RemoteNodeCapabilityIdentity>,
  ) {}

  public current(): RemoteNodeManifest {
    // 认不出模块身份的能力一律整条剔除：Client 无法为它注册代理模块，留下工具只会产生一个
    // 永远调不通的名字。
    const routes = this.gateway.remoteRoutes()
      .filter((route) => this.capabilities.has(route.capabilityId))
    return createManifest(this.capabilityDescriptors(routes), routes.map(toToolDescriptor))
  }

  public onChange(listener: (manifest: RemoteNodeManifest) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public publish(): void {
    const manifest = this.current()
    if (manifest.revision === this.lastRevision) return
    this.lastRevision = manifest.revision
    for (const listener of this.listeners) listener(manifest)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  private capabilityDescriptors(
    routes: readonly VelarHostToolRoute[],
  ): RemoteNodeCapabilityDescriptor[] {
    const operationsByCapability = new Map<string, Map<string, readonly string[]>>()
    for (const route of routes) {
      const operations = operationsByCapability.get(route.capabilityId)
        ?? new Map<string, readonly string[]>()
      operations.set(route.operation, route.permissions)
      operationsByCapability.set(route.capabilityId, operations)
    }
    const descriptors: RemoteNodeCapabilityDescriptor[] = []
    for (const [capabilityId, operations] of operationsByCapability) {
      const identity = this.capabilities.get(capabilityId)
      if (isUndefined(identity)) continue
      descriptors.push({
        moduleId: identity.moduleId,
        capabilityId,
        version: identity.version,
        operations: [...operations].map(([name, permissions]) => ({
          name,
          permissions: [...permissions],
        })),
      })
    }
    return descriptors
  }
}

export interface VelarHostRemoteNodeOptions {
  readonly config: VelarHostConfigStore
  readonly toolGateway: VelarHostToolGateway
  readonly credentialPath: string
  readonly auditRoot: string
  readonly dataRoot: string
  readonly hostVersion: string
  /** Kernel 握手上报的模块表；能力令牌的 moduleId 与版本以它为准，不在本包重复声明。 */
  readonly modules: readonly KernelModuleDescriptor[]
}

/**
 * 远程节点的生命周期宿主。
 *
 * 它不是 Server 的包装层，而是「开关 → 监听状态」的调和器：配置是唯一的期望态，`reconcile()`
 * 把实际监听状态推到期望态并串行化，绝不并发起停两个 Server。
 */
export class VelarHostRemoteNode {
  private readonly timers = new TimerScope({ name: 'VelarHostRemoteNode' })
  private readonly nodeId: string
  private readonly nodeName: string
  private readonly credentialStore: RemoteNodeCredentialStore
  private readonly audit: RemoteNodeAuditSink
  private readonly manifestSource: VelarHostRemoteNodeManifestSource
  private readonly statusListeners = new Set<(status: VelarHostRemoteNodeStatus) => void>()
  private server?: RemoteNodeServer
  private binding: Nullable<VelarHostConfig['remoteNode']> = null
  private pairedCredential: Nullable<RemoteNodePairedCredential> = null
  private lastStatusKey: Nullable<string> = null
  private statusTimer?: TimerLease
  private syncing = Promise.resolve()
  private unsubscribeConfig?: () => void
  private stopped = false

  public constructor(private readonly options: VelarHostRemoteNodeOptions) {
    // nodeId 绑数据目录而不是主机名：改机器名不该让已配对的 Client 把这台机器当成新设备。
    this.nodeId = createHash('sha256').update(options.dataRoot).digest('base64url').slice(0, 32)
    this.nodeName = hostname().trim() || 'VelarOS Node'
    this.credentialStore = createRemoteNodeFileCredentialStore(options.credentialPath)
    this.audit = createRemoteNodeFileAuditLog({ directory: options.auditRoot })
    this.manifestSource = new VelarHostRemoteNodeManifestSource(
      options.toolGateway,
      capabilityIdentities(options.modules),
    )
  }

  public async start(): Promise<VelarHostRemoteNodeStatus> {
    this.unsubscribeConfig = this.options.config.subscribe(() => {
      this.manifestSource.publish()
      this.scheduleReconcile()
    })
    await this.reconcile()
    return this.getStatus()
  }

  public isEnabled(): boolean {
    return this.options.config.snapshot().value.remoteNode.enabled
  }

  /**
   * 状态投影是**逐字段挑选**而不是透传。
   *
   * 这层显式投影是 `host.json` 不含配对码与任何密钥材料的唯一保证：`RemoteNodeServerStatus` 里
   * 就带着 `pairingCode`，透传等于把一次性口令写进一个全局可读的文件。
   */
  public getStatus(): VelarHostRemoteNodeStatus {
    const enabled = this.isEnabled()
    const server = this.server
    if (isUndefined(server)) return {
      enabled,
      address: null,
      paired: null,
      connected: false,
    }
    const status = server.getStatus()
    const credential = this.pairedCredential
    // 名字与配对时刻只存在于凭据文件里；缓存尚未追上时宁可报 null，也不拿 clientId 硬凑一个。
    const paired = isNull(status.pairedClientId)
      || isNull(credential)
      || credential.clientId !== status.pairedClientId
      ? null
      : {
          clientId: credential.clientId,
          clientName: credential.clientName,
          pairedAt: credential.pairedAt,
        }
    return {
      enabled,
      address: status.endpoint,
      paired,
      connected: isPresent(status.connectedClientId),
    }
  }

  public startPairing(): VelarHostRemoteNodePairing {
    const server = this.server
    if (isUndefined(server)) throw new Error('Remote node is not listening')
    const status = server.startPairing()
    const code = status.pairingCode
    const expiresAt = status.pairingExpiresAt
    if (isNull(code) || isNull(expiresAt)) {
      throw new Error('Remote node did not issue a pairing code')
    }
    this.emitStatus()
    return { code, expiresAt }
  }

  public async revokePairing(): Promise<void> {
    const server = this.server
    if (isUndefined(server)) throw new Error('Remote node is not listening')
    await server.unpair()
    this.pairedCredential = null
    this.emitStatus()
  }

  public subscribeStatus(
    listener: (status: VelarHostRemoteNodeStatus) => void,
  ): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  public async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribeConfig?.()
    this.unsubscribeConfig = undefined
    this.manifestSource.dispose()
    // 走同一条队列而不是直接 stop：正在进行的 reconcile 可能刚 new 出一个 Server，绕开队列
    // 停机会把它漏在外面继续监听。
    await this.reconcile()
    this.timers.dispose()
    this.statusListeners.clear()
  }

  private reconcile(): Promise<void> {
    const operation = this.syncing.then(() => this.applyDesiredState())
    // 队列尾归一：一次同步失败不冻结后续的开关变化。
    this.syncing = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private scheduleReconcile(): void {
    void this.reconcile().catch((error: unknown) => {
      RemoteNodeLog.warn('远程节点开关同步失败，保持上一次的监听状态。', { error })
    })
  }

  private async applyDesiredState(): Promise<void> {
    const desired = this.options.config.snapshot().value.remoteNode
    if (this.stopped || !desired.enabled) {
      await this.stopServer()
      return
    }
    if (isPresent(this.server) && this.isBoundTo(desired)) return
    // 绑定面（地址或端口区间）变了只能重建：监听句柄一旦 bind 就不能改口。
    await this.stopServer()
    const server = new RemoteNodeServer({
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      nodeVersion: this.options.hostVersion,
      manifestSource: this.manifestSource,
      invoker: new VelarHostRemoteNodeInvoker(this.options.toolGateway),
      credentialStore: this.credentialStore,
      audit: this.audit,
      bindHost: desired.bindHost,
      portStart: desired.portStart,
      portEnd: desired.portEnd,
    })
    const started = await server.start()
    this.server = server
    this.binding = desired
    this.pairedCredential = isNull(started.pairedClientId)
      ? null
      : await this.credentialStore.load()
    this.statusTimer = this.timers.every(
      RemoteNodeStatusPollMs,
      () => this.pollStatus(),
      { label: 'remote-node-status', unref: true },
    )
    RemoteNodeLog.info('远程能力节点已开始监听。', {
      address: started.endpoint,
      nodeId: this.nodeId,
    })
    this.emitStatus()
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.statusTimer?.cancel()
    this.statusTimer = undefined
    this.server = undefined
    this.binding = null
    this.pairedCredential = null
    if (isUndefined(server)) return
    await server.stop()
    this.emitStatus()
  }

  /** 配对是在 wire 上完成的，Node 侧没有回调位；凭据缓存只能靠这条轮询追上事实。 */
  private pollStatus(): void {
    const server = this.server
    if (isUndefined(server)) return
    const pairedClientId = server.getStatus().pairedClientId
    if (isNull(pairedClientId)) {
      this.pairedCredential = null
      this.emitStatus()
      return
    }
    if (this.pairedCredential?.clientId === pairedClientId) {
      this.emitStatus()
      return
    }
    void this.credentialStore.load()
      .then((credential) => {
        this.pairedCredential = credential
        this.emitStatus()
      })
      .catch((error: unknown) => {
        RemoteNodeLog.warn('远程节点配对凭据读取失败，状态里的客户端信息暂缺。', { error })
      })
  }

  private isBoundTo(desired: VelarHostConfig['remoteNode']): boolean {
    const binding = this.binding
    if (isNull(binding)) return false
    return binding.bindHost === desired.bindHost
      && binding.portStart === desired.portStart
      && binding.portEnd === desired.portEnd
  }

  /** 按内容去重：轮询每 2 秒一次，无变化时不该惊动状态文件写入与控制页。 */
  private emitStatus(): void {
    const status = this.getStatus()
    const key = JSON.stringify(status)
    if (key === this.lastStatusKey) return
    this.lastStatusKey = key
    for (const listener of this.statusListeners) listener(status)
  }
}

function toToolDescriptor(route: VelarHostToolRoute): RemoteNodeToolDescriptor {
  return {
    name: route.descriptor.name,
    description: route.descriptor.description,
    inputSchema: route.descriptor.inputSchema,
    category: toNullable(route.descriptor.category),
    readOnly: isTrue(route.descriptor.readOnly),
    capabilityId: route.capabilityId,
    operation: route.operation,
  }
}

function capabilityIdentities(
  modules: readonly KernelModuleDescriptor[],
): ReadonlyMap<string, RemoteNodeCapabilityIdentity> {
  const identities = new Map<string, RemoteNodeCapabilityIdentity>()
  for (const module of modules) {
    for (const token of module.provides) {
      identities.set(token.id, { moduleId: module.id, version: token.version })
    }
  }
  return identities
}

