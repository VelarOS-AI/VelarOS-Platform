// 域：子 Agent 派发的**出站指令拼装**（纯函数，把派发输入 + 类型配置拼成子 Agent 任务指令）。
import type {
  SubAgentSessionRecord,
  SubAgentSessionStatus,
  SubAgentStructuredOutputContract,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'
import { last, toNullable, truncate } from '@velaros-ai/core'

import type { ResolvedSubAgentTypeConfig } from '../../sub-agent'

import type { SubAgentDispatchInput } from './host-ports'

/** 续跑时上一次运行的结局：异常结束的线程要提醒子 Agent 先核对现状再接着做。 */
interface SubAgentResumeBriefing {
  previousStatus: SubAgentSessionStatus
  /** 上一次运行的失败原因摘要；上一次不是 failed 时为 null。 */
  previousFailure: Nullable<string>
}

const ResumeFailureReasonMaxChars = 200

function formatAttachments(attachments: LooseOptional<readonly string[]>): Nullable<string> {
  if (!attachments?.length) return null
  return `附件上下文：\n${attachments.map((item) => `- ${item.trim()}`).join('\n')}`
}

function formatStructuredOutputContract(
  contract: LooseOptional<SubAgentStructuredOutputContract>
): Nullable<string> {
  if (!contract) return null
  return [
    '结构化交付契约：完成所有必要工具调用后，最终回复只能包含一个 JSON 值。',
    contract.name ? `schema 名称：${contract.name}` : null,
    contract.description?.trim() ? `schema 说明：${contract.description.trim()}` : null,
    `JSON Schema：\n${JSON.stringify(contract.schema)}`,
  ]
    .filter(Boolean)
    .join('\n')
}

function formatDeliveryInstruction(
  contract: LooseOptional<SubAgentStructuredOutputContract>
): string {
  return contract
    ? '最终回复只返回满足 schema 的 JSON，不要添加 Markdown fence 或解释。'
    : '完成后返回简洁摘要：做了什么、关键发现/改动、未完成项与下一步建议。'
}

function formatPreviousRunNote(briefing: SubAgentResumeBriefing): Nullable<string> {
  switch (briefing.previousStatus) {
    case 'failed':
      return `注意：你上次的运行异常结束${
        briefing.previousFailure ? `（${briefing.previousFailure}）` : ''
      }，可能只完成了一部分；先核对当前实际状态，再接着做。`
    case 'aborted':
      return '注意：你上次的运行被中断，最后一步可能只执行了一半、结果也没有记在上文里；先核对当前实际状态，再接着做。'
    default:
      return null
  }
}

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
    formatAttachments(input.attachments),
    toNullable(typeConfig.promptAppend),
    toNullable(priorFindingsBriefing),
    `任务：\n${input.prompt.trim()}`,
    formatStructuredOutputContract(input.structuredOutputContract),
    // tooling:map/tooling:replace 换页教义不再写进任务指令:canonical 是系统提示词的
    // tool-capability-map 段(按 tooling:map 实际暴露门控;无条件指令行会在子 agent
    // 没有 tooling:map 时教一个不存在的工具)。
    formatDeliveryInstruction(input.structuredOutputContract),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 续跑指令：只有追加任务本身 + 陈旧提醒（附件 / 输出契约照给）。
 *
 * 不重复首次派发的委派外壳、类型与授权分类、「已知上下文」前缀——它们都在线程历史里，子 Agent
 * 看得见；再抄一遍只会白占上下文，而续跑省下的恰恰是这部分重读成本。
 */
function buildSubAgentResumeInstruction(
  input: SubAgentDispatchInput,
  briefing: SubAgentResumeBriefing
): string {
  return [
    '续跑：上级主 Agent 在同一条工作线上给你追加了任务。上文就是你之前的工作记录，直接在此基础上继续，不必从头重新探索。',
    formatPreviousRunNote(briefing),
    '自上次运行后文件可能已变化，修改前先重新读取。',
    formatAttachments(input.attachments),
    `任务：\n${input.prompt.trim()}`,
    formatStructuredOutputContract(input.structuredOutputContract),
    formatDeliveryInstruction(input.structuredOutputContract),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 从线程记录读出上一次运行的结局（续跑前、状态被改成 running 之前调用）。 */
function buildSubAgentResumeBriefing(session: SubAgentSessionRecord): SubAgentResumeBriefing {
  if (session.status !== 'failed') return { previousStatus: session.status, previousFailure: null }
  // 失败结果的正文 = 失败原因 + 空行 + 重派引导；只取原因那一段。
  const reason = last(session.results)?.summary.split('\n\n')[0]?.trim()
  return {
    previousStatus: session.status,
    previousFailure: reason ? truncate(reason, ResumeFailureReasonMaxChars) : null,
  }
}

export { buildSubAgentDispatchInstruction, buildSubAgentResumeBriefing, buildSubAgentResumeInstruction }
export type { SubAgentResumeBriefing }
