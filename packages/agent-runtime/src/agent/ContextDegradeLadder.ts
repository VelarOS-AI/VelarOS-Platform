/**
 * 上下文溢出降级阶梯（OOM 优雅降级）。
 *
 * 当模型因上下文超限报错——相当于操作系统的“缺页 / OOM”——单纯重试无意义，
 * 必须沿一条由轻到重的阶梯逐级释放压力，每一级都比上一级更激进，
 * 直到请求能被接受；若所有级别都用尽仍无法恢复，则“优雅终止”而非裸崩。
 *
 * 阶梯（数字越大越激进）：
 *  1. semantic-compact —— 用一次模型调用把较老历史压成语义摘要（比规则摘要更紧致）。
 *  2. compact-soft     —— 语义压缩不可用/无收益时，应急压缩历史到较温和目标。
 *  3. compact-hard     —— 应急压缩到更激进目标（牺牲更多历史细节）。
 *  4. narrow-tools     —— 把工具暴露收窄到最紧档（compact），释放工具分区。
 *  5. drop-history     —— 仅保留最近用户消息的兜底历史（丢弃几乎全部历史）。
 *  6. surrender        —— 阶梯耗尽，优雅终止本次执行并向用户说明。
 *
 * 本模块只描述“在第 N 次缺页时应采取哪种动作”的纯策略；具体执行（压缩、改工具、
 * 重建历史、终止）由调用方（SoloLoop / QueryLoop）落地。
 */

export type ContextDegradeActionKind =
  | 'compact-soft'
  | 'compact-hard'
  | 'semantic-compact'
  | 'narrow-tools'
  | 'drop-history'
  | 'surrender'

export interface ContextDegradeAction {
  kind: ContextDegradeActionKind
  /** 当前处于阶梯第几级（从 1 开始）。 */
  level: number
  /** 压缩类动作的历史降级级别参考值；compactHistory 当前会最大化回收。 */
  targetPercent?: number
  /** 收窄工具时降到的运行档（仅 narrow-tools 有意义）。 */
  narrowToProfile?: 'compact'
}

/** 应急压缩的温和级别参考值。 */
export const SoftCompactionTargetPercent = 60
/** 应急压缩的激进级别参考值。 */
export const HardCompactionTargetPercent = 35

/**
 * 完整阶梯（solo 链路：工具可收窄）。
 */
const SoloDegradeStaircase: readonly ContextDegradeAction[] = [
  { kind: 'semantic-compact', level: 1 },
  { kind: 'compact-soft', level: 2, targetPercent: SoftCompactionTargetPercent },
  { kind: 'compact-hard', level: 3, targetPercent: HardCompactionTargetPercent },
  { kind: 'narrow-tools', level: 4, narrowToProfile: 'compact' },
  { kind: 'drop-history', level: 5 },
  { kind: 'surrender', level: 6 },
]

/**
 * 子代理阶梯（query 链路：无运行档工具暴露，跳过 narrow-tools）。
 */
const QueryDegradeStaircase: readonly ContextDegradeAction[] = [
  { kind: 'semantic-compact', level: 1 },
  { kind: 'compact-soft', level: 2, targetPercent: SoftCompactionTargetPercent },
  { kind: 'compact-hard', level: 3, targetPercent: HardCompactionTargetPercent },
  { kind: 'drop-history', level: 4 },
  { kind: 'surrender', level: 5 },
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
