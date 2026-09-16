import { isUndefined } from '@velaros-ai/core'

import type { KernelCapabilityOperationMetadata } from '../../contract/requires'
import type { KernelPermissionDecision } from '../../types/kernel.js'
import type { KernelCapabilityCall } from '../../types/runtime'
import {
  capabilityNotCallableFailure,
  capabilityUnavailableFailure,
  operationMetadataFailure,
  permissionCheckFailure,
  permissionDeniedFailure,
  unknownOperationFailure,
} from '../../utils/errors'
import { isKernelCallableCapabilityService, resolveKernelCapabilityOperationReason } from '../../utils/runtime/callable'

import type { KernelModuleHostApi } from './KernelModuleHost'

/**
 * 进程内与 serve 两种部署共用的**唯一**一条成功调用路径。
 *
 * 传输面可以把错误投影成自己的形状，但不再解析提供方、不再解释元数据、也不再重做一遍权限判定。
 * 实例由 `Kernel` 与 `KernelService` 各持一份。
 */
export interface KernelCapabilityInvokerApi {
  /**
   * 过权限门调一次能力。
   *
   * 顺序是定死的：解析活动提供方 → 认可调用面 → 取操作元数据（未知操作在此失败）→ 算权限理由
   * → 逐条判权限 → 才进 provider 代码。任一步失败都抛带码的 `KernelError`。
   */
  invoke(call: KernelCapabilityCall): Promise<unknown>
}

export class KernelCapabilityInvoker implements KernelCapabilityInvokerApi {
  public constructor(private readonly host: KernelModuleHostApi) {}

  public async invoke(call: KernelCapabilityCall): Promise<unknown> {
    const token = this.host.getActiveCapabilityToken(call.capabilityId)
    if (isUndefined(token)) {
      throw capabilityUnavailableFailure(call.capabilityId)
    }

    let service: object | undefined
    try {
      service = this.host.getOptionalService(token)
    } catch (error) {
      throw capabilityUnavailableFailure(call.capabilityId, { cause: error })
    }
    if (isUndefined(service)) {
      throw capabilityUnavailableFailure(call.capabilityId)
    }
    if (!isKernelCallableCapabilityService(service)) {
      throw capabilityNotCallableFailure(call.capabilityId)
    }

    let metadata: KernelCapabilityOperationMetadata | undefined
    try {
      metadata = service.getOperationMetadata(call.operation)
    } catch (error) {
      throw operationMetadataFailure(
        call.capabilityId,
        call.operation,
        { cause: error },
      )
    }
    if (isUndefined(metadata)) {
      throw unknownOperationFailure(call.capabilityId, call.operation)
    }

    let reason: string | undefined
    try {
      reason = resolveKernelCapabilityOperationReason(metadata, {
        operation: call.operation,
        scope: call.scope,
        input: call.input,
      })
    } catch (error) {
      throw permissionCheckFailure(
        call.capabilityId,
        call.operation,
        { cause: error },
      )
    }

    for (const permission of metadata.permissions) {
      let decision: KernelPermissionDecision
      try {
        decision = await this.host.requestCapabilityPermission(
          token,
          {
            permission,
            reason: call.permissionContext?.reason
              ?? reason
              ?? `调用能力 "${call.capabilityId}" 的操作 "${call.operation}"。`,
            resource: call.permissionContext?.resource,
            details: call.permissionContext?.details,
            scope: call.scope,
          },
          call.attribution,
        )
      } catch (error) {
        throw permissionCheckFailure(
          call.capabilityId,
          call.operation,
          { cause: error },
        )
      }
      if (decision.status === 'denied') {
        throw permissionDeniedFailure({
          capabilityId: call.capabilityId,
          operation: call.operation,
          permission,
          reason: decision.reason,
        })
      }
    }

    return service.invoke(
      call.operation,
      call.scope,
      call.input,
      call.signal,
    )
  }
}
