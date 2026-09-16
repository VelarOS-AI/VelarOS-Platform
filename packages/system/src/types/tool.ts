/**
 * 定义工具时的入参类型：工具运行时规格去掉类别，外加是否支持入参复用。只有 `utils/tool.ts` 用，不出包。
 */

import type { ToolPermission } from '@velaros-ai/agent/contracts'
import type { DefineToolRuntimeSpecInput } from '@velaros-ai/tool-contract'

import type { SystemToolName } from '../contract/constants.js'
import type { SystemToolContext } from '../contract/requires.js'

/** 定义一个系统工具时给 `defineSystemTool` 的入参：工具运行时规格去掉类别（类别按工具名查表），外加是否支持入参复用。 */
export type DefineSystemToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, SystemToolContext, unknown, ToolPermission>,
  'category'
> & {
  /** 工具名，类别按它查表。 */
  name: SystemToolName
  /** 失败后入参可复用：失败回执带 inputReuse，下一次用 reuse + changes 只改出问题的字段。执行器在 execute 之前把复用请求还原成完整入参。 */
  inputReuse?: boolean
}
