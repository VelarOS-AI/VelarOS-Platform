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

      const decision = await options.broker.request({
        ...request,
        moduleId: options.manifest.id,
        generation: options.generation,
      })
      options.assertActive()
      return decision
    },
  }
  return Object.freeze(scopedBroker)
}
