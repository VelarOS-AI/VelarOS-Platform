/**
 * 真实任务工作负载：审计产品里一次普通运行、把它固化成复跑用例、汇总加权覆盖。
 * 任务结果只由显式验收证据定，执行健康由跨度定，两件事分开说。
 */
import { RealTaskCaseSchemaId } from '../contract/constants.js'
import type {
  PromoteRealTaskCaseInput,
  RealTaskAssessment,
  RealTaskAuditOptions,
  RealTaskCase,
  RealTaskCoverageResult,
  RealTaskRecord,
  RealTaskSurfaceCoverageSummary,
  RunArchive,
  RunArchiveOutcome,
  ToolAttemptReceiptRecord,
  ToolInputEfficiency,
} from '../types/agent-lab.js'
import {
  classifyRunArchiveOutcome,
  summarizeRealTaskCoverage,
  summarizeToolInputEfficiency,
} from '../utils/measure/coverage.js'
import { auditRealTaskRecord } from '../utils/measure/workload.js'
import { realTaskCaseSchema, realTaskRecordSchema } from '../utils/wire/workload.js'

/**
 * 真实工作负载这一件能力。它不叫模型、也不信 agent 自己说的「做完了」：
 * 通过与否只看外部真相（文件、命令、浏览器状态、用户确认），执行跨度只用来说执行健康。
 * 实例归本包，进程里只有一份。
 */
export interface RealTaskWorkloadApi {
  /** 审计一条真实任务记录，出一份评估；记录先严格校验，`generatedAt` 不给就取当下。 */
  audit: (input: RealTaskRecord, options?: RealTaskAuditOptions) => RealTaskAssessment
  /**
   * 把一条真实任务固化成复跑用例。没有经人复核的提示词、没有隔离工作区引用、
   * 一条验收门都没有时一律拒绝——这三样缺一样，复跑就不是复跑。
   */
  promoteCase: (input: RealTaskRecord, options: PromoteRealTaskCaseInput) => RealTaskCase
  /** 按产品面汇总加权覆盖；重复结果与指向未知用例的结果一律报错，不许悄悄改分母。 */
  summarizeCoverage: (
    cases: readonly RealTaskCase[],
    results: readonly RealTaskCoverageResult[]
  ) => readonly RealTaskSurfaceCoverageSummary[]
  /** 把一份归档折成覆盖统计认的那一种结局；宿主不许自己重新解释。 */
  classifyArchiveOutcome: (archive: RunArchive) => RunArchiveOutcome
  /** 从真实执行回执算模型重复输入的减少量；字符数不是 token 估算。 */
  summarizeToolInputEfficiency: (
    records: readonly ToolAttemptReceiptRecord[]
  ) => ToolInputEfficiency
}

class RealTaskWorkload implements RealTaskWorkloadApi {
  public audit(input: RealTaskRecord, options: RealTaskAuditOptions = {}): RealTaskAssessment {
    const record = realTaskRecordSchema.parse(input)
    return auditRealTaskRecord(record, options.generatedAt ?? Date.now())
  }

  public promoteCase(input: RealTaskRecord, options: PromoteRealTaskCaseInput): RealTaskCase {
    const record = realTaskRecordSchema.parse(input)
    const prompt = options.prompt?.trim() || record.task.prompt?.trim() || ''
    if (!prompt) throw new Error('复跑用例必须有一条经人复核的提示词')
    if (options.acceptance.length === 0) throw new Error('复跑用例至少要有一条可判定的验收合同')
    return realTaskCaseSchema.parse({
      schema: RealTaskCaseSchemaId,
      id: options.id,
      version: options.version ?? 1,
      createdAt: options.createdAt ?? Date.now(),
      origin: { kind: 'observed', recordId: record.id },
      title: record.task.title,
      prompt,
      source: record.task.source,
      surface: record.task.surface,
      coverage: options.coverage,
      workspace: options.workspace,
      acceptance: [...options.acceptance],
      privacy: options.privacy,
      labels: [...(options.labels ?? [])],
    })
  }

  public summarizeCoverage(
    cases: readonly RealTaskCase[],
    results: readonly RealTaskCoverageResult[]
  ): readonly RealTaskSurfaceCoverageSummary[] {
    return summarizeRealTaskCoverage(cases, results)
  }

  public classifyArchiveOutcome(archive: RunArchive): RunArchiveOutcome {
    return classifyRunArchiveOutcome(archive)
  }

  public summarizeToolInputEfficiency(
    records: readonly ToolAttemptReceiptRecord[]
  ): ToolInputEfficiency {
    return summarizeToolInputEfficiency(records)
  }
}

/** 进程里共用的那一份真实工作负载出口。 */
export const realTaskWorkload: RealTaskWorkloadApi = new RealTaskWorkload()
