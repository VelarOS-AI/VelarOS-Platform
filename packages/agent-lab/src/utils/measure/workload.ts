/**
 * 真实任务审计：不叫模型、也不信 agent 自己说的「做完了」。
 * 任务结果只由显式的验收证据定，执行跨度只定执行健康，两件事分开说。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import type {
  RealTaskAssertionOutcome,
  RealTaskHealth,
  RealTaskVerdict,
} from '../../contract/constants.js'
import type {
  RealTaskAssessment,
  RealTaskAssessmentMetrics,
  RealTaskFinding,
  RealTaskRecord,
  RealTaskSpan,
} from '../../types/agent-lab.js'
import type { RepeatedToolErrorSummary } from '../../types/internal.js'
import { AgentLabTuning } from '../tuning.js'

/** 把一串可能为未知的数加起来；一个已知的都没有就是未知。 */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null)
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null
}

/** 一段跨度在证据里的引用名。 */
function evidenceId(span: RealTaskSpan): string {
  return `span:${span.id}`
}

/**
 * 找连续失败的同一个工具错误：串行的算「没看反馈就重试」，并行的算「同一失败前置条件被放大」。
 * 两者都浪费工具调用与上下文，但性质不同，判词也不同。
 */
export function auditRepeatedToolErrors(spans: readonly RealTaskSpan[]): RepeatedToolErrorSummary {
  const tools = spans
    .filter((span) => span.category === 'tool')
    .sort((left, right) => left.startedAt - right.startedAt)
  const groups: Array<{ readonly key: string; readonly spans: RealTaskSpan[] }> = []
  let active: { readonly key: string; readonly spans: RealTaskSpan[] } | null = null
  for (const span of tools) {
    if (span.status !== 'error') {
      if (active) groups.push(active)
      active = null
      continue
    }
    const key = `${span.toolName ?? span.name}:${span.errorCode ?? 'unknown'}`
    if (active !== null && active.key === key) active.spans.push(span)
    else {
      if (active) groups.push(active)
      active = { key, spans: [span] }
    }
  }
  if (active) groups.push(active)
  const findings: RealTaskFinding[] = []
  let repeated = 0
  let redundant = 0
  for (const group of groups) {
    if (group.spans.length < AgentLabTuning.workload.repeatedToolErrorRun) continue
    const sequential = group.spans
      .slice(1)
      .every((span, index) => span.startedAt >= group.spans[index]!.endedAt)
    if (!sequential) {
      redundant += group.spans.length
      findings.push({
        id: `redundant-call:${group.key}:${group.spans[0]?.id ?? 'unknown'}`,
        severity: 'warn',
        class: 'redundant-call',
        title: '同一失败前置条件被并行放大',
        detail: `${group.key} 在看到任何一次结果前并行发起 ${group.spans.length} 次；这不是反馈后的重试，但浪费了工具调用与上下文。`,
        evidenceRefs: group.spans.map(evidenceId),
      })
      continue
    }
    repeated += group.spans.length
    findings.push({
      id: `retry-loop:${group.key}:${group.spans[0]?.id ?? 'unknown'}`,
      severity: 'fail',
      class: 'retry-loop',
      title: '同一工具错误被连续重复',
      detail: `${group.key} 在同一真实任务中连续失败 ${group.spans.length} 次；执行没有根据工具反馈及时换路。`,
      evidenceRefs: group.spans.map(evidenceId),
    })
  }
  return { findings, repeated, redundant }
}

/** 任务结果：用户说不对就是失败；有验收断言失败就是失败；断言全过才是通过；一条断言都没有就是未知。 */
function taskOutcome(record: RealTaskRecord): RealTaskAssertionOutcome {
  if (record.evidence.userFeedback?.verdict === 'rejected') return 'fail'
  const gates = record.evidence.assertions
  if (gates.some((assertion) => assertion.outcome === 'fail')) return 'fail'
  if (gates.length > 0 && gates.every((assertion) => assertion.outcome === 'pass')) return 'pass'
  return 'unknown'
}

/** 任务结果与执行健康合成一句综合判词。 */
function overallVerdict(
  outcome: RealTaskAssertionOutcome,
  health: RealTaskHealth
): RealTaskVerdict {
  if (outcome === 'fail') return 'verified-fail'
  if (outcome === 'pass')
    return health === 'healthy' ? 'verified-pass' : 'verified-pass-with-issues'
  return health === 'broken' ? 'needs-review' : 'unknown'
}

/** 数出这次真实任务的量：调用了多少、错了多少、改了多少、验收过了几条。 */
function assessmentMetrics(
  record: RealTaskRecord,
  repeated: RepeatedToolErrorSummary
): RealTaskAssessmentMetrics {
  const spans = record.evidence.spans
  const modelSpans = spans.filter((span) => span.category === 'model')
  const toolSpans = spans.filter((span) => span.category === 'tool')
  const assertions = record.evidence.assertions
  return {
    durationMs: Math.max(0, record.task.finishedAt - record.task.startedAt),
    modelCalls: modelSpans.length,
    toolCalls: toolSpans.length,
    toolErrors: toolSpans.filter((span) => span.status === 'error').length,
    repeatedToolErrors: repeated.repeated,
    redundantToolCalls: repeated.redundant,
    mutations: toolSpans.filter((span) => span.mutation).length,
    tokensIn: sumKnown(modelSpans.map((span) => span.metrics.tokensIn)),
    tokensOut: sumKnown(modelSpans.map((span) => span.metrics.tokensOut)),
    costUsd: sumKnown(modelSpans.map((span) => span.metrics.costUsd)),
    assertionsPassed: assertions.filter((item) => item.outcome === 'pass').length,
    assertionsFailed: assertions.filter((item) => item.outcome === 'fail').length,
    assertionsUnknown: assertions.filter((item) => item.outcome === 'unknown').length,
  }
}

