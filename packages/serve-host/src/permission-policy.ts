import type {
  KernelPermissionBroker,
  KernelPermissionDecision,
  KernelPermissionRequest,
} from '@velaros-ai/core/kernel/abi'

import type { VelarHostConfigStore } from './config'

/**
 * Host policy authority: every grant is derived from the persisted, explicit
 * capability switches. Unknown modules and permissions remain denied so newly
 * added code cannot broaden the product silently.
 */
export class VelarHostPermissionBroker implements KernelPermissionBroker {
  public constructor(private readonly config: VelarHostConfigStore) {}

  public request(request: KernelPermissionRequest): Promise<KernelPermissionDecision> {
    const capabilities = this.config.snapshot().value.capabilities
    const granted = request.moduleId === 'velaros.project'
      ? this.projectPermissionGranted(request.permission, capabilities.project)
      : request.moduleId === 'velaros.office'
        ? this.officePermissionGranted(request.permission, capabilities.project)
        : request.moduleId === 'velaros.system'
          ? this.systemPermissionGranted(request.permission, capabilities.system)
      : request.moduleId === 'velaros.computer.sidecar'
        ? this.computerPermissionGranted(request.permission, capabilities.computer)
        : false
    if (granted) return Promise.resolve({
        status: 'granted',
        grantId: `host:${request.moduleId}:${request.permission}`,
      })
    return Promise.resolve({
      status: 'denied',
      reason: `Velar Host policy denies "${request.permission}" for "${request.moduleId}"`,
    })
  }

  private projectPermissionGranted(
    permission: string,
    policy: { read: boolean; write: boolean; execute: boolean },
  ): boolean {
    switch (permission) {
      case 'fs:read':
        return policy.read
      case 'fs:write':
        return policy.write
      case 'process:exec':
        return policy.execute
      default:
        return false
    }
  }

  private computerPermissionGranted(
    permission: string,
    policy: { observe: boolean; control: boolean },
  ): boolean {
    if (permission === 'process:exec' || permission === 'screen:capture') return policy.observe
    if (permission === 'input:control') return policy.control
    return false
  }

  private officePermissionGranted(
    permission: string,
    policy: { read: boolean; write: boolean },
  ): boolean {
    switch (permission) {
      case 'fs:read':
        return policy.read
      case 'fs:write':
      case 'process:exec':
        return policy.write
      default:
        return false
    }
  }

  private systemPermissionGranted(
    permission: string,
    policy: { observe: boolean; read: boolean; write: boolean; execute: boolean },
  ): boolean {
    switch (permission) {
      case 'fs:read':
        return policy.read
      case 'fs:write':
        return policy.write
      case 'process:exec':
      case 'system:open':
        return policy.execute
      default:
        return false
    }
  }
}
