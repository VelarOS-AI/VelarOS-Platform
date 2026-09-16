import { isPresent, Log, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { createRemoteNodeClient } from '@velaros-ai/kernel/remote'

import type { RemoteHostServicePorts } from '../../contract/requires.js'
import type { ConnectedHost, RemoteHostDefinition, RemoteHostToolEntry } from '../../types/connectors.js'
import { buildRemoteToolName, createInvoker } from '../../utils/connectors/remote-host-service'
import { RemoteHostToolCategoryId } from '../../utils/connectors/remote-identity.js'

import { remoteHostToolFactory } from './RemoteHostToolFactory.js'

const log = Log.tag('RemoteHostService')

/**
 * 远程能力节点的领域服务对外这一面：连哪几台机器、什么时候配对、断开谁，以及把各台机器的能力清单投影成本地工具面。
 *
 * 实现是 `RemoteHostService`，宿主进程持一个，连接表只在内存里；任何一台连不上都只记 warn 不抛，远端离线是常态不是故障。
 * 授权判定不在这层：出网前过宿主的审批端口，落地时过目标机器自己的 permission broker。
 */
export interface RemoteHostServiceApi {
  /** 启动时按配置逐台点火，只连 `enabled` 的；单台失败只记 warn 继续下一台，整体不抛。已经连着的主机不会被重复点火。 */
  start(definitions: readonly RemoteHostDefinition[]): Promise<void>
  /** 首次配对：配对码只在这一次上线，先断掉这台已有的连接再带码重连；成功后凭据落盘，之后每次连接改走 challenge 签名。失败会原样抛给调用方（配对界面要显示）。 */
  pair(definition: RemoteHostDefinition, pairingCode: string): Promise<void>
  /** 断开某台主机并把它的工具从工具面摘掉；没连过这个 hostId 就什么都不做。用户手动断开、以及远端进入停机终态时都会走到这里。 */
  disconnectHost(hostId: string): void
  /** 关停整个服务：逐台断开、清空工具面。进程退出或 mod 卸载时调。 */
  dispose(): void
}

/**
 * 远程能力节点的领域服务。
 *
 * 职责边界:只做**连接生命周期 + 工具面投影**。授权判定不在这里——出网前过宿主的审批端口
 * (工具执行路),落地时过目标机器自己的 permission broker;本服务不做第三份策略判断,
 * 否则就成了一个谁都不认识、又谁都绕不开的影子权限层。
 *
 * 住在包里而不是宿主里是薄壳可拆铁律②的要求:命名空间化、清单投影、重连语义都是领域判断,
 * 散到宿主就等于把 mod 焊死在 Desktop 上。
 */
export class RemoteHostService implements RemoteHostServiceApi {
  private readonly hosts = new Map<string, ConnectedHost>()

  public constructor(private readonly ports: RemoteHostServicePorts) {}

  /** 按配置拉起全部启用的主机。已存在的连接不会被重复点火。 */
  public async start(definitions: readonly RemoteHostDefinition[]): Promise<void> {
    for (const definition of definitions) {
      if (!definition.enabled) continue
      await this.connectHost(definition).catch((error: unknown) => {
        // 单台连不上不该拖垮其余主机，更不该拖垮 Desktop 启动：远端离线是常态而非故障。
        log.warn('remote_host.connect_failed', {
          hostId: definition.id,
          error: AppError.getMessage(error),
        })
      })
    }
  }

  /**
   * 首次配对。
   *
   * 配对码只在这一次上线；成功后凭据落盘，之后每次连接都是 challenge 签名。
   */
  public async pair(
    definition: RemoteHostDefinition,
    pairingCode: string,
  ): Promise<void> {
    this.disconnectHost(definition.id)
    await this.connectHost(definition, pairingCode)
  }

  public disconnectHost(hostId: string): void {
    const host = this.hosts.get(hostId)
    if (!isPresent(host)) return
    host.dispose()
    host.client.dispose()
    this.hosts.delete(hostId)
    this.republish()
  }

  public dispose(): void {
    for (const hostId of [...this.hosts.keys()]) this.disconnectHost(hostId)
  }

  private async connectHost(
    definition: RemoteHostDefinition,
    pairingCode?: string,
  ): Promise<void> {
    const client = createRemoteNodeClient({
      url: definition.url,
      clientName: this.ports.clientName,
      credentials: this.ports.createCredentialStore(definition.id),
      pairingCode: toOptional(pairingCode),
    })
    const entry: ConnectedHost = {
      definition,
      client,
      manifest: null,
      dispose: () => undefined,
    }
    const unsubscribeManifest = client.onManifestChanged((manifest) => {
      entry.manifest = manifest
      this.republish()
    })
    const unsubscribeStopped = client.onStopped((error) => {
      // 停机是终态（协议不符 / 未授权 / 被顶替），重连无用——摘掉工具面，别让模型继续看见
      // 一批注定失败的工具。
      log.warn('remote_host.stopped', {
        hostId: definition.id,
        code: error.code,
      })
      this.disconnectHost(definition.id)
    })
    entry.dispose = () => {
      unsubscribeManifest()
      unsubscribeStopped()
    }
    this.hosts.set(definition.id, entry)

    const session = await client.connect()
    entry.manifest = session.manifest
    this.republish()
  }

  private republish(): void {
    const entries: RemoteHostToolEntry[] = []
    for (const host of this.hosts.values()) {
      if (!isPresent(host.manifest)) continue
      const invoker = createInvoker(host.client)
      for (const descriptor of host.manifest.tools) {
        const canonicalName = buildRemoteToolName(host.definition.id, descriptor.name)
        entries.push({
          name: canonicalName,
          // 全部落本 mod 自己的类别,**不沿用节点侧的类别**。两个理由:一是混进本机类别会让
          // 「授权系统命令执行」这类会话决定同时覆盖本机与远端,而它们的风险完全不同;二是
          // 本地类别可能带着仅适用于本地 capability 的可用性探针,
          // 远端明明有的能力会因为本机没装而凭空消失。
          categoryId: RemoteHostToolCategoryId,
          tool: remoteHostToolFactory.create({
            canonicalName,
            categoryId: RemoteHostToolCategoryId,
            hostLabel: host.definition.label,
            descriptor,
            invoker,
          }),
        })
      }
    }
    this.ports.publishTools(entries)
  }
}

