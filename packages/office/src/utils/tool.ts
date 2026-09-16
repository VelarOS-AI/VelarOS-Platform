/** 工具：定义 office 工具。类别固定填 office，其余交给 `@velaros-ai/agent/tool-contract` 的公共实现。 */

import type { ToolPermission } from '@velaros-ai/agent/protocol'
import { defineToolRuntimeSpec, type DefineToolRuntimeSpecInput } from '@velaros-ai/agent/tool-contract'

import { OfficeToolCategoryId } from '../contract/constants.js'
import type { VelaTool } from '../contract/provides.js'
import type { OfficeToolContext } from '../contract/requires.js'

/** 定义一个 office 工具：十个工具同属 office 这一个职责类别，这里统一填上。 */
export function defineOfficeTool<TInput extends Record<string, unknown>>(
  input: Omit<
    DefineToolRuntimeSpecInput<TInput, OfficeToolContext, unknown, ToolPermission>,
    'category'
  >
): VelaTool<TInput> {
  return defineToolRuntimeSpec({ ...input, category: OfficeToolCategoryId })
}
