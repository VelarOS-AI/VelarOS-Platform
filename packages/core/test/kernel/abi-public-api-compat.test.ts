import { expect, test } from 'bun:test'

import {
  type CapabilityToken,
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleActivateContext,
  type KernelModuleDefinition,
} from '../../src/kernel/abi'

test('kernel-sdk 0.2.x composition API remains source-compatible', () => {
  const token: CapabilityToken<KernelCallableCapabilityService> =
    createCapabilityToken<KernelCallableCapabilityService>('example.echo')
  const service = createKernelCallableCapability({
    echo: {
      metadata: { permissions: [] },
      invoke: (_scope, input) => input,
    },
  })
  const definition: KernelModuleDefinition = defineKernelModule({
    manifest: {
      id: 'example.module',
      version: '1.0.0',
      apiVersion: 1,
      provides: [token],
      requires: [],
      optionalRequires: [],
      permissions: [],
      isolation: 'in-process',
    },
    activate(context: KernelModuleActivateContext) {
      context.registerService(token, service)
    },
  })

  expect(token.id).toBe('example.echo')
  expect(definition.manifest.id).toBe('example.module')
  expect(service.getOperationMetadata('echo')).toEqual({ permissions: [] })
})
