import type { ScopeRef } from './abi-references.js'

/** 一次能力调用的上下文：算权限理由时可以按它变文案。 */
export interface KernelCapabilityOperationContext {
  readonly operation: string
  readonly scope?: ScopeRef
  readonly input: unknown
}

/** 权限理由：常量串，或按本次调用算出来的一句话。 */
export type KernelCapabilityOperationReason =
  | string
  | ((context: KernelCapabilityOperationContext) => string)

/** 一条可调用操作声明的权限策略。 */
export interface KernelCapabilityOperationMetadata {
  readonly permissions: readonly string[]
  readonly reason?: KernelCapabilityOperationReason
}

/** 一条可调用操作：权限声明加它自己的执行体。 */
export interface KernelCallableCapabilityOperation {
  readonly metadata: KernelCapabilityOperationMetadata
  invoke(
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal,
  ): unknown | Promise<unknown>
}

/**
 * 内核服务边界认的可调用面。
 *
 * 服务面先取操作元数据再求权限，所以 `getOperationMetadata` 返回 undefined 就等于
 * 「在求权限之前拒绝这个未知操作」。
 */
export interface KernelCallableCapabilityService {
  getOperationMetadata(
    operation: string,
  ): KernelCapabilityOperationMetadata | undefined
  invoke(
    operation: string,
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal,
  ): unknown | Promise<unknown>
}
