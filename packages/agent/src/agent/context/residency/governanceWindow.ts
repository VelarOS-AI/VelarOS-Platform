/**
 * 治理窗口 G 的推导 —— **与送核门同一把尺子**（v3 审计 #4 / §16.5 挂账「量纲统一」）。
 *
 * 病灶：治理器量的是账本投影正文，分母取「模型窗口与 cap 的较小者」；送核门量的是实测用量
 * （连系统提示词、工具清单、活动尾一起算），分母是扣过输出预留与安全余量的可用窗口。
 * 分子少一大块、分母大一整块，两头朝同一个方向偏，于是**治理器总在撞门之后才醒**——
 * 门先红，epoch 才想起来该跑，而 B1 起送核门已经没有回收阶梯兜底了。
 *
 * 判决：G 改成「账本正文在门红线之前还剩多少额度」。推导、对账数学与 cap 的新角色，
 * 逐条写在 {@link resolveGovernanceWindow} 上。
 */
import { isFiniteNumber } from '@velaros-ai/core'

import { ContextUsageCompactionPercent, resolveContextUsageWindow } from '../contextUsage'

import type { ContextGovernanceConfig } from './governanceConfig'

/**
 * 账本额度相对送核门余量的折扣系数。
 *
 * 它买的是两样确定存在、但在治理时刻还量不出来的东西：
 *  ① **治理之后才产出的活动尾块**（context-dashboard、retained-context）——它们按定义排在投影
 *     之后，编译期算固定开销时还不存在；
 *  ② **两把尺子的残差**——账本按"投影正文字符 ÷ 实测密度"折算，送核门按序列化 JSON 实测 token，
 *     密度是全历史平均值，逐段落必然有偏差。
 *
 * 同时它也是「严格小于」的来源：`epochTriggerPercent` 可以被配到 100，没有这个折扣时
 * 触发线会与门红线重合（等号成立即"同时醒"，等于没醒）。
 */
export const GovernanceHeadroomRatio = 0.9

/** G 的地板：固定开销已经撑破送核门时的退化取值（治理器每轮必开）。 */
export const MinGovernanceWindowTokens = 1

export interface GovernanceWindowInput {
  /** 模型上下文窗口 W；缺席时按 `estimateContextUsage` 的同一默认值（128K）处理。 */
  modelWindowTokens?: LooseOptional<number>
  /** 输出预留；与送核门同参。 */
  reservedOutputTokens?: LooseOptional<number>
  /** 安全余量百分比；与送核门同参。 */
  safetyMarginPercent?: LooseOptional<number>
  /**
   * 固定开销（token）：系统提示词 + 工具清单/schema + 稳定前缀 + 活动尾。
   *
   * 缺席按 0 处理 —— 那等价于"只有账本正文要发出去"，是宿主没给开销信息时唯一诚实的假设，
   * 此时 G 仍然被门的红线约束住（headroom = sendGate），不会退回旧的 min(W, cap)。
   */
  fixedOverheadTokens?: LooseOptional<number>
}

export interface GovernanceWindowDerivation {
  /** 模型窗口 W（归一后）。 */
  contextWindow: number
  /** 送核门可用窗口：floor(W×(1−safety%)) − 输出预留。 */
  usableContextWindow: number
  /** 送核门红线（token）：估算达到此值即 `okToSend=false`。 */
  sendGateLimitTokens: number
  /** 账本正文之外、但门要算的固定开销（token）。 */
  fixedOverheadTokens: number
  /** 红线之下留给账本正文的额度（可能为负 = 开销本身已撑破门）。 */
  headroomTokens: number
  /** 治理窗口 G（token）——`epochTriggerPercent/epochTargetPercent` 的分母。 */
  windowTokens: number
  /** G 由谁定的：门余量 / cap 上限 / 地板（开销撑破门）。 */
  source: 'send-gate' | 'cap' | 'floor'
}

