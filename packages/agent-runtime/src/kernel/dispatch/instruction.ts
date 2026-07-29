// 域：子 Agent 派发的**出站指令拼装**（纯函数，把派发输入 + 类型配置拼成子 Agent 任务指令）。
import { toNullable } from '@velaros-ai/core'
import type { ToolCategoryId } from '@velaros-ai/core/types'

import type { ResolvedSubAgentTypeConfig } from '../../sub-agent'

import type { SubAgentDispatchInput } from './host-ports'

function buildSubAgentDispatchInstruction(
  input: SubAgentDispatchInput,
  typeConfig: ResolvedSubAgentTypeConfig,
  title: string,
  toolCategories: readonly ToolCategoryId[],
  priorFindingsBriefing: Nullable<string>,
  readonlyMode: boolean
): string {
  return [
    `子任务：${title}`,
    typeConfig.customAgentId
      ? `类型：${typeConfig.customAgentName ?? typeConfig.customAgentId}（自定义 agent "${typeConfig.customAgentId}"，base: ${typeConfig.subagentType}）`
      : `类型：${typeConfig.subagentType}`,
    readonlyMode ? '模式：只读（不得修改受保护资源）。' : null,
    `初始授权工具分类：${toolCategories.join(', ')}`,
    input.description?.trim() ? `说明：${input.description.trim()}` : null,
    input.attachments?.length
      ? `附件上下文：\n${input.attachments.map((item) => `- ${item.trim()}`).join('\n')}`
      : null,
    toNullable(typeConfig.promptAppend),
    toNullable(priorFindingsBriefing),
    `任务：\n${input.prompt.trim()}`,
    input.structuredOutputContract
      ? [
          '结构化交付契约：完成所有必要工具调用后，最终回复只能包含一个 JSON 值。',
          input.structuredOutputContract.name
            ? `schema 名称：${input.structuredOutputContract.name}`
            : null,
          input.structuredOutputContract.description?.trim()
            ? `schema 说明：${input.structuredOutputContract.description.trim()}`
            : null,
          `JSON Schema：\n${JSON.stringify(input.structuredOutputContract.schema)}`,
        ]
          .filter(Boolean)
          .join('\n')
      : null,
    // tool_map/tool_replace 换页教义不再写进任务指令:canonical 是系统提示词的
    // tool-capability-map 段(按 tool_map 实际暴露门控;无条件指令行会在子 agent
    // 没有 tool_map 时教一个不存在的工具)。
    input.structuredOutputContract
      ? '最终回复只返回满足 schema 的 JSON，不要添加 Markdown fence 或解释。'
      : '完成后返回简洁摘要：做了什么、关键发现/改动、未完成项与下一步建议。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export { buildSubAgentDispatchInstruction }