/** 列出这次真实任务的全部发现：终态、工具错误、重复打转、没验收的副作用、断言与观测缺口。 */
function auditFindings(
  record: RealTaskRecord,
  repeated: RepeatedToolErrorSummary
): readonly RealTaskFinding[] {
  const findings: RealTaskFinding[] = []
  const toolSpans = record.evidence.spans.filter((span) => span.category === 'tool')
  const toolErrors = toolSpans.filter((span) => span.status === 'error')
  const mutations = toolSpans.filter((span) => span.mutation)
  const assertions = record.evidence.assertions

  if (record.task.terminalStatus === 'error') {
    findings.push({
      id: 'terminal-error',
      severity: 'fail',
      class: 'execution',
      title: '真实任务以错误终止',
      detail: '执行主路没有正常收敛；先修复系统或工具错误，再解释任务结果。',
      evidenceRefs: [],
    })
  } else if (record.task.terminalStatus === 'aborted') {
    findings.push({
      id: 'terminal-aborted',
      severity: 'warn',
      class: 'execution',
      title: '真实任务被中止',
      detail: '中止可能是用户意图，也可能是恢复失败；没有验收证据时不能判定完成。',
      evidenceRefs: [],
    })
  } else if (record.task.terminalStatus === 'unknown') {
    findings.push({
      id: 'terminal-unknown',
      severity: 'warn',
      class: 'observation-gap',
      title: '缺少可信终态',
      detail: '执行记录没有提供可确认的完成、错误或中止状态。',
      evidenceRefs: [],
    })
  }

  if (toolErrors.length > 0) {
    findings.push({
      id: 'tool-errors',
      severity: 'warn',
      class: 'tool-error',
      title: '真实任务出现工具错误',
      detail: `${toolErrors.length}/${toolSpans.length} 次工具调用失败；即使最终完成，也应保留为执行健康问题。`,
      evidenceRefs: toolErrors.map(evidenceId),
    })
  }

  findings.push(...repeated.findings)

  if (mutations.length > 0 && assertions.length === 0) {
    findings.push({
      id: 'unverified-change',
      severity: 'warn',
      class: 'unverified-change',
      title: '产生了副作用但没有独立验收',
      detail: `观察到 ${mutations.length} 次可能修改状态的工具调用，但没有文件、命令、浏览器状态或用户确认等验收证据。`,
      evidenceRefs: mutations.map(evidenceId),
    })
  }

  for (const assertion of assertions) {
    if (assertion.outcome === 'pass') continue
    findings.push({
      id: `assertion:${assertion.id}`,
      severity: assertion.outcome === 'fail' ? 'fail' : 'info',
      class: assertion.outcome === 'fail' ? 'acceptance' : 'observation-gap',
      title: assertion.outcome === 'fail' ? '真实验收条件失败' : '验收条件尚不可判',
      detail: `${assertion.description}: ${assertion.detail}`,
      evidenceRefs: assertion.evidenceRefs,
    })
  }

  if (record.evidence.userFeedback?.verdict === 'rejected') {
    findings.push({
      id: 'user-rejected',
      severity: 'fail',
      class: 'user-rejected',
      title: '用户确认结果不正确',
      detail: record.evidence.userFeedback.detail || '用户拒绝了本次任务结果。',
      evidenceRefs: [],
    })
  }

  for (const gap of record.evidence.observationGaps) {
    findings.push({
      id: `gap:${gap}`,
      severity: 'info',
      class: 'observation-gap',
      title: '存在观测缺口',
      detail: gap,
      evidenceRefs: [],
    })
  }

  return findings
}

/** 审计一次已经校验过的真实任务记录，给出评估；`generatedAt` 由调用方定。 */
export function auditRealTaskRecord(
  record: RealTaskRecord,
  generatedAt: number
): RealTaskAssessment {
  const repeated = auditRepeatedToolErrors(record.evidence.spans)
  const findings = auditFindings(record, repeated)
  const outcome = taskOutcome(record)
  const health: RealTaskHealth = findings.some((finding) => finding.severity === 'fail')
    ? 'broken'
    : findings.some((finding) => finding.severity === 'warn')
      ? 'degraded'
      : 'healthy'
  return {
    schema: 'agent-lab/real-task-assessment@1',
    recordId: record.id,
    generatedAt,
    outcome,
    health,
    verdict: overallVerdict(outcome, health),
    promotionRecommended:
      outcome === 'fail' ||
      findings.some((finding) =>
        ['retry-loop', 'execution', 'user-rejected'].includes(finding.class)
      ),
    findings,
    metrics: assessmentMetrics(record, repeated),
  }
}
