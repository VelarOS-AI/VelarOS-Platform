import { z } from 'zod'

import { isArray, isFalse, isFunction, isPlainObject, isPresent } from '@velaros-ai/core'
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

import { officeTools } from './Collection'
import type { OfficeToolContext, VelaTool } from './officeShared'

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

function invalidCapabilityInput(detail: string): AppError {
  return new AppError('VALIDATION', `Office capability input is invalid: ${detail}`)
}

/**
 * 判据（§5.3b ④安全门）——wire 面唯一入参解析点，object schema 一律 **strict**。
 *
 * 非 strict 会让未知键静默穿过 zod 落进工具实现；办公工具的入参里有 `outputPath`、`overwrite`
 * 这类直接决定落盘位置与覆盖行为的轴，多一个被忽略的键就是一次"看起来生效了其实没有"。
 * 拒绝时把 zod 的路径原样带出来（§2.7），不然调用方只知道"无效"却不知道哪个字段。
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

/**
 * 工具集合是**动态注册面**：各工具的入参类型互不相同，联合起来无法与统一调用签名咬合。
 * 这里用结构守卫把它收窄成本模块真正依赖的那一面（§1.10），替代擦类型再捏一个的双重断言；
 * 形状不符只可能是本包自己接错线，故 fail-fast（§1.8），不静默跳过。
 */
function isCallableOfficeTool(value: unknown): value is VelaTool {
  return (
    isPlainObject(value)
    && isFunction(value.execute)
    && isArray(value.permissions)
    && isPresent(value.schema)
  )
}

function createOfficeCallableOperations(
  resolveContext: LooseOptional<OfficeToolContextResolver>,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  if (!resolveContext) return {}

  const operations: Record<string, KernelCallableCapabilityOperation> = {}
  for (const [fallbackName, candidate] of Object.entries(officeTools)) {
    if (!isCallableOfficeTool(candidate)) {
      throw new AppError(
        'INVARIANT',
        `Office tool "${fallbackName}" is not a runnable tool spec.`
      )
    }
    const tool = candidate
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
        if (isFalse(tool.isAvailable?.(toolContext))) {
          throw new AppError(
            'UNAVAILABLE',
            `Office capability operation "${operation}" is unavailable in the resolved context.`
          )
        }
        signal.throwIfAborted()
        return tool.execute(parsed, toolContext)
      },
    }
  }
  return operations
}

/** Registers a read-only and optionally callable office tool collection. */
export function createOfficeKernelModule(
  options: CreateOfficeKernelModuleOptions = {},
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.office',
      version: '0.2.7',
      apiVersion: 1,
      provides: [OfficeCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['fs:read', 'fs:write', 'process:exec'],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(
        createOfficeCallableOperations(options.resolveContext),
      )
      const service: OfficeCapabilityService = Object.freeze({
        ...callable,
        tools: Object.freeze({ ...officeTools }),
      })
      context.registerService(OfficeCapability, service)
    },
  })
}
