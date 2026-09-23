// 可调用能力的纯判定：操作元数据的规范化、服务形状识别、权限理由求值。
//
// 这三件都用不到实例状态，所以不放在类里：宿主、服务面、隔离适配器都要用同一份口径。
import { isBlank, isFunction, isObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  KernelCallableCapabilityService,
  KernelCapabilityOperationContext,
  KernelCapabilityOperationMetadata,
} from '../../contract/requires'
/** 规范化一条操作的权限声明：空权限名与重复权限名当场拒绝，结果冻结。 */
export function normalizeKernelOperationMetadata(
  operation: string,
  metadata: KernelCapabilityOperationMetadata
): KernelCapabilityOperationMetadata {
  const permissions = [...metadata.permissions]
  if (permissions.some((permission) => isBlank(permission.trim()))) {
    throw new AppError('VALIDATION', `可调用能力的操作 "${operation}" 声明了空的权限名`)
  }
  if (new Set(permissions).size !== permissions.length) {
    throw new AppError('VALIDATION', `可调用能力的操作 "${operation}" 声明了重复的权限名`)
  }

  return Object.freeze({
    permissions: Object.freeze(permissions),
    reason: metadata.reason,
  })
}

/** 判断一个服务是不是可调用能力：只看形状，不看它从哪来。 */
export function isKernelCallableCapabilityService(
  value: unknown
): value is KernelCallableCapabilityService {
  return (
    isObject(value) &&
    isFunction(Reflect.get(value, 'getOperationMetadata')) &&
    isFunction(Reflect.get(value, 'invoke'))
  )
}

/** 求一条操作的权限理由：理由可以是常量串，也可以按这次调用的上下文算。 */
export function resolveKernelCapabilityOperationReason(
  metadata: KernelCapabilityOperationMetadata,
  context: KernelCapabilityOperationContext
): string | undefined {
  return isFunction(metadata.reason) ? metadata.reason(context) : metadata.reason
}
