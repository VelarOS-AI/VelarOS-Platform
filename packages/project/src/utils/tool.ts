/**
 * 定义项目工具与挂进内核的辅助：defineProjectTool 把工具说明、schema、权限与 execute 组装成运行时规格，编辑类工具接入入参复用（只在工具文件里调用）；
 * createProjectCallableOperations 把工具集合变成内核能力的可调用操作表，每次调用先严格解析入参、再向宿主解析上下文。
 */

import { z } from 'zod'

import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { defineToolRuntimeSpec, resolveToolInputReuse, withToolInputReuse } from '@velaros-ai/agent/tool-contract'
import { isFalse, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { KernelCallableCapabilityOperation } from '@velaros-ai/kernel/contracts/abi'

import { ProjectToolContract } from '../contract/constants.js'
import type { ProjectToolCollection, VelaTool } from '../contract/provides.js'
import type { ProjectToolContext, ProjectToolContextResolver } from '../contract/requires.js'

import { ProjectError, toErrorObject } from './errors.js'

/** 定义一个项目工具：把说明、schema、权限、能力声明与 execute 组装成运行时规格；execute 先还原入参复用再严格解析，编辑类工具的 schema 接入入参复用。 */
export function defineProjectTool<TInput extends Record<string, any>>(input: {
  name: string
  inputContractVersion?: number
  category: ToolCategoryId
  role: 'inspect' | 'edit' | 'execute'
  summary: string
  suitable?: readonly [string, ...string[]]
  forbidden?: readonly [string, ...string[]]
  protocol?: readonly [string, ...string[]]
  usage?: readonly [string, ...string[]]
  examples: readonly [Record<string, unknown>, ...Array<Record<string, unknown>>]
  notes?: readonly [string, ...string[]]
  schema: VelaTool<TInput>['schema']
  permissions: VelaTool<TInput>['permissions']
  capabilities?: VelaTool<TInput>['capabilities']
  exposure?: VelaTool<TInput>['exposure']
  hideWhenUnavailable?: VelaTool<TInput>['hideWhenUnavailable']
  isAvailable?: VelaTool<TInput>['isAvailable']
  isConcurrencySafe?: VelaTool<TInput>['isConcurrencySafe']
  execute: VelaTool<TInput>['execute']
}): VelaTool<any> {
  const {
    name,
    category,
    role,
    summary,
    suitable,
    forbidden,
    protocol,
    usage,
    examples,
    notes,
    ...tool
  } = input
  const inputContractVersion = input.inputContractVersion ?? ProjectToolContract.inputVersion
  const defined = defineToolRuntimeSpec({
    name,
    category,
    role,
    summary,
    suitable: suitable ?? ['需要完成该工具职责所描述的项目操作。'],
    forbidden: forbidden ?? ['目标不属于当前项目边界。'],
    protocol: protocol ?? ['只使用当前项目上下文解析路径和执行操作。'],
    usage: usage ?? ['参数必须来自当前请求或前序工具结果。'],
    examples,
    notes: notes ?? ['返回值是当前操作的权威结果。'],
    ...tool,
    inputContractVersion,
  })
  // 先把入参复用请求还原成完整入参，再按 schema 严格解析；项目资源门由各执行类自己套。
  const execute = async (args: Record<string, unknown>, context: ProjectToolContext) =>
    tool.execute(tool.schema.parse(await resolveToolInputReuse(context, name, args, context.toolCallId, {
      inputContractVersion,
    })), context)
  if (role !== 'edit')
    return Object.freeze({ ...defined, execute })
  return Object.freeze({ ...defined, schema: withToolInputReuse(tool.schema), execute })
}

/** 把项目领域错误转成内核能力的 AppError：码与文字照搬，原错误的结构化详情放进 context.projectError。 */
function projectCapabilityError(error: ProjectError): AppError {
  return new AppError(error.reason, error.message, error, { projectError: toErrorObject(error) })
}

/** 内核调用方给的入参不合法：说明哪一处不对，让调用方按工具 schema 修正。 */
function invalidProjectInput(detail: string): AppError {
  return projectCapabilityError(new ProjectError('INVALID_INPUT', `项目能力的入参不合法：${detail}`, { detail }, '请根据工具 schema 修正参数后重试。'))
}

/** 按工具的 schema 严格解析内核调用方给的入参（对象 schema 一律拒收未知字段）；不合法就报出每一处问题。 */
function parseProjectToolInput(tool: VelaTool, input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalidProjectInput('入参必须是对象')
  const schema = tool.schema instanceof z.ZodObject ? tool.schema.strict() : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw invalidProjectInput(parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '))
  }
  return parsed.data
}

/** 把工具集合变成内核能力的可调用操作表：按工具名调用，先向宿主解析上下文、核对工具可用，再严格解析入参执行；领域错误转成 AppError。 */
export function createProjectCallableOperations(
  tools: ProjectToolCollection,
  resolveContext: ProjectToolContextResolver,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  const operations: Record<string, KernelCallableCapabilityOperation> = {}
  for (const [fallbackName, candidate] of Object.entries(tools)) {
    const tool = candidate as VelaTool
    const operation = tool.name ?? fallbackName
    operations[operation] = {
      metadata: {
        permissions: [...new Set(tool.permissions)],
        reason: tool.capabilities?.reason ?? `调用项目工具 ${operation}。`,
      },
      async invoke(scope, input, signal) {
        const context = await resolveContext(scope, signal)
        const resolvedContext: ProjectToolContext = { ...context, abortSignal: signal }
        if (isFalse(tool.isAvailable?.(resolvedContext))) throw new AppError('UNAVAILABLE', `项目能力 ${operation} 在解析出的上下文里不可用。`)
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
