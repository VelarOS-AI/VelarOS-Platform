import type { ModelMessage } from 'ai'

import { isArray, isObject,isPresent, isString, toNullable } from '@velaros-ai/core'

import type {
  StreamTurnContextPayload,
} from '../../types/agent'
import type { BuildTurnContextPayloadArgs } from '../../types/runner.js'
import { isInternalFollowUpMessage } from '../history/internal-messages'
import { isToolCategoryAvailable } from '../tools/access-policy'

const RepeatedDebugUserPromptElideChars = 2_000
const RepeatedDebugUserPromptPreviewChars = 120

/**
 * 把二进制型的多模态内容换成一行体积摘要：base64 字符串按长度折算字节数，`URL` 取原文，
 * `ArrayBuffer` 与各种 TypedArray 报 `byteLength`；认不出的值原样返回。
 * 只为调试载荷服务——留下"有多大"，不留原始字节。
 */
function summarizeBinaryValue(value: any): any {
  if (isString(value)) return `[base64 ${Math.ceil((value.length * 3) / 4)} bytes]`

  if (value instanceof URL) return value.toString()

  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`

  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`

  return value
}

/**
 * 把一条消息的正文整理成可安全送进调试面板的形态。
 *
 * 纯字符串正文只有一种情况会动：重复轮次里、不是最后一条的用户消息且超过省略阈值时，换成
 * 「已省略 + 原文字符数 + 开头一小段预览」——原文并未丢失，仍在真实历史里，省的只是调试载荷。
 * 多模态数组里的图片与文件只留体积摘要，其余 part 深拷贝一份，免得调试面板改到真实历史。
 */
function serializeDebugContent(
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
        image: summarizeBinaryValue(record.image),
      }

    if (record.type === 'file' && isPresent(record.data))
      return {
        ...record,
        data: summarizeBinaryValue(record.data),
      }

    return JSON.parse(JSON.stringify(part))
  })
}

/**
 * 把本轮历史整理成调试面板看的消息快照：先滤掉内部追问消息（它们不是对话的一部分），
 * 再逐条整理正文。`turn > 1` 时才对较早的用户消息做省略，所以同一条消息在第一轮完整、重复轮被截短。
 */
function serializeDebugMessages(
  history: ModelMessage[],
  turn: number
): StreamTurnContextPayload['messages'] {
  const visibleHistory = history.filter((message) => !isInternalFollowUpMessage(message))

  return visibleHistory.map((message, index) => ({
    role: message.role,
    content: serializeDebugContent(message.content, {
      role: message.role,
      repeatedTurn: turn > 1,
      // 历史轮用户消息在重复调试导出时截断，避免载荷体积过大。
      isHistoricalMessage: index < visibleHistory.length - 1,
    }),
  }))
}

/**
 * 组装一轮的调试上下文载荷：角色解析结果、系统提示词与片段、本轮可见工具与类别、消息快照与各路遥测。
 *
 * 可见工具按 `allowedTools` 过滤（不给就等于全部可见）；可见类别取编码会话本轮的动态开关，再按角色、
 * 能力作用域与能力端口过一遍准入，所以它反映的是"现在真的能用"，不是"注册过"。
 * 只供调试面板展示，不参与模型推理本身。
 */
export function buildTurnContextPayload({
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
    messages: serializeDebugMessages(history, turn),
    allowedTools: visibleTools,
    enabledToolCategories: visibleCategories,
    contextPhaseTelemetry,
    toolSchemaTelemetry: toNullable(toolSchemaTelemetry),
    runProfileTelemetry: toNullable(runProfileTelemetry),
    toolAllocatorTelemetry: toNullable(toolAllocatorTelemetry),
    turnPlanningTelemetry: toNullable(turnPlanningTelemetry),
  }
}
