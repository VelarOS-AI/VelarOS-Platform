/**
 * Sidecar pack entries: capability catalog in Kernel, implementation on product HostBridge.
 */
import {
  createCapabilityToken,
  defineKernelModule,
} from '../packages/kernel-sdk/dist/index.js'

function sidecarPack(options) {
  const token = createCapabilityToken(options.capabilityId)
  return defineKernelModule({
    manifest: {
      id: options.moduleId,
      version: options.version,
      apiVersion: 1,
      provides: [token],
      requires: [],
      optionalRequires: [],
      permissions: options.permissions ?? [],
      isolation: 'sidecar',
    },
    activate() {
      throw new Error(
        `Sidecar module "${options.moduleId}" must be activated by HostBridge adapter`,
      )
    },
  })
}

export function createAgentSidecarPack() {
  return sidecarPack({
    moduleId: 'velaros.agent.sidecar',
    version: '0.3.2',
    capabilityId: 'velaros.agent',
    permissions: ['agent:execute'],
  })
}

export function createModelSidecarPack() {
  return sidecarPack({
    moduleId: 'velaros.model.sidecar',
    version: '0.3.0',
    capabilityId: 'velaros.model',
  })
}

export function createBrowserSidecarPack() {
  return sidecarPack({
    moduleId: 'velaros.browser.sidecar',
    version: '0.3.0',
    capabilityId: 'velaros.browser',
    permissions: ['browser:control'],
  })
}
