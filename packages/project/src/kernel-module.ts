import { z } from 'zod'

import { isFalse, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityOperation,
  type KernelCallableCapabilityService,
  KernelModuleApiVersion,
  type KernelModuleDefinition,
  type ScopeRef,
} from '@velaros-ai/kernel/contracts/abi'

import { projectTools } from './agent/Project.tool.js'
import type { ProjectToolContext, VelaTool } from './agent/Types.js'
import { PROJECT_PACKAGE_VERSION } from './core/defaults.js'
import { ProjectError, toErrorObject } from './errors.js'

export type ProjectToolContextResolver = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => ProjectToolContext | Promise<ProjectToolContext>

export interface CreateProjectKernelModuleOptions {
  readonly resolveContext: ProjectToolContextResolver
}

export interface ProjectCapabilityService extends KernelCallableCapabilityService {
  readonly tools: Readonly<typeof projectTools>
}

export const ProjectCapability =
  createCapabilityToken<ProjectCapabilityService>('velaros.project')

function projectCapabilityError(error: ProjectError): AppError {
  return new AppError(error.reason, error.message, error, {
    projectError: toErrorObject(error),
  })
}

function invalidProjectInput(detail: string): AppError {
  return projectCapabilityError(new ProjectError(
    'INVALID_INPUT',
    `Project capability input is invalid: ${detail}`,
    { detail },
    '请根据工具 schema 修正参数后重试。',
  ))
}

function parseProjectToolInput(
  tool: VelaTool,
  input: unknown,
): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalidProjectInput('expected an object payload')
  const schema = tool.schema instanceof z.ZodObject ? tool.schema.strict() : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw invalidProjectInput(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    )
  }
  return parsed.data
}

function createProjectOperations(
  resolveContext: ProjectToolContextResolver,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  const operations: Record<string, KernelCallableCapabilityOperation> = {}
  for (const [fallbackName, candidate] of Object.entries(projectTools)) {
    const tool = candidate as VelaTool
    const operation = tool.name ?? fallbackName
    operations[operation] = {
      metadata: {
        permissions: [...new Set(tool.permissions)],
        reason: tool.capabilities?.reason
          ?? `Invoke project tool operation "${operation}".`,
      },
      async invoke(scope, input, signal) {
        const context = await resolveContext(scope, signal)
        const resolvedContext: ProjectToolContext = { ...context, abortSignal: signal }
        if (isFalse(tool.isAvailable?.(resolvedContext))) {
          throw new AppError(
            'UNAVAILABLE',
            `Project capability operation "${operation}" is unavailable in the resolved context.`,
          )
        }
        signal.throwIfAborted()
        try {
          return await tool.execute(parseProjectToolInput(tool, input), resolvedContext)
        } catch (error) {
          if (error instanceof ProjectError) throw projectCapabilityError(error)
          throw error
        }
      },
    }
  }
  return operations
}

export function createProjectKernelModule(
  options: CreateProjectKernelModuleOptions,
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: 'velaros.project',
      version: PROJECT_PACKAGE_VERSION,
      apiVersion: KernelModuleApiVersion,
      provides: [ProjectCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['fs:read', 'fs:write', 'process:exec'],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(
        createProjectOperations(options.resolveContext),
      )
      context.registerService(ProjectCapability, Object.freeze({
        ...callable,
        tools: Object.freeze({ ...projectTools }),
      }))
    },
  })
}
