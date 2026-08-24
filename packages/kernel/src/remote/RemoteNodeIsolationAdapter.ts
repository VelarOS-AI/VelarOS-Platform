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
import {
  createCapabilityToken,
  createKernelCallableCapability,
  type KernelCallableCapabilityOperation,
  KernelCapabilityPermissionDeniedError,
  type KernelModuleActivateContext,
  type KernelModuleDefinition,
  type KernelModuleHealth,
  type KernelModuleIsolationAdapter,
  type KernelModuleLifecycle,
  type KernelRegistration,
  type ScopeRef,
} from '@velaros-ai/kernel'

import {
  RemoteNodeClientError,
  RemoteNodeClientErrorCodes,
} from './client/contracts'
import type { RemoteNodeClient } from './client/RemoteNodeClient'
import type { RemoteNodeCapabilityBinding } from './module-projection'

const log = Log.tag('RemoteNodeIsolation')

/** 远端长任务的进度事件类型;载荷带本地能力 id,订阅方不必再查映射。 */
export const RemoteNodeProgressEventType = 'remote-node.progress'

export interface RemoteNodeProgressEvent {
  readonly capabilityId: string
  readonly operation: string
  readonly event: unknown
}

export type RemoteNodeBindingResolver = (
  localCapabilityId: string,
) => LooseOptional<RemoteNodeCapabilityBinding>

export interface RemoteNodeIsolationAdapterOptions {
  readonly client: RemoteNodeClient
  /** 由 `createRemoteNodeProjection()` 提供;必须与注册进 Kernel 的那份投影同源。 */
  readonly resolveBinding: RemoteNodeBindingResolver
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
          `Remote capability "${token.id}" has no binding in the current node projection`,
        )
      }
      registrations.push(context.registerService(
        createCapabilityToken(token.id, token.version),
        createKernelCallableCapability(
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
      throw this.toKernelError(binding, operation, error)
    }
  }

  /**
   * 错误落位。
   *
   * `denied` 是 Node 侧派发后的策略事实,必须变成 Kernel 的权限拒绝——它会一路走到模型面前,
   * 而链路故障不该。其余一律保留 `RemoteNodeClientError` 原样上抛:它的 code / message /
   * retryable 与 Kernel wire 错误信封同构,`resultUnknown` 这一位也不能在转投中丢掉。
   */
  private toKernelError(
    binding: RemoteNodeCapabilityBinding,
    operation: string,
    error: unknown,
  ): unknown {
    if (!(error instanceof RemoteNodeClientError)) return error
    if (error.code !== RemoteNodeClientErrorCodes.CallDenied) return error

    const declared = binding.operations
      .find((descriptor) => descriptor.name === operation)
      ?.permissions.at(0)
    const nodeCode = error.nodeError?.code
    const permission = isNonBlankString(nodeCode)
      ? nodeCode
      : (declared ?? binding.remoteCapabilityId)
    return new KernelCapabilityPermissionDeniedError(
      binding.localCapabilityId,
      operation,
      permission,
      error.message,
    )
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
      message: 'Remote node connection is not ready',
      details: { state: client.connectionState },
    }
  }
}
