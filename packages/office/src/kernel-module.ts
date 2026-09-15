import { createToolCallableOperations } from '@velaros-ai/agent/tool-contract'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
  type ScopeRef,
} from '@velaros-ai/kernel/contracts/abi'

import { officeTools } from './Collection'
import type { OfficeToolContext } from './officeShared'

export type OfficeToolContextResolver = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => OfficeToolContext | Promise<OfficeToolContext>

export interface CreateOfficeKernelModuleOptions {
  /** Product composition supplies its existing scope-bound office context. */
  resolveContext?: OfficeToolContextResolver
}

export interface OfficeCapabilityService
  extends KernelCallableCapabilityService {
  readonly tools: Readonly<typeof officeTools>
}

/** Typed service identity for the host-injected office tool collection. */
export const OfficeCapability =
  createCapabilityToken<OfficeCapabilityService>('velaros.office')

/** Registers a read-only and optionally callable office tool collection. */
export function createOfficeKernelModule(
  options: CreateOfficeKernelModuleOptions = {},
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.office',
      version: '0.2.7',
      apiVersion: KernelModuleApiVersion,
      provides: [OfficeCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['fs:read', 'fs:write', 'process:exec'],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(
        createToolCallableOperations(officeTools, options.resolveContext, { label: '办公' }),
      )
      const service: OfficeCapabilityService = Object.freeze({
        ...callable,
        tools: Object.freeze({ ...officeTools }),
      })
      context.registerService(OfficeCapability, service)
    },
  })
}
