import { isEmpty, isPlainObject } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ToolCategoryId } from '../../types/agent.js'
import type { AnyVelaTool, ToolArgsValidationResult, ToolExecutionPolicyContext, ToolExecutionPolicySurface } from '../../types/tools.js'
import { getToolSurfaceFallbackChain } from '../runner/runtime-profiles'

import { describeAdjustments, validateWithNormalization } from './tool-args-schema-validator'

/**
 * 选这次调用该用工具的哪一张表面（surface）。
 *
 * 本轮注入给模型的就是某一张表面：上下文明说了用 `base` 就返回 null（走工具原生 schema），
 * 明说了别的就用那张；没说时按当前运行档的回落链找第一张工具真的提供了的表面，一张都没有返回 null。
 */
export function resolveToolSurface(
  tool: AnyVelaTool,
  context: ToolExecutionPolicyContext,
  toolName: string
): LooseOptional<ToolExecutionPolicySurface<any, any>> {
  const visibleSurfaceProfile = context.getCurrentVisibleToolSurfaceProfile(toolName)
  if (visibleSurfaceProfile === 'base') return null
  if (visibleSurfaceProfile) return tool.surfaces![visibleSurfaceProfile]!

  const activeProfile = context.codingSession.getToolSurfaceProfile()
  for (const profileId of getToolSurfaceFallbackChain(activeProfile)) {
    const surface = tool.surfaces?.[profileId]
    if (surface) return surface
  }

  return null
}

/**
 * 校验并归一化这次调用的参数，返回真正会拿去执行的那份。
 *
 * 没选表面时直接按工具原生 schema 校验。选了表面就走两段：先按表面 schema 校，过了再经表面的
 * `normalize` 折算成底层参数，最后仍按工具原生 schema 校一遍——底层这关不过照样算失败。
 * 两段都过时把「模型原样请求的参数」与「归一化后的差异清单」一并带回，供回显与历史收敛使用。
 */
export function validateAndNormalizeToolInput(input: {
  tool: AnyVelaTool
  selectedSurface?: LooseOptional<ToolExecutionPolicySurface<any, any>>
  args?: Record<string, unknown>
  toolContext: ToolExecutionPolicyContext
}): ToolArgsValidationResult<any> {
  const selectedSurface = input.selectedSurface
  if (!selectedSurface) return validateWithNormalization(input.tool.schema, input.args)

  const surfaceResult = validateWithNormalization(
    selectedSurface.schema,
    input.args
  )
  if (!surfaceResult.success) return surfaceResult

  const normalizedInput = selectedSurface.normalize
    ? selectedSurface.normalize(surfaceResult.data, input.toolContext)
    : surfaceResult.data
  const baseArgs = isPlainObject(normalizedInput) ? normalizedInput : {}
  const baseResult = validateWithNormalization(input.tool.schema, baseArgs)
  if (!baseResult.success) return baseResult

  const requestedArgs = surfaceResult.requestedArgs
  const adjustments = describeAdjustments(
    requestedArgs,
    baseResult.args
  )

  return {
    ...baseResult,
    requestedArgs,
    normalized: !isEmpty(adjustments),
    adjustments,
  }
}

/**
 * 计划模式对这次工具执行的判定。当前判决是「计划模式不限制工具执行」——两条路都放行，
 * 只用 reason 说明放行的依据，保留这个判定点是为了以后收紧时有唯一落点。
 */
export function evaluatePlanningModeToolPolicy(
  toolContext: ToolExecutionPolicyContext
): { allowed: boolean; reason: string } {
  if (!toolContext.planningMode) return {
      allowed: true,
      reason: 'planning mode is off',
    }

  return {
    allowed: true,
    reason: 'planning mode does not restrict tool execution',
  }
}

/** 生成会话级工具类别授权卡片文案：说清授权范围是整会话的同类工具，以及拒绝时可以填原因。 */
export function formatSessionToolApprovalMessage(input: {
  toolName: string
  categoryId: ToolCategoryId
  categoryLabel: string
}): string {
  return [
    '工具授权请求',
    `类型：${input.categoryLabel}`,
    `工具：${input.toolName}`,
    `授权范围：当前会话内的全部 ${input.categoryLabel} 工具`,
    '同意后，本会话内同类工具不再重复询问。',
    '拒绝时可以填写原因；留空时模型会自行决定追问、结束或跳过。',
  ].join('\n')
}

/**
 * 为单个工具调用派生上下文：换上这次调用的 toolCallId、独立 abortSignal、工具专属日志 tag，
 * 以及本次调用的进度/元数据回调（不给就沿用父上下文的）。
 * 用 `Object.create` 挂在父上下文的原型链上——查询上下文的宿主端口是从冻结的父上下文继承来的，这条链不能断。
 */
export function createToolContext(
  baseContext: ToolExecutionPolicyContext,
  toolCallId: string,
  toolName: string,
  abortSignal: AbortSignal,
  emitProgress?: (chunk: string) => void,
  updateMetadata?: (payload: { title?: string; metadata?: Record<string, unknown> }) => void
): ToolExecutionPolicyContext {
  return Object.create(baseContext, {
    toolCallId: { value: toolCallId, enumerable: true },
    abortSignal: { value: abortSignal, enumerable: true },
    log: { value: logRuntime.tag(`Tool:${toolName}`), enumerable: true },
    emitProgress: { value: emitProgress ?? baseContext.emitProgress, enumerable: true },
    updateMetadata: { value: updateMetadata ?? baseContext.updateMetadata, enumerable: true },
  })
}
