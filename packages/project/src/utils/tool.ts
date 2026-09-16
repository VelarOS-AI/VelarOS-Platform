/**
 * 定义项目工具与挂进内核的辅助：defineProjectTool 把工具说明、schema、权限与 execute 组装成运行时规格，声明了 inputReuse 的工具接入入参复用
 * （只在工具文件里调用）；只写真有内容的说明节，缺的节不补占位句。挂进内核时的调用表用 `@velaros-ai/tool-contract` 的 toolKernelModules，这里只给领域错误的翻译。
 */

import { resolveToolInputReuse, withToolInputReuse } from '@velaros-ai/agent/tool-contract'
import { isUndefined } from '@velaros-ai/core'
import { toolContracts, toolFailures } from '@velaros-ai/tool-contract'

import { ProjectToolContract } from '../contract/constants.js'
import type { VelaTool } from '../contract/provides.js'
import type { ProjectToolContext } from '../contract/requires.js'
import type { DefineProjectToolInput } from '../types/tool.js'

import { ProjectError, toErrorObject } from './errors.js'

/**
 * 定义一个项目工具：类别每条工具自己写，参数契约版本缺省取本包的那一版；execute 先还原入参复用再按原 schema 严格解析。
 * 入参复用的信封（reuse、changes）只给显式声明 `inputReuse: true` 的工具：正文长、改一个字段就要整份重发的那几个。
 */
export const defineProjectTool: <TInput extends Record<string, any>>(
  input: DefineProjectToolInput<TInput>
) => VelaTool<any> = toolContracts.createDefiner<ProjectToolContext>({
  contractVersion: ProjectToolContract.inputVersion,
  inputReuse: withToolInputReuse,
  // 先把入参复用请求还原成完整入参，再按原 schema 严格解析；项目资源门由各执行类自己套。
  wrapExecute: (tool) => async (args, context) =>
    tool.execute(
      tool.schema.parse(
        await resolveToolInputReuse(context, tool.name, args, context.toolCallId, {
          inputContractVersion: tool.inputContractVersion,
        })
      ),
      context
    ),
})

/** 挂进内核时的错误翻译：项目领域错误转成内核能力的 AppError，码与文字照搬，原错误的结构化详情镜像进工具契约约定的那一格；别的错误原样交出。 */
export function toProjectCapabilityError(error: unknown): unknown {
  if (!(error instanceof ProjectError)) return error
  return toolFailures.domain(error.reason, error.message, error, toErrorObject(error))
}

/** project:edit 的一步里，文件来源只能写一种：fileRef、sourceRef、path 恰好给了一个。 */
export function hasExactlyOneSource(value: { fileRef?: string; sourceRef?: string; path?: string }): boolean {
  return [value.fileRef, value.sourceRef, value.path].filter((item) => !isUndefined(item)).length === 1
}
