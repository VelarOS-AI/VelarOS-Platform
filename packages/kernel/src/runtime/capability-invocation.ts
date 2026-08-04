import { isUndefined } from '@velaros-ai/core'

import {
  isKernelCallableCapabilityService,
  type KernelCapabilityOperationMetadata,
  type KernelModulePermissionRequest,
  type KernelPermissionDecision,
  resolveKernelCapabilityOperationReason,
  type ScopeRef,
  UnknownKernelCapabilityOperationError,
} from '../contracts/abi'

import type { KernelModuleHost } from './host'

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
}

/** A requested capability has no active provider in this Kernel instance. */
export class KernelCapabilityUnavailableError extends Error {
  public constructor(
    public readonly capabilityId: string,
    options?: ErrorOptions,
  ) {
    super(`Kernel capability "${capabilityId}" has no active provider`, options)
    this.name = 'KernelCapabilityUnavailableError'
  }
}

/** The active capability does not implement the standard callable contract. */
export class KernelCapabilityNotCallableError extends Error {
  public constructor(public readonly capabilityId: string) {
    super(`Kernel capability "${capabilityId}" is not callable`)
    this.name = 'KernelCapabilityNotCallableError'
  }
}

/** Provider code failed while describing an operation. */
export class KernelCapabilityOperationMetadataError extends Error {
  public constructor(
    public readonly capabilityId: string,
    public readonly operation: string,
    options?: ErrorOptions,
  ) {
    super('Kernel capability operation metadata could not be resolved', options)
    this.name = 'KernelCapabilityOperationMetadataError'
  }
}

/** The host permission authority explicitly denied a capability operation. */
export class KernelCapabilityPermissionDeniedError extends Error {
  public constructor(
    public readonly capabilityId: string,
    public readonly operation: string,
    public readonly permission: string,
    public readonly reason: string,
  ) {
    super(reason)
    this.name = 'KernelCapabilityPermissionDeniedError'
  }
}

/** The permission policy failed before it could make a decision. */
export class KernelCapabilityPermissionCheckError extends Error {
  public constructor(
    public readonly capabilityId: string,
    public readonly operation: string,
    options?: ErrorOptions,
  ) {
    super('Kernel capability permission could not be resolved', options)
    this.name = 'KernelCapabilityPermissionCheckError'
  }
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
      throw new KernelCapabilityUnavailableError(call.capabilityId)
    }

    let service: object | undefined
    try {
      service = this.host.getOptionalService(token)
    } catch (error) {
      throw new KernelCapabilityUnavailableError(
        call.capabilityId,
        { cause: error },
      )
    }
    if (isUndefined(service)) {
      throw new KernelCapabilityUnavailableError(call.capabilityId)
    }
    if (!isKernelCallableCapabilityService(service)) {
      throw new KernelCapabilityNotCallableError(call.capabilityId)
    }

    let metadata: KernelCapabilityOperationMetadata | undefined
    try {
      metadata = service.getOperationMetadata(call.operation)
    } catch (error) {
      throw new KernelCapabilityOperationMetadataError(
        call.capabilityId,
        call.operation,
        { cause: error },
      )
    }
    if (isUndefined(metadata)) {
      throw new UnknownKernelCapabilityOperationError()
    }

    let reason: string | undefined
    try {
      reason = resolveKernelCapabilityOperationReason(metadata, {
        operation: call.operation,
        ...(isUndefined(call.scope) ? {} : { scope: call.scope }),
        input: call.input,
      })
    } catch (error) {
      throw new KernelCapabilityPermissionCheckError(
        call.capabilityId,
        call.operation,
        { cause: error },
      )
    }

    for (const permission of metadata.permissions) {
      let decision: KernelPermissionDecision
      try {
        decision = await this.host.requestCapabilityPermission(token, {
          permission,
          reason: call.permissionContext?.reason
            ?? reason
            ?? `Invoke "${call.operation}" on capability "${call.capabilityId}".`,
          ...(isUndefined(call.permissionContext?.resource)
            ? {}
            : { resource: call.permissionContext.resource }),
          ...(isUndefined(call.permissionContext?.details)
            ? {}
            : { details: call.permissionContext.details }),
          ...(isUndefined(call.scope) ? {} : { scope: call.scope }),
        })
      } catch (error) {
        throw new KernelCapabilityPermissionCheckError(
          call.capabilityId,
          call.operation,
          { cause: error },
        )
      }
      if (decision.status === 'denied') {
        throw new KernelCapabilityPermissionDeniedError(
          call.capabilityId,
          call.operation,
          permission,
          decision.reason,
        )
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
