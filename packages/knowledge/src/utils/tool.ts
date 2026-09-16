/** 定义一个知识工具：把类别、上下文与权限类型钉死，工具文件只管填内容。 */

import { defineToolRuntimeSpec } from '@velaros-ai/agent/tool-contract'

import type { DefineKnowledgeToolInput, KnowledgeTool } from '../types/tool.js'

/** 把一份工具定义收成运行时规格；只许在 `impl/KnowledgeTools.ts` 里调。 */
export function defineKnowledgeTool<TInput extends Record<string, unknown>>(
  input: DefineKnowledgeToolInput<TInput>
): KnowledgeTool<TInput> {
  return defineToolRuntimeSpec(input)
}
