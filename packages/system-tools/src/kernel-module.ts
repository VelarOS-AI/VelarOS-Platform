import { z } from 'zod'

import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityOperation,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
  type ScopeRef,
} from '@velaros-ai/core/kernel/abi'

import {
  systemExtensionTools,
  systemProjectTools,
  systemTools,
} from './Collection'
import type { SystemToolContext, VelaTool } from './Types'

export type SystemToolContextResolver = (
  scope: ScopeRef | undefined,
  signal: AbortSignal,
) => SystemToolContext | Promise<SystemToolContext>

export interface CreateSystemToolsKernelModuleOptions {
  /** Product composition supplies the existing scope-bound system context. */
  resolveContext?: SystemToolContextResolver
}

export interface SystemToolsCapabilityService
  extends KernelCallableCapabilityService {
  readonly tools: Readonly<typeof systemTools>
  readonly projectTools: Readonly<typeof systemProjectTools>
  readonly extensionTools: Readonly<typeof systemExtensionTools>
}

/** Typed service identity for host-injected system tool collections. */
export const SystemToolsCapability =
  createCapabilityToken<SystemToolsCapabilityService>('velaros.system.tools')

function parseToolInput(tool: VelaTool, input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('System capability input is invalid')
  }
  const schema = tool.schema instanceof z.ZodObject
    ? tool.schema.strict()
    : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new Error('System capability input is invalid')
  }
  return parsed.data
}

function createSystemCallableOperations(
  resolveContext: SystemToolContextResolver | undefined,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  if (resolveContext === undefined) return {}

  const operations: Record<string, KernelCallableCapabilityOperation> = {}
  const callableTools = {
    ...systemExtensionTools,
    ...systemTools,
  }
  for (const [fallbackName, candidate] of Object.entries(callableTools)) {
    const tool = candidate as VelaTool
    const operation = tool.name ?? fallbackName
    operations[operation] = {
      metadata: {
        permissions: [...new Set(tool.permissions)],
        reason: tool.capabilities?.reason
          ?? `Invoke system tool operation "${operation}".`,
      },
      async invoke(scope, input, signal) {
        const parsed = parseToolInput(tool, input)
        const resolvedContext = await resolveContext(scope, signal)
        const toolContext: SystemToolContext = {
          ...resolvedContext,
          abortSignal: signal,
        }
        if (tool.isAvailable?.(toolContext) === false) {
          throw new Error('System capability operation is unavailable')
        }
        signal.throwIfAborted()
        return tool.execute(parsed, toolContext)
      },
    }
  }
  return operations
}

/** Registers immutable views of the existing system tool collections. */
export function createSystemToolsKernelModule(
  options: CreateSystemToolsKernelModuleOptions = {},
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.system.tools',
      version: '0.2.7',
      apiVersion: 1,
      provides: [SystemToolsCapability],
      requires: [],
      optionalRequires: [],
      permissions: [
        'fs:read',
        'fs:write',
        'process:exec',
        'system:open',
      ],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(
        createSystemCallableOperations(options.resolveContext),
      )
      const service: SystemToolsCapabilityService = Object.freeze({
        ...callable,
        tools: Object.freeze({ ...systemTools }),
        projectTools: Object.freeze({ ...systemProjectTools }),
        extensionTools: Object.freeze({ ...systemExtensionTools }),
      })
      context.registerService(SystemToolsCapability, service)
    },
  })
}
