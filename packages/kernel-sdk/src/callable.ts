import type { ScopeRef } from './references.js'

export interface KernelCapabilityOperationContext {
  readonly operation: string
  readonly scope?: ScopeRef
  readonly input: unknown
}

export type KernelCapabilityOperationReason =
  | string
  | ((context: KernelCapabilityOperationContext) => string)

/** Permission policy declared by one callable capability operation. */
export interface KernelCapabilityOperationMetadata {
  readonly permissions: readonly string[]
  readonly reason?: KernelCapabilityOperationReason
}

export interface KernelCallableCapabilityOperation {
  readonly metadata: KernelCapabilityOperationMetadata
  invoke(
    scope: ScopeRef | undefined,
    input: unknown,
    signal: AbortSignal,
  ): unknown | Promise<unknown>
}

/**
 * Product-neutral call surface used by the Kernel service boundary.
 *
 * The service resolves operation metadata before requesting permissions.
 * Returning `undefined` therefore denies unknown operations before invocation.
 */
export interface KernelCallableCapabilityService {
  getOperationMetadata(
    operation: string,
  ): KernelCapabilityOperationMetadata | undefined
  invoke(
    operation: string,
    scope: ScopeRef | undefined,
    input: unknown,
    signal: AbortSignal,
  ): unknown | Promise<unknown>
}

export class UnknownKernelCapabilityOperationError extends Error {
  public constructor() {
    super('Kernel capability operation is not available')
    this.name = 'UnknownKernelCapabilityOperationError'
  }
}

function normalizeMetadata(
  operation: string,
  metadata: KernelCapabilityOperationMetadata,
): KernelCapabilityOperationMetadata {
  const permissions = [...metadata.permissions]
  if (permissions.some((permission) => permission.trim().length === 0)) {
    throw new Error(
      `Callable capability operation "${operation}" declares an empty permission`,
    )
  }
  if (new Set(permissions).size !== permissions.length) {
    throw new Error(
      `Callable capability operation "${operation}" declares duplicate permissions`,
    )
  }

  return Object.freeze({
    permissions: Object.freeze(permissions),
    ...(metadata.reason === undefined ? {} : { reason: metadata.reason }),
  })
}

/**
 * Builds a closed operation table. Only own, statically declared operations can
 * be invoked; inherited properties and unknown strings fail closed.
 */
export function createKernelCallableCapability(
  operations: Readonly<Record<string, KernelCallableCapabilityOperation>>,
): KernelCallableCapabilityService {
  const operationTable = new Map<
    string,
    {
      readonly metadata: KernelCapabilityOperationMetadata
      readonly invoke: KernelCallableCapabilityOperation['invoke']
    }
  >()

  for (const [operation, definition] of Object.entries(operations)) {
    if (operation.trim().length === 0) {
      throw new Error('Callable capability operation name must not be empty')
    }
    operationTable.set(
      operation,
      Object.freeze({
        metadata: normalizeMetadata(operation, definition.metadata),
        invoke: definition.invoke,
      }),
    )
  }

  return Object.freeze({
    getOperationMetadata(
      operation: string,
    ): KernelCapabilityOperationMetadata | undefined {
      return operationTable.get(operation)?.metadata
    },
    invoke(
      operation: string,
      scope: ScopeRef | undefined,
      input: unknown,
      signal: AbortSignal,
    ): unknown | Promise<unknown> {
      const definition = operationTable.get(operation)
      if (definition === undefined) {
        throw new UnknownKernelCapabilityOperationError()
      }
      if (signal.aborted) {
        throw new DOMException('Capability invocation aborted', 'AbortError')
      }
      return definition.invoke(scope, input, signal)
    },
  })
}

export function isKernelCallableCapabilityService(
  value: unknown,
): value is KernelCallableCapabilityService {
  return (
    typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'getOperationMetadata') === 'function'
    && typeof Reflect.get(value, 'invoke') === 'function'
  )
}

export function resolveKernelCapabilityOperationReason(
  metadata: KernelCapabilityOperationMetadata,
  context: KernelCapabilityOperationContext,
): string | undefined {
  return typeof metadata.reason === 'function'
    ? metadata.reason(context)
    : metadata.reason
}
