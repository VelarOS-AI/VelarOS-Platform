// LoopWindDownGuard 用到的纯函数（不碰实例状态）。
import type { LoopTurnVerdict } from '../../types/loop.js'

/**
 * Loop 装配面契约（B5 单引擎双面）。
 *
 * `AgentLoop`（runAgentLoop）是全内核唯一的 agent 循环引擎；主 agent 面（SoloStreamLoop）与
 * 子 agent 面（QueryLoop）都只是对这份契约的装配：
 * - 主面 = UI 投影 / turn 轴 / goal 生命周期 / handoff 信号 / 自动验证收尾门；
 * - 子面 = 无 UI / turn:null 轴 / 结构化输出 / 软上限（时间轴）/ usage 回传。
 *
 * 四类护栏（轮次上限 / 上下文治理触发 / 中止 / 异常收敛）机制单源在引擎侧
 * （本文件的 {@link LoopWindDownGuard} + AgentLoop 的溢出恢复与 turn span 收敛），
 * 面只提供文案、日志与收敛动作——装配差异是真差异要保，机制分裂是形态债要禁。
 */

export function loopContinue<TFinish>(): LoopTurnVerdict<TFinish> {
  return { kind: 'continue' }
}

/** 构造一个「本轮到此收敛」的裁决，带上最终结果。 */
export function loopFinish<TFinish>(value: TFinish): LoopTurnVerdict<TFinish> {
  return { kind: 'finish', value }
}
