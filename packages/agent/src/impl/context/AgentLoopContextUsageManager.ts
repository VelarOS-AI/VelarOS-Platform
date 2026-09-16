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

import { isFiniteNumber, isNumber } from '@velaros-ai/core'

import type { AgentModelRequestOptions } from '../../contract/requires.js'
import type { ContextUsageEstimate } from '../../types/agent.js'
import type { AgentLoopToolRegistry, EstimateContextUsageOptions } from '../../types/context.js'
import {
  DefaultContextSafetyMarginPercent,
  resolveReservedOutputTokens,
} from '../../utils/context/context-budget'
import { estimateContextUsage, sumToolSchemaChars } from '../../utils/context/context-usage'
import { AgentTuning } from '../../utils/tuning'

import { ContextUsageCalibrator } from './ContextUsageCalibrator'

/** 本轮显式输出上限与实际请求策略同源，覆盖按窗口比例推导的缺省预留。 */
function resolveModelContextUsageOptions(
  options: EstimateContextUsageOptions = {},
  modelRequestOptions?: LooseOptional<AgentModelRequestOptions>
): EstimateContextUsageOptions {
  const maxOutputTokens = modelRequestOptions?.requestPolicy?.maxOutputTokens
  if (!isFiniteNumber(maxOutputTokens) || maxOutputTokens < 0) return options
  return { ...options, reservedOutputTokens: maxOutputTokens }
}

/**
 * 回合级上下文用量估算器：组装每轮预算判断要用的 `EstimateContextUsageOptions`，并把真实用量回灌给校准器。
 *
 * 由 SoloLoop / QueryLoop 各构造一份长期持有（它按会话/循环攥着那份 `ContextUsageCalibrator`，
 * 学习才能跨请求累积）。不改写历史、不做治理判决——那是驻留账本与 `GovernanceEpoch` 的事。
 */
export interface AgentLoopContextUsageManagerApi<TToolContext> {
  /** 估一组消息在指定模型下的用量；纯计算，不碰历史。传进来的 options 要与真正发出去那次请求同源，否则校准对不上账。 */
  estimateUsage(
    model: string,
    systemPrompt: string,
    history: readonly ModelMessage[],
    options: EstimateContextUsageOptions
  ): ContextUsageEstimate
  /** 用供应方回传的真实 input tokens 校准该模型的估算系数；两个数任一缺席或不是数字就整条样本丢掉，不学。 */
  recordActualUsage(
    model: string,
    predictedInputTokens: LooseOptional<number>,
    actualInputTokens: Nullable<number>
  ): void
  /**
   * 组装本轮估算入参：工具清单 + 工具 schema 字节预留 + 输出预留 + 当前校准系数。
   * schema 预留优先用调用方给的实测表，缺项时退到注册表的实测接口，都没有才按「工具数 × 800」估；
   * 输出预留按有效窗口推导，本轮显式给了 `maxOutputTokens` 时以它为准。
   * `turnToolRegistry` 不传就用构造时那份，本轮临时换过工具表的场合才需要显式传。
   */
  buildContextUsageOptions(
    model: string,
    toolContext: TToolContext,
    allowedTools: string[],
    contextWindow?: number,
    toolSchemaChars?: Readonly<Record<string, number>>,
    turnToolRegistry?: AgentLoopToolRegistry<TToolContext>,
    modelRequestOptions?: LooseOptional<AgentModelRequestOptions>
  ): EstimateContextUsageOptions
}

class AgentLoopContextUsageManager<TToolContext> implements AgentLoopContextUsageManagerApi<TToolContext> {
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
      sumToolSchemaChars(allowedTools, toolSchemaChars) ??
      turnToolRegistry.estimateToolsSerializedChars?.(toolContext, allowedTools) ??
      tools.length * 800
    // 输出预留按“有效窗口”推导：优先用 runtime 解析出的 contextWindow，否则回落模型目录值。
    const effectiveWindow = isNumber(contextWindow)
      ? contextWindow
      : AgentTuning.loop.unknownContextWindowTokens
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
}

export { AgentLoopContextUsageManager, resolveModelContextUsageOptions }
