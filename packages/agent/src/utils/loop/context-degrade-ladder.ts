/**
 * 上下文溢出降级阶梯（OOM 优雅降级）。
 *
 * 当模型因上下文超限报错——相当于操作系统的“缺页 / OOM”——单纯重试无意义，
 * 必须沿一条由轻到重的阶梯逐级释放压力，每一级都比上一级更激进，
 * 直到请求能被接受；若所有级别都用尽仍无法恢复，则“优雅终止”而非裸崩。
 *
 * 阶梯（数字越大越激进）：
 *  1. govern-epoch —— 请求治理器强开一次 epoch（I0 逐出 + I1 骨架），把投影压回目标水位。
 *  2. narrow-tools —— 把工具暴露收窄到最紧档（compact），释放工具分区。
 *  3. surrender    —— 阶梯耗尽，优雅终止本次执行并向用户说明。
 *
 * ## 治理 v2 后为什么只剩三级
 * v1 的 `semantic-compact` / `compact-soft` / `compact-hard` 是压缩机器的三个档位，机器已整台拆除；
 * 三档的职责收敛成一次 epoch（epoch 内部自带 I0→I1 的器械序、反空转与达标即停，不需要调用方分档）。
 * `drop-history`（只留最近一条 user 消息的兜底集）**按设计裁决删除**：尾保护是投影级硬不变量，
 * 不设旁路，极端压力的出路是转交（handoff）而不是压尾（v2 设计 §11 裁决 5）。
 *
 * 本模块只描述“在第 N 次缺页时应采取哪种动作”的纯策略；具体执行（开 epoch、改工具、终止）
 * 由调用方（SoloLoop / QueryLoop）落地。
 */

export type ContextDegradeActionKind =
  | 'govern-epoch'
  | 'narrow-tools'
  | 'surrender'

export interface ContextDegradeAction {
  kind: ContextDegradeActionKind
  /** 当前处于阶梯第几级（从 1 开始）。 */
  level: number
  /** 收窄工具时降到的运行档（仅 narrow-tools 有意义）。 */
  narrowToProfile?: 'compact'
}

/**
 * 完整阶梯（solo 链路：工具可收窄）。
 */
const SoloDegradeStaircase: readonly ContextDegradeAction[] = [
  { kind: 'govern-epoch', level: 1 },
  { kind: 'narrow-tools', level: 2, narrowToProfile: 'compact' },
  { kind: 'surrender', level: 3 },
]

/**
 * 子代理阶梯（query 链路：无运行档工具暴露，跳过 narrow-tools）。
 */
const QueryDegradeStaircase: readonly ContextDegradeAction[] = [
  { kind: 'govern-epoch', level: 1 },
  { kind: 'surrender', level: 2 },
]

export type ContextDegradeChain = 'solo' | 'query'

/**
 * 取第 attempt 次缺页（从 0 开始计数）应采取的降级动作。
 * 超出阶梯长度时一律返回 surrender，保证调用方永远能拿到“收口”动作。
 */
export function resolveContextDegradeAction(
  chain: ContextDegradeChain,
  attempt: number,
): ContextDegradeAction {
  const staircase = chain === 'solo' ? SoloDegradeStaircase : QueryDegradeStaircase
  const index = Math.max(0, Math.floor(attempt))
  return staircase[index] ?? staircase[staircase.length - 1]
}

/** 阶梯总级数（不含越界回退）。 */
export function contextDegradeStaircaseLength(chain: ContextDegradeChain): number {
  return chain === 'solo' ? SoloDegradeStaircase.length : QueryDegradeStaircase.length
}
