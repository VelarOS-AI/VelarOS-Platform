import { isNotUndefined, isUndefined, toNullable } from '@velaros-ai/core'

import {
  type KernelCallErrorCode,
  KernelCallErrorCodes,
  type KernelClientErrorCode,
  type KernelErrorCode,
  KernelErrorCodes,
  type KernelUpdaterErrorCode,
  type RemoteNodeErrorCode,
} from '../contract/constants'
import type { KernelErrorDetails, KernelUpdaterErrorDetails } from '../types/runtime'

import type { RemoteNodeError } from './wire/remote-node'


/**
 * 内核侧的统一失败：模块宿主、能力调用、服务面、mod 目录都抛它。
 *
 * 错误类不出包，外面一律按 `code` 判断（`contract/constants.ts` 的 `KernelErrorCodes` 与
 * `KernelCallErrorCodes` 两张表）；`message` 只给人看，随时可能改写法。
 */
export class KernelError extends Error {
  /** 失败码；同一件事进程内与 wire 上是同一个码。 */
  public readonly code: KernelErrorCode | KernelCallErrorCode

  /** 补充事实：出事的模块、能力、操作、权限、拒绝原因等。 */
  public readonly details: KernelErrorDetails

  public constructor(
    code: KernelErrorCode | KernelCallErrorCode,
    message: string,
    details: KernelErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'KernelError'
    this.code = code
    this.details = details
  }
}

/**
 * 瘦客户端、启动器与本机 RPC 这条线上的失败。
 *
 * 带 `retryable`：调用方据此决定重试还是换条路；`guidance` 是给人看的下一步建议。
 */
export class KernelClientError extends Error {
  /** 失败码；见 `contract/constants.ts` 的 `KernelClientErrorCodes`。 */
  public readonly code: string

  /** 这次失败重试有没有意义。 */
  public readonly retryable: boolean

  /** 给人看的下一步建议；没有就缺席。 */
  public readonly guidance?: string

  /** 服务端回的失败信封原样；本地失败时缺席。 */
  public readonly rpcError?: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
    readonly details: Nullable<Readonly<Record<string, unknown>>>
  }

  public constructor(init: {
    readonly code: KernelClientErrorCode | string
    readonly message: string
    readonly retryable?: boolean
    readonly guidance?: string
    readonly rpcError?: {
      readonly code: string
      readonly message: string
      readonly retryable: boolean
      readonly details: Nullable<Readonly<Record<string, unknown>>>
    }
    readonly cause?: unknown
  }) {
    super(init.message, { cause: init.cause })
    this.name = 'KernelClientError'
    this.code = init.code
    this.retryable = !!(init.retryable ?? init.rpcError?.retryable)
    if (isNotUndefined(init.guidance)) this.guidance = init.guidance
    if (isNotUndefined(init.rpcError)) this.rpcError = init.rpcError
  }
}

/** 共享 Runtime 安装器的补充事实：算出来的值、期望值、路径、版本。 */

/**
 * 共享 Runtime 安装器这条线上的失败：取清单、校验、解包、落位、切指针、回滚。
 *
 * 更新锁被别人拿着、制品校验不过原来各有一个子类，现在都按码区分。
 */
export class KernelUpdaterError extends Error {
  /** 失败码；见 `contract/constants.ts` 的 `KernelUpdaterErrorCodes`。 */
  public readonly code: KernelUpdaterErrorCode

  /** 补充事实：期望与实际的摘要、锁的属主、路径、版本。 */
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

/**
 * 远程节点 Client 侧的失败。
 *
 * 字段四元组（code / retryable / resultUnknown / nodeError）与 wire 错误信封同构，
 * 上层可以原样转投；`resultUnknown` 为真表示调用已上过线但拿不到终态，重试可能造成第二次副作用。
 */
export class RemoteNodeClientError extends Error {
  /** 失败码；见 `contract/constants.ts` 的 `RemoteNodeErrorCodes`。 */
  public readonly code: string

  /** 这次失败重试有没有意义。 */
  public readonly retryable: boolean

  /** 调用已上过线但拿不到终态：重试可能造成第二次副作用。 */
  public readonly resultUnknown: boolean

  /** Node 侧回的失败信封原样；链路故障（还没上线）时是 null。 */
  public readonly nodeError: Nullable<RemoteNodeError>

