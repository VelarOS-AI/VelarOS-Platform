export type KernelUpdaterErrorCode =
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_SIZE_MISMATCH'
  | 'DIGEST_MISMATCH'
  | 'DOWNLOAD_FAILED'
  | 'HEALTH_CHECK_FAILED'
  | 'INSTALL_FAILED'
  | 'INVALID_MANIFEST'
  | 'INVALID_POINTER'
  | 'INVALID_VERSION'
  | 'INVALID_VERSION_RANGE'
  | 'MANIFEST_UNREACHABLE'
  | 'NO_ROLLBACK_TARGET'
  | 'SIGNATURE_REJECTED'
  | 'UNSUPPORTED_TARGET'
  | 'UPDATE_LOCK_HELD'
  | 'VERSION_NOT_INSTALLED'
  | 'VERSION_UNAVAILABLE'

export interface KernelUpdaterErrorDetails {
  readonly actual?: string
  readonly expected?: string
  readonly ownerPid?: number
  readonly path?: string
  readonly previousVersion?: string
  readonly target?: string
  readonly url?: string
  readonly version?: string
  readonly versionRange?: string
}

export class KernelUpdaterError extends Error {
  public readonly code: KernelUpdaterErrorCode
  public readonly details: KernelUpdaterErrorDetails

  public constructor(
    code: KernelUpdaterErrorCode,
    message: string,
    details: KernelUpdaterErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'KernelUpdaterError'
    this.code = code
    this.details = details
  }
}

/** Cross-process update contention; never raised for a corrupted install. */
export class KernelUpdateLockError extends KernelUpdaterError {
  public constructor(
    message: string,
    details: KernelUpdaterErrorDetails = {},
  ) {
    super('UPDATE_LOCK_HELD', message, details)
    this.name = 'KernelUpdateLockError'
  }
}

export type KernelArtifactVerificationErrorCode =
  | 'ARTIFACT_SIZE_MISMATCH'
  | 'DIGEST_MISMATCH'
  | 'SIGNATURE_REJECTED'

export class KernelArtifactVerificationError extends KernelUpdaterError {
  public constructor(
    code: KernelArtifactVerificationErrorCode,
    message: string,
    details: KernelUpdaterErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(code, message, details, options)
    this.name = 'KernelArtifactVerificationError'
  }
}
