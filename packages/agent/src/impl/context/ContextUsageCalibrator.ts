/**
 * 上下文用量校准器（MMU 反馈闭环）。
 *
 * 本地 `token` 估算（`tiktoken` / 启发式）与供应方真实计费口径存在系统性偏差：
 * 不同模型的特殊 `token`、消息包装、工具 `schema` 序列化方式都会让估算偏高或偏低。
 * 没有反馈时，这个偏差会一直累积——估算 80% 实际可能已经 100%（撞墙），
 * 或估算 90% 实际才 70%（过早压缩、浪费窗口）。
 *
 * 校准器在每轮拿到供应方真实输入 `token` 后，按“真实 / 预测”的残差，
 * 对每个模型维护一个乘性校准系数（`EMA` 平滑 + 夹值）。下一轮估算会乘上该系数，
 * 使估算逐步贴近真实用量。这相当于操作系统用真实页表使用情况校准内存核算。
 *
 * 设计要点：
 * - 残差基于“已乘过旧系数的预测值”计算，因此系数会自我收敛（`predicted = base * factor`，
 *   `factor *= 残差` 的 `EMA` 之后，`base * factor` 收敛到真实值），无需保存原始未校准估算。
 * - 系数夹在 `[MinFactor, MaxFactor]`，避免异常用量样本把估算带偏。
 * - 进程内、按模型隔离；不持久化（每次启动重新学习，几轮即可收敛）。
 */

import { clamp, isFiniteNumber } from '@velaros-ai/core'

import { AgentTuning } from '../../utils/tuning'

/** 没有任何样本时的初始系数；值在 `AgentTuning.calibration.defaultFactor`。 */
export const DefaultCalibrationFactor: number = AgentTuning.calibration.defaultFactor
/** 系数下界；值在 `AgentTuning.calibration.minFactor`。 */
export const MinCalibrationFactor: number = AgentTuning.calibration.minFactor
/** 系数上界；值在 `AgentTuning.calibration.maxFactor`。 */
export const MaxCalibrationFactor: number = AgentTuning.calibration.maxFactor

/**
 * 上下文用量校准器：用供应方回传的真实 input tokens 校准本地估算，按模型各学一套系数。
 *
 * 由 `AgentLoopContextUsageManager` 按循环持有一份，学习跨回合累积；只在进程内，不持久化，
 * 重启后几轮即可重新收敛。样本不合法（模型名为空、数值非有限或非正）时整条样本丢弃，系数不动。
 */
export interface ContextUsageCalibratorApi {
  /** 取某模型当前的校准系数，估算时乘上它；没学过或模型名为空时返回 1（等于不校准）。 */
  getFactor(model: string): number
  /**
   * 拿一轮的「估算值 vs 真实值」更新该模型的系数：残差先夹在 [0.25, 4] 以免单个异常样本带偏，
   * 再按 EMA 朝 `当前系数 × 残差` 移动，最后把系数夹在 [0.5, 3]。
   * 传入的估算值必须是**已经乘过旧系数**的那份，系数才会自我收敛。
   */
  record(model: string, predictedInputTokens: number, actualInputTokens: number): void
  /** 清空已学到的全部系数，回到「都不校准」的初始态；给测试与诊断用，正常链路不调。 */
  reset(): void
}

class ContextUsageCalibrator implements ContextUsageCalibratorApi {
  private readonly factorByModel = new Map<string, number>()

  /** 返回某模型当前的校准系数；未学习过时为 1。 */
  public getFactor(model: string): number {
    if (!model) return DefaultCalibrationFactor

    return this.factorByModel.get(model) ?? DefaultCalibrationFactor
  }

  /**
   * 用一次真实用量更新某模型的校准系数。
   *
   * @param predictedInputTokens 本轮我们估算（已乘旧系数）的输入 token 数。
   * @param actualInputTokens 供应方返回的真实输入 token 数。
   */
  public record(model: string, predictedInputTokens: number, actualInputTokens: number): void {
    if (
      !model ||
      !isFiniteNumber(predictedInputTokens) ||
      !isFiniteNumber(actualInputTokens) ||
      predictedInputTokens <= 0 ||
      actualInputTokens <= 0
    ) return

    // 残差先夹住，单个异常样本不会让系数瞬间跳变。
    const residual = clamp(
      (actualInputTokens / predictedInputTokens),
      AgentTuning.calibration.minResidual,
      AgentTuning.calibration.maxResidual
    )
    const current = this.getFactor(model)
    // 线性 EMA：朝着 current * residual 的目标移动，避免单样本跳变。
    const target = current * residual
    const next = clamp((current + AgentTuning.calibration.learningRate * (target - current)), MinCalibrationFactor, MaxCalibrationFactor)
    this.factorByModel.set(model, next)
  }

  /** 测试/诊断用：清空已学习的系数。 */
  public reset(): void {
    this.factorByModel.clear()
  }
}

export { ContextUsageCalibrator }
