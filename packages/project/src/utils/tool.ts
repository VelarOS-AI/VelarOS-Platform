/**
 * 定义项目工具与挂进内核的辅助：defineProjectTool 把工具说明、schema、权限与 execute 组装成运行时规格，编辑类工具接入入参复用（只在工具文件里调用）；
 * 只写真有内容的说明节，缺的节不补占位句。挂进内核时的调用表用 agent 的 createToolCallableOperations，这里只给领域错误的翻译。
 */


import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { defineToolRuntimeSpec, resolveToolInputReuse, withToolInputReuse } from '@velaros-ai/agent/tool-contract'
import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProjectToolContract } from '../contract/constants.js'
import type { VelaTool } from '../contract/provides.js'
import type { ProjectToolContext } from '../contract/requires.js'

import { ProjectError, toErrorObject } from './errors.js'

/** 定义一个项目工具：把说明、schema、权限、能力声明与 execute 组装成运行时规格；execute 先还原入参复用再严格解析，编辑类工具的 schema 接入入参复用。 */
export function defineProjectTool<TInput extends Record<string, any>>(input: {
  name: string
  inputContractVersion?: number
  category: ToolCategoryId
  role: 'inspect' | 'edit' | 'execute'
  summary: string
  suitable: readonly [string, ...string[]]
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
    suitable,
    forbidden,
    protocol,
    usage,
    examples,
    notes,
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

/** 挂进内核时的错误翻译：项目领域错误转成内核能力的 AppError，码与文字照搬，原错误的结构化详情放进 context.projectError；别的错误原样交出。 */
export function toProjectCapabilityError(error: unknown): unknown {
  if (!(error instanceof ProjectError)) return error
  return new AppError(error.reason, error.message, error, { projectError: toErrorObject(error) })
}

/** project:change 计划里一个文件的来源只能写一种：fileRef、sourceRef、path 恰好给了一个。 */
export function hasExactlyOneSource(value: { fileRef?: string; sourceRef?: string; path?: string }): boolean {
  return [value.fileRef, value.sourceRef, value.path].filter((item) => !isUndefined(item)).length === 1
}
