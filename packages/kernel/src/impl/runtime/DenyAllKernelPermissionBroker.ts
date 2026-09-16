import type {
  KernelPermissionDecision,
  KernelPermissionRequest,
} from '../../types/kernel.js'

/**
 * 宿主没注入权限策略时的安全默认：任何权限都不给。
 *
 * 由 `KernelModuleHost` 在宿主没给 `permissionBroker` 时自己 new 一份，别处不用。
 */
export interface KernelPermissionBroker {
  /** 判一次权限；这一份实现永远返回拒绝，理由里带上被拒的权限位。 */
  request(request: KernelPermissionRequest): Promise<KernelPermissionDecision>
}

export class DenyAllKernelPermissionBroker implements KernelPermissionBroker {
  public async request(
    request: KernelPermissionRequest,
  ): Promise<KernelPermissionDecision> {
    return {
      status: 'denied',
      reason: `权限 "${request.permission}" 被宿主的默认策略拒绝（本次装配没有注入权限裁决）`,
    }
  }
}
