/**
 * 包内的工作类型：算到一半的中间形状，不出包。
 */
import type { VerifierRegistryApi } from '../contract/provides.js'

import type {
  JourneySpec,
  LegSpec,
  LoopThresholds,
  Observation,
  RealTaskFinding,
  RunArchive,
  RunArchiveView,
  SessionHandle,
  SettleOutcome,
  TrialSpec,
} from './agent-lab.js'

/** 看门狗的一个信号：哪个探测器、哪把钥匙、数到几、到几就掐、掐的时候说什么。 */
export interface WatchdogSignal {
  readonly detectorId: string
  readonly key: string
  readonly count: number
  readonly abortAt: number
  readonly reason: string
}

/** 内置探测器定型后的设置：阈值补齐，两份工具名单也补成实实在在的数组。 */
export interface ResolvedDetectorSettings {
  readonly thresholds: LoopThresholds
  readonly catalogToolNames: readonly string[]
  readonly interactiveToolNames: readonly string[]
}

/** 一段判完之后的分数：加权得分与是否通过；判不了就是未知。 */
export interface LegScore {
  readonly score: number | null
  readonly passed: boolean | null
}

/** 判一段要用到的全部东西。 */
export interface VerifyLegInput {
  readonly verifiers: VerifierRegistryApi
  readonly trial: TrialSpec
  readonly journey: JourneySpec
  readonly leg: LegSpec
  readonly session: SessionHandle
  readonly observation: Observation
  readonly settleOutcome: SettleOutcome
  readonly workspaceRoot: string | null
  readonly now: () => number
}

/** 命令行参数拆完的样子：子命令、位置参数、旗标。 */
export interface ParsedArguments {
  readonly command: string | null
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string | true>>
}

/** 一批归档输入读进来的结果：能当 v3 用的那些，和全部视图。 */
export interface LoadedArchives {
  readonly archives: readonly RunArchive[]
  readonly views: readonly RunArchiveView[]
}

/** 成对比较里的一对：同一把配对钥匙下两边各自的完成度，连同它属于哪个簇。 */
export interface CompletionPair {
  readonly cluster: string
  readonly a: number
  readonly b: number
}

/** 配对的结果：配上的对，以及两边各自与合计被丢掉多少。 */
export interface MatchedCompletionPairs {
  readonly pairs: readonly CompletionPair[]
  readonly droppedA: number
  readonly droppedB: number
  readonly droppedEither: number
}

/** 连续工具错误的审计结果：出的判词，以及连续重试与并行冗余各数到多少。 */
export interface RepeatedToolErrorSummary {
  readonly findings: readonly RealTaskFinding[]
  readonly repeated: number
  readonly redundant: number
}
