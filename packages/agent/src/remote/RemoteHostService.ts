import { isPresent, Log, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  RemoteNodeManifest,
} from '@velaros-ai/kernel/contracts/protocol'
import {
  RemoteNodeClient,
  type RemoteNodeCredentialStore,
} from '@velaros-ai/kernel/remote/client'

import {
  type RemoteHostDefinition,
  RemoteHostToolCategoryId,
} from './contracts.js'
import { createRemoteHostTool, type RemoteHostToolInvoker } from './remote-tool.js'

const log = Log.tag('RemoteHostService')

/** 一条已投影好的工具贡献；宿主按结构注册,不需要认识本包的任何类型。 */
export interface RemoteHostToolEntry {
  readonly name: string
  readonly categoryId: string
  readonly tool: ReturnType<typeof createRemoteHostTool>
}

export interface RemoteHostServicePorts {
  /**
   * 工具面整批替换。
   *
   * 是 sink 而不是「拿 provider 再自己刷」:宿主的注册表形状(provider / 覆盖栈 / 类别门)
   * 属于宿主,本包不该认识它。宿主实现这一个方法即可,本包不持有任何宿主对象。
   */
  readonly publishTools: (entries: readonly RemoteHostToolEntry[]) => void
  readonly createCredentialStore: (hostId: string) => RemoteNodeCredentialStore
  readonly clientName: string
}

interface ConnectedHost {
  readonly definition: RemoteHostDefinition
  readonly client: RemoteNodeClient
  manifest: Nullable<RemoteNodeManifest>
  dispose: () => void
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
export class RemoteHostService {
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
    const client = new RemoteNodeClient({
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
          tool: createRemoteHostTool({
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

function createInvoker(client: RemoteNodeClient): RemoteHostToolInvoker {
  return {
    invoke: (descriptor, input, signal) =>
      client.invoke(
        {
          capabilityId: descriptor.capabilityId,
          operation: descriptor.operation,
          input,
        },
        signal,
      ),
  }
}

/**
 * 生成跨机唯一的 canonical 工具名。
 *
 * 形状对齐 MCP 的 `mcp.<server>:<tool>`：注册表要求 `namespace:tool`，且 namespace 允许点号。
 * 节点侧的名字可能自带冒号（如 `provider:operation`），必须压平，否则拼出来的是非法 id。
 */
function buildRemoteToolName(hostId: string, toolName: string): string {
  const namespace = slugify(hostId)
  const tool = toolName.toLowerCase().replaceAll(/[^a-z\d_-]/gu, '_')
  return `remote.${namespace}:${tool.replace(/^[^a-z]+/u, '')}`
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replaceAll(/[^a-z\d-]/gu, '-')
  return slug.replace(/^[^a-z]+/u, '') || 'host'
}