  public constructor(init: {
    readonly code: RemoteNodeErrorCode | string
    readonly message: string
    readonly retryable: boolean
    readonly resultUnknown: boolean
    readonly nodeError?: LooseOptional<RemoteNodeError>
    readonly cause?: unknown
  }) {
    super(init.message, { cause: init.cause })
    this.name = 'RemoteNodeClientError'
    this.code = init.code
    this.retryable = init.retryable
    this.resultUnknown = init.resultUnknown
    this.nodeError = toNullable(init.nodeError)
  }
}

/** 把 wire 上的失败信封包成本地错误：码、文案与可重试性原样保留，信封本身挂在 `rpcError` 上。 */
export function fromKernelRpcError(rpcError: {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details: Nullable<Readonly<Record<string, unknown>>>
}): KernelClientError {
  return new KernelClientError({
    code: rpcError.code,
    message: rpcError.message,
    retryable: rpcError.retryable,
    rpcError,
  })
}

/** 不是 Error 的抛出物包成 Error，保住堆栈与 message 的最低约定。 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 能力上没有这个操作：在求权限之前就拒绝。
 *
 * 码是 OPERATION_NOT_FOUND；外面按码判断，不要按文字判断。
 */
export function unknownOperationFailure(
  capabilityId?: string,
  operation?: string,
): KernelError {
  return new KernelError(
    KernelCallErrorCodes.operationNotFound,
    isUndefined(capabilityId) || isUndefined(operation)
      ? '该 Kernel 能力没有登记这个操作，已在求权限之前拒绝。'
      : `Kernel 能力 "${capabilityId}" 没有登记操作 "${operation}"，已在求权限之前拒绝。`,
    { capabilityId, operation },
  )
}

/**
 * 能力在这个内核上没有活动的提供方；码 CAPABILITY_NOT_FOUND。
 *
 * 用 `CAPABILITY_NOT_FOUND` 而不是 `CAPABILITY_NOT_AVAILABLE`，是为了与 wire 上这条路径
 * 一直用的码保持一致（两个码语义上分不开、内核自己都用混了，合并成一个是收口那一轮的事）。
 */
export function capabilityUnavailableFailure(
  capabilityId: string,
  options?: ErrorOptions,
): KernelError {
  return new KernelError(
    KernelCallErrorCodes.capabilityNotFound,
    `Kernel 能力 "${capabilityId}" 当前没有活动的提供方`,
    { capabilityId },
    options,
  )
}

/** 能力的服务没有实现可调用约定；码 CAPABILITY_NOT_CALLABLE。 */
export function capabilityNotCallableFailure(capabilityId: string): KernelError {
  return new KernelError(
    KernelCallErrorCodes.capabilityNotCallable,
    `Kernel 能力 "${capabilityId}" 不是可调用能力`,
    { capabilityId },
  )
}

/** provider 描述操作元数据时抛错；码 OPERATION_METADATA_FAILED。 */
export function operationMetadataFailure(
  capabilityId: string,
  operation: string,
  options?: ErrorOptions,
): KernelError {
  return new KernelError(
    KernelCallErrorCodes.operationMetadataFailed,
    '取不到 Kernel 能力的操作元数据',
    { capabilityId, operation },
    options,
  )
}

/** 宿主的授权判定明确拒绝；码 PERMISSION_DENIED，拒绝原因在 `details.reason`。 */
export function permissionDeniedFailure(input: {
  readonly capabilityId: string
  readonly operation: string
  readonly permission: string
  readonly reason: string
}): KernelError {
  return new KernelError(
    KernelCallErrorCodes.permissionDenied,
    input.reason,
    input,
  )
}

/** 授权判定自己出错，没能给出结论；码 PERMISSION_CHECK_FAILED。 */
export function permissionCheckFailure(
  capabilityId: string,
  operation: string,
  options?: ErrorOptions,
): KernelError {
  return new KernelError(
    KernelCallErrorCodes.permissionCheckFailed,
    '判不出 Kernel 能力调用的授权结果',
    { capabilityId, operation },
    options,
  )
}

/** 模块在 activate / ready 阶段失败：带上阶段与回滚时的次生错误，码统一是 MODULE_STATE。 */
export function startupFailure(input: {
  readonly moduleId: string
  readonly phase: 'activate' | 'ready'
  readonly cause: unknown
  readonly rollbackErrors: readonly Error[]
}): KernelError {
  return new KernelError(
    KernelErrorCodes.moduleState,
    `内核模块 "${input.moduleId}" 在 ${input.phase} 阶段失败`,
    {
      moduleId: input.moduleId,
      phase: input.phase,
      rollbackErrors: input.rollbackErrors,
    },
    { cause: input.cause },
  )
}

/** 批量挂起或释放时有模块失败：逐个列出是谁失败的，码统一是 MODULE_STATE。 */
export function lifecycleFailure(
  operationKind: 'suspend' | 'dispose',
  failures: ReadonlyArray<{ readonly moduleId: string; readonly error: Error }>,
): KernelError {
  return new KernelError(
    KernelErrorCodes.moduleState,
    `内核 ${operationKind} 有 ${failures.length} 个模块失败`,
    {
      operationKind,
      failures,
      relatedModuleIds: failures.map((failure) => failure.moduleId),
    },
  )
}

/** 服务面还没启动（或已经启动失败）：码 KERNEL_NOT_STARTED，这是可重试的状态。 */
export function notStartedFailure(): KernelError {
  return new KernelError(
    KernelErrorCodes.kernelNotStarted,
    'Kernel 服务面还没启动',
  )
}

/** 之前已经启动失败过：码 KERNEL_START_FAILED，不是可重试的状态，要换一个新的 host / service。 */
export function startFailedFailure(cause: unknown): KernelError {
  return new KernelError(
    KernelErrorCodes.kernelStartFailed,
    'Kernel 服务面已经启动失败过，不会重试；请重建 Kernel 再启动',
    {},
    { cause },
  )
}

export type { KernelErrorDetails, KernelUpdaterErrorDetails } from '../types/runtime'
