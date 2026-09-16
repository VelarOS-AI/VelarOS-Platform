/**
 * 统计：可靠性区间、失败形态分布、可比性核对与成对比较。
 * 一次运行只是一个点，敢不敢下结论由区间说了算。
 */
import type {
  ComparabilityResult,
  FailureDistribution,
  IntervalEstimate,
  PairedComparison,
  PairedComparisonOptions,
  ReliabilityEstimate,
  RunArchive,
} from '../types/agent-lab.js'
import {
  checkComparability,
  compareExecutors,
  estimateReliability,
  failureDistribution,
  wilsonInterval,
} from '../utils/measure/statistics.js'

/**
 * 评测统计的出口。所有区间都按 95% 给；样本不够时给 `null` 而不是编一个区间出来，
 * 被丢弃的运行既不进分子也不进分母。实例归本包，进程里只有一份。
 */
export interface LabStatisticsApi {
  /** 一个比例的 Wilson 95% 区间；一次尝试都没有时三项都是 `null`。 */
  wilsonInterval: (successes: number, attempts: number) => IntervalEstimate
  /** 一组归档的单次可靠性：完成度满分才算成功，丢弃的单列。 */
  estimateReliability: (archives: readonly RunArchive[]) => ReliabilityEstimate
  /** 一组归档的失败形态分布；`unclassified` 单独数。 */
  failureDistribution: (archives: readonly RunArchive[]) => FailureDistribution
  /** 核对几份归档能不能放在一起比；不能比时给出每一条理由。 */
  checkComparability: (archives: readonly RunArchive[]) => ComparabilityResult
  /** 两个执行体的成对比较；不可比时结论一律是 `not-comparable`，不硬给方向。 */
  compareExecutors: (
    archives: readonly RunArchive[],
    executorA: string,
    executorB: string,
    options?: PairedComparisonOptions,
  ) => PairedComparison
}

class LabStatistics implements LabStatisticsApi {
  public wilsonInterval(successes: number, attempts: number): IntervalEstimate {
    return wilsonInterval(successes, attempts)
  }

  public estimateReliability(archives: readonly RunArchive[]): ReliabilityEstimate {
    return estimateReliability(archives)
  }

  public failureDistribution(archives: readonly RunArchive[]): FailureDistribution {
    return failureDistribution(archives)
  }

  public checkComparability(archives: readonly RunArchive[]): ComparabilityResult {
    return checkComparability(archives)
  }

  public compareExecutors(
    archives: readonly RunArchive[],
    executorA: string,
    executorB: string,
    options: PairedComparisonOptions = {},
  ): PairedComparison {
    return compareExecutors(archives, executorA, executorB, options)
  }
}

/** 进程里共用的那一份统计出口。 */
export const labStatistics: LabStatisticsApi = new LabStatistics()
