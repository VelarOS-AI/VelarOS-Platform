/** 工具：定义门的工具。类别固定填 program，其余交给 `@velaros-ai/agent` 的工具契约（`./tool-contract` 入口）。 */

import type { ToolPermission } from '@velaros-ai/agent/contracts'
import { type DefineToolRuntimeSpecInput, toolContracts } from '@velaros-ai/agent/tool-contract'

import { CodeSurfaceToolCategoryId } from '../contract/constants.js'
import type { CodeSurfaceTool } from '../contract/provides.js'
import type { CodeSurfaceToolContext } from '../contract/requires.js'

/** 定义一个门的工具：门只有一个工具，类别统一填 program。 */
export const defineCodeSurfaceTool: <TInput extends Record<string, unknown>>(
  input: Omit<DefineToolRuntimeSpecInput<TInput, CodeSurfaceToolContext, unknown, ToolPermission>, 'category'>
) => CodeSurfaceTool<TInput> = toolContracts.createDefiner<CodeSurfaceToolContext>({
  categoryOf: () => CodeSurfaceToolCategoryId,
})
