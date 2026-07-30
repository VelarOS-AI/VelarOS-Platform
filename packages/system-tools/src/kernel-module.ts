import { z } from 'zod'

import { isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
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

function invalidCapabilityInput(detail: string): AppError {
  return new AppError('VALIDATION', `System capability input is invalid: ${detail}`)
}

/**
 * 判据（§5.3b ④安全门）——wire 面唯一入参解析点，object schema 一律 **strict**。
 *
 * 系统工具的入参里有 `path`、`cwd`、`command`、`overwrite` 这类直接决定"动哪个文件/跑什么"的轴；
 * 非 strict 会让未知键静默穿过 zod，落成"看起来生效了其实被忽略"。拒绝时把 zod 的字段路径原样
 * 带出（§2.7）——原先无论哪个字段错都只回同一句话，等于没有诊断。
 */
function parseToolInput(tool: VelaTool, input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalidCapabilityInput('expected an object payload')

  const schema = tool.schema instanceof z.ZodObject
    ? tool.schema.strict()
    : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw invalidCapabilityInput(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
    )
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
          throw new AppError(
            'UNAVAILABLE',
            `System capability operation "${operation}" is unavailable in the resolved context.`
          )
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
