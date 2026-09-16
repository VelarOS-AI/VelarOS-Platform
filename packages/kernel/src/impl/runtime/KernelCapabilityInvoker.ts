import { isUndefined } from '@velaros-ai/core'

import type { KernelCapabilityOperationMetadata } from '../../types/abi-callable'
import type {
  KernelModulePermissionRequest,
  KernelPermissionDecision,
} from '../../types/abi-permissions'
import type { ScopeRef } from '../../types/abi-references'
import {
  capabilityNotCallableFailure,
  capabilityUnavailableFailure,
  operationMetadataFailure,
  permissionCheckFailure,
  permissionDeniedFailure,
  unknownOperationFailure,
} from '../../utils/errors'
import { isKernelCallableCapabilityService, resolveKernelCapabilityOperationReason } from '../../utils/runtime/callable'

import type { KernelModuleHost } from './KernelModuleHost'

export interface KernelCapabilityCall {
  readonly capabilityId: string
  readonly operation: string
  readonly scope?: ScopeRef
  readonly input: unknown
  readonly signal: AbortSignal
  /** Trusted host facts forwarded to the permission authority for policy/audit. */
  readonly permissionContext?: Omit<
    KernelModulePermissionRequest,
    'permission' | 'scope'
  >
  /**
   * 调用方归属：这次调用是「代谁」发起的，只有宿主给得出。
   *
   * `moduleId` 是能力的**提供方**，回答不了「授权账本该记在谁头上」：mod A 调模块 B 提供的
   * 能力时，授权会记到 B 名下，之后每个调 B 的 mod 都被静默放行。宿主认得出调用方时把它写在
   * 这里，调用器原样交给宿主的授权判定。模块自己永远填不了这一项。
   */
  readonly attribution?: { readonly callerModuleId: string }
}

/**
 * The single successful capability-call path shared by embedded and serve
 * deployments. Transport faces may project errors differently, but they do not
 * resolve providers, interpret metadata, or apply permission policy again.
 */
export class KernelCapabilityInvoker {
  public constructor(private readonly host: KernelModuleHost) {}

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
              ?? `Invoke "${call.operation}" on capability "${call.capabilityId}".`,
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
