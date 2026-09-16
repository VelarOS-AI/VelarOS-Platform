import type {
  KernelModuleManifest,
  KernelModulePermissionBroker,
  KernelModulePermissionRequest,
  KernelPermissionBroker,
  KernelPermissionDecision,
  KernelPermissionRequest,
} from '../../contracts/abi'

/** Secure host default: no permission is granted without an injected policy. */
export class DenyAllKernelPermissionBroker implements KernelPermissionBroker {
  public async request(
    request: KernelPermissionRequest,
  ): Promise<KernelPermissionDecision> {
    return {
      status: 'denied',
      reason: `Permission "${request.permission}" is denied by the host default`,
    }
  }
}

export function createScopedPermissionBroker(options: {
  readonly manifest: KernelModuleManifest
  readonly generation: number
  readonly broker: KernelPermissionBroker
  readonly assertActive: () => void
}): KernelModulePermissionBroker {
  const scopedBroker: KernelModulePermissionBroker = {
    request: async (
      request: KernelModulePermissionRequest,
    ): Promise<KernelPermissionDecision> => {
      options.assertActive()
      if (!options.manifest.permissions.includes(request.permission)) return {
          status: 'denied',
          reason: `Module "${options.manifest.id}" did not declare permission "${request.permission}"`,
        }

      // 逐个字段抄写，不整体展开：`KernelPermissionRequest` 上的 `callerModuleId` 是宿主
      // 专用字段（`contracts/abi/permissions.ts`：模块永远不能指名自己以外的调用方）。
      // 原来的 `{ ...request }` 会把模块在 JS 里多塞的任何键原样带到宿主 broker，授权账本
      // 就按模块自称的调用方记。宿主路径（`KernelModuleHost.requestCapabilityPermission`）
      // 早已显式清空，这里补齐同一条闸。
      const decision = await options.broker.request({
        permission: request.permission,
        reason: request.reason,
        scope: request.scope,
        resource: request.resource,
        details: request.details,
        moduleId: options.manifest.id,
        generation: options.generation,
      })
      options.assertActive()
      return decision
    },
  }
  return Object.freeze(scopedBroker)
}
