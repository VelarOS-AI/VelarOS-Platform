import { z } from 'zod'

import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityOperation,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
  type ScopeRef,
} from '@velaros-ai/kernel-sdk'

import { officeTools } from './Collection'
import type { OfficeToolContext, VelaTool } from './officeShared'

export type OfficeToolContextResolver = (
  scope: ScopeRef | undefined,
  signal: AbortSignal,
) => OfficeToolContext | Promise<OfficeToolContext>

export interface CreateOfficeToolsKernelModuleOptions {
  /** Product composition supplies its existing scope-bound office context. */
  resolveContext?: OfficeToolContextResolver
}

export interface OfficeToolsCapabilityService
  extends KernelCallableCapabilityService {
  readonly tools: Readonly<typeof officeTools>
}

/** Typed service identity for the host-injected office tool collection. */
export const OfficeToolsCapability =
  createCapabilityToken<OfficeToolsCapabilityService>('velaros.office.tools')

function parseToolInput(tool: VelaTool, input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Office capability input is invalid')
  }
  const schema = tool.schema instanceof z.ZodObject
    ? tool.schema.strict()
    : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new Error('Office capability input is invalid')
  }
  return parsed.data
}

function createOfficeCallableOperations(
  resolveContext: OfficeToolContextResolver | undefined,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  if (resolveContext === undefined) return {}

  const operations: Record<string, KernelCallableCapabilityOperation> = {}
  for (const [fallbackName, candidate] of Object.entries(officeTools)) {
    const tool = candidate as unknown as VelaTool
    const operation = tool.name ?? fallbackName
    operations[operation] = {
      metadata: {
        permissions: [...new Set(tool.permissions)],
        reason: tool.capabilities?.reason
          ?? `Invoke office tool operation "${operation}".`,
      },
      async invoke(scope, input, signal) {
        const parsed = parseToolInput(tool, input)
        const resolvedContext = await resolveContext(scope, signal)
        const toolContext: OfficeToolContext = {
          ...resolvedContext,
          abortSignal: signal,
        }
        if (tool.isAvailable?.(toolContext) === false) {
          throw new Error('Office capability operation is unavailable')
        }
        signal.throwIfAborted()
        return tool.execute(parsed, toolContext)
      },
    }
  }
  return operations
}

/** Registers a read-only and optionally callable office tool collection. */
export function createOfficeToolsKernelModule(
  options: CreateOfficeToolsKernelModuleOptions = {},
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.office.tools',
      version: '0.2.7',
      apiVersion: 1,
      provides: [OfficeToolsCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['fs:read', 'fs:write', 'process:exec'],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(
        createOfficeCallableOperations(options.resolveContext),
      )
      const service: OfficeToolsCapabilityService = Object.freeze({
        ...callable,
        tools: Object.freeze({ ...officeTools }),
      })
      context.registerService(OfficeToolsCapability, service)
    },
  })
}