/**
 * 治理窗口 G 的单源推导。
 *
 * ## 推导
 * ```
 * usable   = resolveContextUsageWindow(...).usableContextWindow    // 与送核门逐字同源
 * sendGate = floor(usable × ContextUsageCompactionPercent / 100)   // 门的红线
 * headroom = sendGate − fixedOverheadTokens                        // 红线之下留给账本正文的额度
 * G        = min(cap, max(1, floor(headroom × GovernanceHeadroomRatio)))
 * ```
 * `fixedOverheadTokens` = 系统提示词 + 工具清单/schema + 稳定前缀 + 活动尾，即**账本不管、
 * 但门要算**的那一段。于是 G 的语义从"模型窗口"改成"账本正文在门红之前还剩多少额度"；
 * `epochTriggerPercent` / `epochTargetPercent` 仍然是"占 G 的百分比"（配置语义与默认值一克不动），
 * 变的只是 G 怎么来。
 *
 * ## 对账数学（{@link governanceWakesBeforeSendGate} 机械成立）
 * 任意配置组合下 `固定开销 + 触发线 < 门红线`——账本正文一旦涨到治理触发线，请求**仍在门内**，
 * 治理器必然先于撞门醒来。证明是构造性的：触发百分比不超过 100，故触发线 ≤ G ≤
 * `floor(headroom × ratio) < headroom`（ratio 严格小于 1）。唯一的例外是 `headroom ≤ 0`
 * ——**固定开销本身就撑破了门**，这时任何账本内容都发不出去，G 落到地板 1、治理器每轮必开
 * （`source: 'floor'`），出路是转交而不是继续压（设计 §4）。
 *
 * ## cap 的角色
 * `cap`（默认 200K）仍是 G 的**上限**：1M 窗口下余量远大于 cap，G 仍锁在 200K，
 * 「治理窗口取模型窗口与 200K 的较小者」这条既有产品裁决继续成立；
 * 200K 窗口下咬合的才是门余量。
 */
export function resolveGovernanceWindow(
  config: ContextGovernanceConfig,
  input: GovernanceWindowInput = {}
): GovernanceWindowDerivation {
  const window = resolveContextUsageWindow({
    contextWindow: input.modelWindowTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMarginPercent: input.safetyMarginPercent,
  })
  const sendGateLimitTokens = Math.max(
    1,
    Math.floor((window.usableContextWindow * ContextUsageCompactionPercent) / 100)
  )
  const fixedOverheadTokens =
    isFiniteNumber(input.fixedOverheadTokens) && input.fixedOverheadTokens > 0
      ? Math.floor(input.fixedOverheadTokens)
      : 0
  const headroomTokens = sendGateLimitTokens - fixedOverheadTokens
  const discounted = Math.floor(headroomTokens * GovernanceHeadroomRatio)
  const cap = Math.max(1, Math.floor(config.cap))
  const windowTokens = Math.max(MinGovernanceWindowTokens, Math.min(cap, discounted))
  const source: GovernanceWindowDerivation['source'] =
    discounted < MinGovernanceWindowTokens ? 'floor' : discounted > cap ? 'cap' : 'send-gate'

  return {
    contextWindow: window.contextWindow,
    usableContextWindow: window.usableContextWindow,
    sendGateLimitTokens,
    fixedOverheadTokens,
    headroomTokens,
    windowTokens,
    source,
  }
}

/** 治理窗口 G（token）——只要数字不要推导过程时的便捷式。 */
export function resolveGovernanceWindowTokens(
  config: ContextGovernanceConfig,
  input: GovernanceWindowInput = {}
): number {
  return resolveGovernanceWindow(config, input).windowTokens
}

/**
 * 对账断言：治理触发线**严格落在**送核门红线之下。
 *
 * 返回 false 只有一种合法解释——固定开销本身就 ≥ 门红线（`source: 'floor'`），
 * 这时没有任何账本内容能被发出去，治理器已经退化成"每轮必开"。
 */
export function governanceWakesBeforeSendGate(
  config: ContextGovernanceConfig,
  derivation: GovernanceWindowDerivation
): boolean {
  const triggerTokens = (config.epochTriggerPercent / 100) * derivation.windowTokens
  return derivation.fixedOverheadTokens + triggerTokens < derivation.sendGateLimitTokens
}
