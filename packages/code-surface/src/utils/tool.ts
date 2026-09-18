/** 工具：定义门的工具。类别固定填 program，其余交给 `@velaros-ai/tool-contract` 的公共实现。 */

import { type DefineToolRuntimeSpecInput, toolContracts, type ToolPermission } from '@velaros-ai/tool-contract'

import { CodeSurfaceToolCategoryId } from '../contract/constants.js'
import type { CodeSurfaceTool } from '../contract/provides.js'
import type { CodeSurfaceToolContext } from '../contract/requires.js'

/** 定义一个门的工具：门只有一个工具，类别统一填 program。 */
export const defineCodeSurfaceTool: <TInput extends Record<string, unknown>>(
  input: Omit<DefineToolRuntimeSpecInput<TInput, CodeSurfaceToolContext, unknown, ToolPermission>, 'category'>
) => CodeSurfaceTool<TInput> = toolContracts.createDefiner<CodeSurfaceToolContext>({
  categoryOf: () => CodeSurfaceToolCategoryId,
})
