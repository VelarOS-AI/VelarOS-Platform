/**
 * 回合级上下文用量估算器（MMU 校准闭环的家）。
 *
 * 本文件的前身是 `LoopHistory.ts` 的 `AgentLoopHistoryManager`——v1 压缩机器在执行循环里的门面
 * （规则压缩 / 语义压缩 / 预摘要缓存 / 预测式触发 / 缺页应急压缩 / fallback 历史）。上下文治理 v2
 * 把这些整套判决收进驻留账本与 `GovernanceEpoch`（唯一治理点，编译期投影），循环层不再改写历史，
 * 于是这里只剩两件与治理无关的事：
 *
 *  1. **组装 `EstimateContextUsageOptions`**：工具清单 + schema 字节预留 + 输出预留 + 校准系数；
 *     这是每轮请求做预算判断的入参单源（治理器也吃它算出来的窗口）。
 *  2. **MMU 反馈**：拿供应方回传的真实 input tokens 校准本模型的估算系数，跨轮累积。
 *
 * 因此它按会话/循环长期持有一份 `ContextUsageCalibrator`——SoloLoop / QueryLoop 各构造一次后复用，
 * 学习才能跨请求累积。
 */
import type { ModelMessage } from 'ai'

import {
  DefaultContextSafetyMarginPercent,
  resolveReservedOutputTokens,
} from '@velaros-ai/agent'
import {
  type ContextUsageEstimate,
  estimateContextUsage,
  type EstimateContextUsageOptions,
} from '@velaros-ai/agent'
import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { isFiniteNumber, isNumber } from '@velaros-ai/core'

import type { AgentModelRequestOptions } from './model/ModelContracts'
import { ContextUsageCalibrator } from './ContextUsageCalibrator'

const DefaultAgentContextWindow = 128_000

/** 本轮显式输出上限与实际请求策略同源，覆盖按窗口比例推导的缺省预留。 */
function resolveModelContextUsageOptions(
  options: EstimateContextUsageOptions = {},
  modelRequestOptions?: LooseOptional<AgentModelRequestOptions>
): EstimateContextUsageOptions {
  const maxOutputTokens = modelRequestOptions?.requestPolicy?.maxOutputTokens
  if (!isFiniteNumber(maxOutputTokens) || maxOutputTokens < 0) return options
  return { ...options, reservedOutputTokens: maxOutputTokens }
}

interface AgentLoopToolDescriptor {
  name: string
  description: string
  categoryId?: LooseOptional<ToolCategoryId>
}

interface AgentLoopToolRegistry<TToolContext> {
  listAvailable(toolContext: TToolContext, allowedTools: string[]): AgentLoopToolDescriptor[]
  /**
   * 可选实现：返回当前可见工具集 JSON Schema 总字节数（含 name/description/wrapper）。
   * 提供时用它精确扣留上下文预算；缺省时回落到 `tools.length * 800` 启发值。
   */
  estimateToolsSerializedChars?(toolContext: TToolContext, allowedTools: string[]): number
}

class AgentLoopContextUsageManager<TToolContext> {
  /**
   * MMU 校准器：跨轮、按模型学习"估算↔真实"偏差。
   * 由本管理器持有；SoloLoop/QueryLoop 在 Runtime 中各构造一次后长期复用，因此学习可跨请求累积。
   */
  private readonly calibrator = new ContextUsageCalibrator()

  constructor(private readonly toolRegistry: AgentLoopToolRegistry<TToolContext>) {}

  /**
   * 指定消息集的用量估算（纯函数，不改写历史）。
   * 运行校准采用同一次 provider 请求编译后的估算，与真实 usage 对账。
   */
  public estimateUsage(
    model: string,
    systemPrompt: string,
    history: readonly ModelMessage[],
    options: EstimateContextUsageOptions
  ): ContextUsageEstimate {
    return estimateContextUsage(model, systemPrompt, [...history], options)
  }

  /** 用供应方真实输入 token 更新该模型的校准系数（MMU 反馈闭环）。 */
  public recordActualUsage(
    model: string,
    predictedInputTokens: LooseOptional<number>,
    actualInputTokens: Nullable<number>
  ): void {
    if (!isNumber(predictedInputTokens) || !isNumber(actualInputTokens)) return

    this.calibrator.record(model, predictedInputTokens, actualInputTokens)
  }

  public buildContextUsageOptions(
    model: string,
    toolContext: TToolContext,
    allowedTools: string[],
    contextWindow?: number,
    toolSchemaChars?: Readonly<Record<string, number>>,
    turnToolRegistry: AgentLoopToolRegistry<TToolContext> = this.toolRegistry,
    modelRequestOptions?: LooseOptional<AgentModelRequestOptions>
  ): EstimateContextUsageOptions {
    const tools = turnToolRegistry.listAvailable(toolContext, allowedTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      categoryId: tool.categoryId,
    }))
    // 优先用 registry 提供的精确测量（按 zod -> JSON Schema 实测，结果带缓存）；
    // 缺省时回落到旧版 `工具数 × 800` 平均估算，保持兼容。
    const schemaReserveChars =
      this.sumToolSchemaChars(allowedTools, toolSchemaChars) ??
      turnToolRegistry.estimateToolsSerializedChars?.(toolContext, allowedTools) ??
      tools.length * 800
    // 输出预留按“有效窗口”推导：优先用 runtime 解析出的 contextWindow，否则回落模型目录值。
    const effectiveWindow = isNumber(contextWindow)
      ? contextWindow
      : DefaultAgentContextWindow
    const reservedOutputTokens = resolveReservedOutputTokens(effectiveWindow)

    return resolveModelContextUsageOptions({
      contextWindow,
      extraContext: {
        tools,
      },
      extraEstimatedChars: schemaReserveChars,
      extraEstimatedTokens: Math.ceil(schemaReserveChars / 4),
      reservedOutputTokens,
      safetyMarginPercent: DefaultContextSafetyMarginPercent,
      calibrationFactor: this.calibrator.getFactor(model),
    }, modelRequestOptions)
  }

  private sumToolSchemaChars(
    allowedTools: readonly string[],
    toolSchemaChars?: Readonly<Record<string, number>>
  ): Nullable<number> {
    if (!toolSchemaChars) return null

    let total = 0
    for (const toolName of allowedTools) {
      if (!Object.prototype.hasOwnProperty.call(toolSchemaChars, toolName)) return null
      total += Math.max(0, toolSchemaChars[toolName] ?? 0)
    }

    return total
  }
}

export { AgentLoopContextUsageManager, resolveModelContextUsageOptions }
export type { AgentLoopToolDescriptor, AgentLoopToolRegistry }
