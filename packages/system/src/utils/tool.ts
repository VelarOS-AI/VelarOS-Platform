/**
 * 工具：定义系统工具。类别按工具名查表、声明了 inputReuse 的工具套上复用信封，
 * 这两条空间规则之外的一切都交给 `@velaros-ai/tool-contract` 的公共实现。
 */

import { withToolInputReuse } from '@velaros-ai/agent/tool-contract'
import { toolContracts } from '@velaros-ai/tool-contract'

import type { SystemToolName } from '../contract/constants.js'
import { SystemToolCategoryByName } from '../contract/constants.js'
import type { VelaTool } from '../contract/provides.js'
import type { SystemToolContext } from '../contract/requires.js'
import type { DefineSystemToolInput } from '../types/tool.js'

/** 定义一个系统工具：类别按工具名自动查表填上，保证一个工具只属于一个类别；声明了 inputReuse 的工具，示例按原 schema 校验后再套上复用信封。 */
export const defineSystemTool: <TInput extends Record<string, unknown>>(
  input: DefineSystemToolInput<TInput>
) => VelaTool<TInput> = toolContracts.createDefiner<SystemToolContext>({
  categoryOf: (name) => SystemToolCategoryByName[name as SystemToolName],
  inputReuse: withToolInputReuse,
})
