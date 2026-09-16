export type KernelHostErrorCode =
  | 'API_VERSION_MISMATCH'
  | 'CYCLIC_DEPENDENCY'
  | 'DUPLICATE_CAPABILITY'
  | 'DUPLICATE_MODULE'
  | 'DUPLICATE_SERVICE'
  | 'HOST_DISPOSED'
  | 'INVALID_MANIFEST'
  | 'INVALID_SERVICE'
  | 'INVALID_VERSION'
  | 'INVALID_VERSION_RANGE'
  | 'MISSING_CAPABILITY'
  | 'MISSING_ISOLATION_ADAPTER'
  | 'MISSING_SERVICE'
  | 'MODULE_STATE'
  | 'UNDECLARED_CAPABILITY_ACCESS'
  | 'UNDECLARED_CAPABILITY_PROVIDER'
  | 'VERSION_MISMATCH'

export interface KernelHostErrorDetails {
  readonly moduleId?: string
  readonly capabilityId?: string
  readonly relatedModuleIds?: readonly string[]
}

export class KernelHostError extends Error {
  public readonly code: KernelHostErrorCode
  public readonly details: KernelHostErrorDetails

  public constructor(
    code: KernelHostErrorCode,
    message: string,
    details: KernelHostErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'KernelHostError'
    this.code = code
    this.details = details
  }
}

export class KernelStartupError extends KernelHostError {
  public readonly phase: 'activate' | 'ready'
  public readonly rollbackErrors: readonly Error[]

  public constructor(options: {
    readonly moduleId: string
    readonly phase: 'activate' | 'ready'
    readonly cause: unknown
    readonly rollbackErrors: readonly Error[]
  }) {
    super(
      'MODULE_STATE',
      `Kernel module "${options.moduleId}" failed during ${options.phase}`,
      { moduleId: options.moduleId },
      { cause: options.cause },
    )
    this.name = 'KernelStartupError'
    this.phase = options.phase
    this.rollbackErrors = options.rollbackErrors
  }
}

export class KernelOperationError extends KernelHostError {
  public readonly operation: 'suspend' | 'dispose'
  public readonly failures: ReadonlyArray<{
    readonly moduleId: string
    readonly error: Error
  }>

  public constructor(
    operation: 'suspend' | 'dispose',
    failures: ReadonlyArray<{
      readonly moduleId: string
      readonly error: Error
    }>,
  ) {
    super(
      'MODULE_STATE',
      `Kernel ${operation} failed for ${failures.length} module(s)`,
      { relatedModuleIds: failures.map((failure) => failure.moduleId) },
    )
    this.name = 'KernelOperationError'
    this.operation = operation
    this.failures = failures
  }
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
