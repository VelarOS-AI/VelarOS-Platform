// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:`isolation: 'remote'` 的宿主注入适配器——远端能力在本机 Kernel 上的落点。
//
// ## 为什么调用要绕这一圈
// 工具直接连 socket 也能把活干成,但那样权限闸就落在了 Windows 那一侧:Mac 上的 broker
// 根本不知道有人在远程截屏、装软件。这里把 Node 声明的权限位原样搬进 operation metadata,
// Kernel 的调用路径就会在**帧离开本机之前**逐权限判定。跨机链路上,这是唯一还站得住的闸。
//
// ## 与已退役的 sidecar adapter 的差别
// 形状同源(注册代理能力服务 + 把远端生命周期映射成 KernelModuleLifecycle),传输不同源:
// 那条是本机 unix socket、无认证、断了就完;这条是跨机 WebSocket,有配对签名、有重连、
// 有 epoch 判死。所以这里不做 `allowOfflineFallback` 那种"注册会抛的桩":远端不可达是常态,
// 由 client 排队与重连吸收,而不是把一张假的能力面留在 Kernel 里。
import { isNonBlankString, isNull, isPresent, Log } from '@velaros-ai/core'

import { RemoteNodeProgressEventType } from '../../contract/constants'
import type { KernelModuleActivateContext, KernelRegistration } from '../../contract/provides'
import type {
  KernelCallableCapabilityOperation,
  KernelModuleDefinition,
  KernelModuleIsolationAdapter,
  KernelModuleLifecycle,
} from '../../contract/requires'
import type { KernelModuleHealth, ScopeRef } from '../../types/kernel.js'
import type {
  RemoteNodeBindingResolver,
  RemoteNodeCapabilityBinding,
  RemoteNodeProgressEvent,
} from '../../types/remote'
import { toRemoteNodeKernelError } from '../../utils/remote/calls'
import { kernelModules } from '../runtime/KernelModuleKit'

import type { RemoteNodeClientApi } from './RemoteNodeClient'

const log = Log.tag('RemoteNodeIsolation')

/** 装配一个远程隔离适配器要的三样东西:连哪台机器、怎么找绑定、缺省给多久。 */
export interface RemoteNodeIsolationAdapterOptions {
  /** 这台远端主机的连接;一台主机一条,adapter 与它一一对应,混用会把调用发到另一台机器。 */
  readonly client: RemoteNodeClientApi
  /** 由 `createRemoteNodeProjection()` 提供;必须与注册进 Kernel 的那份投影同源。 */
  readonly resolveBinding: RemoteNodeBindingResolver
  /** 每次调用的缺省截止时长(毫秒);缺席时回落到客户端调用簿自己的缺省值。 */
  readonly defaultDeadlineMs?: number
}

/**
 * 把 `isolation: 'remote'` 模块接到一条 `RemoteNodeClient` 上。
 *
 * 一台远端主机一个实例:client 与 binding 解析都是按主机绑定的,混用会把调用发到另一台机器。
 */
export class RemoteNodeIsolationAdapter implements KernelModuleIsolationAdapter {
  public readonly isolation = 'remote' as const

  public constructor(
    private readonly options: RemoteNodeIsolationAdapterOptions,
  ) {}

  public activate(
    module: KernelModuleDefinition,
    context: KernelModuleActivateContext,
  ): KernelModuleLifecycle {
    const registrations: KernelRegistration[] = []
    for (const token of module.manifest.provides) {
      const binding = this.options.resolveBinding(token.id)
      if (!isPresent(binding)) {
        // 投影与注册面对不上:继续下去只会注册一张调不通的能力面,不如当场停。
        throw new Error(
          `当前的节点投影里没有远程能力 "${token.id}" 的绑定`,
        )
      }
      registrations.push(context.registerService(
        kernelModules.token(token.id, token.version),
        kernelModules.callable(
          this.buildOperationTable(binding, context),
        ),
      ))
    }

    return {
      dispose: () => {
        // 只拆本模块的注册。client 由装配方拥有并在多个远端模块间共享,不能在这里关掉。
        for (const registration of registrations) registration.dispose()
      },
      health: () => this.describeHealth(),
    }
  }

  private buildOperationTable(
    binding: RemoteNodeCapabilityBinding,
    context: KernelModuleActivateContext,
  ): Record<string, KernelCallableCapabilityOperation> {
    const nodeName = this.options.client.currentSession?.node.nodeName
    const hostLabel = isNonBlankString(nodeName) ? nodeName : 'the remote host'
    const table: Record<string, KernelCallableCapabilityOperation> = {}

    for (const operation of binding.operations) {
      table[operation.name] = {
        metadata: {
          // Node 声明什么就闸什么。去重是防御(重复声明会被 Kernel 判为非法元数据),
          // 空白权限位刻意不吞:那是 Node 侧的契约错误,让它在激活时炸出来。
          permissions: [...new Set(operation.permissions)],
          reason: `Run "${operation.name}" on ${hostLabel}.`,
        },
        invoke: (scope, input, signal) =>
          this.invokeRemote(binding, operation.name, scope, input, signal, context),
      }
    }
    return table
  }

  private async invokeRemote(
    binding: RemoteNodeCapabilityBinding,
    operation: string,
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal,
    context: KernelModuleActivateContext,
  ): Promise<unknown> {
    try {
      return await this.options.client.invoke(
        {
          capabilityId: binding.remoteCapabilityId,
          deadlineMs: this.options.defaultDeadlineMs,
          input,
          onProgress: (event) => {
            void context.events.publish<RemoteNodeProgressEvent>(
              RemoteNodeProgressEventType,
              { capabilityId: binding.localCapabilityId, event, operation },
            ).catch((error: unknown) => {
              log.warn('Remote node progress event could not be published', {
                capabilityId: binding.localCapabilityId,
                error,
                operation,
              })
            })
          },
          operation,
          scope,
        },
        signal,
      )
    } catch (error) {
      throw toRemoteNodeKernelError(binding, operation, error)
    }
  }

  private describeHealth(): KernelModuleHealth {
    const client = this.options.client
    const stopReason = client.stopReason
    if (!isNull(stopReason)) return {
        status: 'unhealthy',
        message: stopReason.message,
        details: { code: stopReason.code },
      }
    if (client.connectionState === 'ready') return { status: 'healthy', details: { state: client.connectionState } }
    return {
      status: 'degraded',
      message: '远程节点连接还没就绪',
      details: { state: client.connectionState },
    }
  }
}

/** 建一个远程隔离适配器;作为 `isolationAdapters` 注入内核,一台远端主机一个。 */
export function createRemoteNodeIsolationAdapter(
  options: RemoteNodeIsolationAdapterOptions,
): KernelModuleIsolationAdapter {
  return new RemoteNodeIsolationAdapter(options)
}
