import type { ModelMessage } from 'ai'

import { isArray, isObject,isPresent, isString, toNullable } from '@velaros-ai/core'
import type {
  PromptSegmentTrace,
  SkippedPromptSegmentTrace,
  StreamTurnContextPayload,
} from '@velaros-ai/core/types'

import { isToolCategoryAvailable } from '../../tools'
import { isInternalFollowUpMessage } from '../history'
import type { AgentRoleResolution } from '../RoleTypes'

import type { RunContextToolContext } from './host-ports'

const RepeatedDebugUserPromptElideChars = 2_000
const RepeatedDebugUserPromptPreviewChars = 120

interface BuildTurnContextPayloadArgs {
  turn: number
  roleResolution: AgentRoleResolution
  roleRuntimeModel: StreamTurnContextPayload['roleRuntimeModel']
  systemPrompt: string
  devEnvironmentContext: Nullable<string>
  stableCutoff: number
  promptSegments: PromptSegmentTrace[]
  skippedPromptSegments: SkippedPromptSegmentTrace[]
  history: ModelMessage[]
  toolContext: RunContextToolContext
  allowedTools?: string[]
  toolSchemaTelemetry?: StreamTurnContextPayload['toolSchemaTelemetry']
  runProfileTelemetry?: StreamTurnContextPayload['runProfileTelemetry']
  toolAllocatorTelemetry?: StreamTurnContextPayload['toolAllocatorTelemetry']
  turnPlanningTelemetry?: StreamTurnContextPayload['turnPlanningTelemetry']
  contextPhaseTelemetry: StreamTurnContextPayload['contextPhaseTelemetry']
}

/**
 * 单轮 turn 的调试上下文载荷构造器。
 *
 * 供执行协调器 / 渲染进程调试面板展示：本轮角色、系统提示词片段、
 * 可见工具、消息快照等；不参与模型推理本身。
 */
class TurnPayload {
  public build({
    turn,
    roleResolution,
    roleRuntimeModel,
    systemPrompt,
    devEnvironmentContext,
    stableCutoff,
    promptSegments,
    skippedPromptSegments,
    history,
    toolContext,
    allowedTools,
    toolSchemaTelemetry,
    runProfileTelemetry,
    toolAllocatorTelemetry,
    turnPlanningTelemetry,
    contextPhaseTelemetry,
  }: BuildTurnContextPayloadArgs): StreamTurnContextPayload {
    const availableTools = toolContext.listTools().map((tool) => tool.name)
    const visibleTools = allowedTools
      ? availableTools.filter((toolName) => allowedTools.includes(toolName))
      : availableTools
    // active 类别反映编码会话追踪器当前轮次的动态开关（含意图激活）。
    const visibleCategorySource = toolContext.codingSession.getActiveToolCategories()
    const visibleCategories = visibleCategorySource.filter((categoryId) =>
      isToolCategoryAvailable(categoryId, {
        roleId: roleResolution.id,
        activeCapabilityScope: toolContext.codingSession.getActiveCapabilityScope(),
        capabilityPorts: toolContext.capabilityPorts,
      })
    )

    return {
      kind: 'turn-context',
      turn,
      roleId: roleResolution.id,
      roleLabel: roleResolution.label,
      roleDescription: roleResolution.description,
      workflowType: roleResolution.workflowType,
      roleExpectedOutput: roleResolution.contract.expectedOutputKind,
      activeSkillMarkdown: roleResolution.skillMarkdown,
      roleRouteNote: roleResolution.routeNote,
      roleRuntimeModel,
      systemPrompt,
      devEnvironmentContext,
      stableCutoff,
      promptSegments,
      skippedPromptSegments,
      // 恒空占位：能力包拥有的上下文走注入的 turn-context source，从不经 RunContext/本载荷生产。
      // 字段本身为 StreamTurnContextPayload 必填，由核心类型面消费方保形。
      capabilityContextAudit: [],
      messages: this.serializeDebugMessages(history, turn),
      allowedTools: visibleTools,
      enabledToolCategories: visibleCategories,
      contextPhaseTelemetry,
      toolSchemaTelemetry: toNullable(toolSchemaTelemetry),
      runProfileTelemetry: toNullable(runProfileTelemetry),
      toolAllocatorTelemetry: toNullable(toolAllocatorTelemetry),
      turnPlanningTelemetry: toNullable(turnPlanningTelemetry),
    }
  }

  private serializeDebugMessages(
    history: ModelMessage[],
    turn: number
  ): StreamTurnContextPayload['messages'] {
    const visibleHistory = history.filter((message) => !isInternalFollowUpMessage(message))

    return visibleHistory.map((message, index) => ({
      role: message.role,
      content: this.serializeDebugContent(message.content, {
        role: message.role,
        repeatedTurn: turn > 1,
        // 历史轮用户消息在重复调试导出时截断，避免载荷体积过大。
        isHistoricalMessage: index < visibleHistory.length - 1,
      }),
    }))
  }

  private summarizeBinaryValue(value: any): any {
    if (isString(value)) return `[base64 ${Math.ceil((value.length * 3) / 4)} bytes]`

    if (value instanceof URL) return value.toString()

    if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`

    if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`

    return value
  }

  private serializeDebugContent(
    content: ModelMessage['content'],
    options: {
      role?: ModelMessage['role']
      repeatedTurn?: boolean
      isHistoricalMessage?: boolean
    } = {}
  ): any {
    if (isString(content)) {
      if (
        options.role === 'user' &&
        options.repeatedTurn &&
        options.isHistoricalMessage &&
        content.length > RepeatedDebugUserPromptElideChars
      )
        return [
          `[较早的用户消息已从重复调试载荷中省略；原文字符数=${content.length}]`,
          content.slice(0, RepeatedDebugUserPromptPreviewChars),
        ].join('\n')

      return content
    }

    if (!isArray(content)) return content

    // 多模态 part：图片/文件只保留体积摘要，避免 base64 撑爆调试流。
    return content.map((part) => {
      if (!isPresent(part) || !isObject(part)) return part

      const record = part as { type?: unknown; image?: unknown; data?: unknown }
      if (record.type === 'image' && isPresent(record.image))
        return {
          ...record,
          image: this.summarizeBinaryValue(record.image),
        }

      if (record.type === 'file' && isPresent(record.data))
        return {
          ...record,
          data: this.summarizeBinaryValue(record.data),
        }

      return JSON.parse(JSON.stringify(part))
    })
  }
}

export { TurnPayload }
export type { BuildTurnContextPayloadArgs }
export { TurnPayload as AgentTurnContextPayloadBuilder }
