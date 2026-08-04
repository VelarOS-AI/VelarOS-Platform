import type {
  RealTaskAssessment,
  RealTaskFinding,
  RealTaskRecord,
  RealTaskSpan,
} from "./Types.js";
import { parseRealTaskAssessment, parseRealTaskRecord } from "./Types.js";

function sumKnown(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function evidenceId(span: RealTaskSpan): string {
  return `span:${span.id}`;
}

function repeatedToolErrorFindings(
  spans: readonly RealTaskSpan[],
): {
  readonly findings: readonly RealTaskFinding[];
  readonly repeated: number;
  readonly redundant: number;
} {
  const tools = spans
    .filter((span) => span.category === "tool")
    .sort((left, right) => left.startedAt - right.startedAt);
  const groups: Array<{ readonly key: string; readonly spans: RealTaskSpan[] }> = [];
  let active: { readonly key: string; readonly spans: RealTaskSpan[] } | null = null;
  for (const span of tools) {
    if (span.status !== "error") {
      if (active) groups.push(active);
      active = null;
      continue;
    }
    const key = `${span.toolName ?? span.name}:${span.errorCode ?? "unknown"}`;
    if (active !== null && active.key === key) active.spans.push(span);
    else {
      if (active) groups.push(active);
      active = { key, spans: [span] };
    }
  }
  if (active) groups.push(active);
  const findings: RealTaskFinding[] = [];
  let repeated = 0;
  let redundant = 0;
  for (const group of groups) {
    if (group.spans.length < 3) continue;
    const sequential = group.spans
      .slice(1)
      .every((span, index) => span.startedAt >= group.spans[index]!.endedAt);
    if (!sequential) {
      redundant += group.spans.length;
      findings.push({
        id: `redundant-call:${group.key}:${group.spans[0]?.id ?? "unknown"}`,
        severity: "warn",
        class: "redundant-call",
        title: "同一失败前置条件被并行放大",
        detail: `${group.key} 在看到任何一次结果前并行发起 ${group.spans.length} 次；这不是反馈后的重试，但浪费了工具调用与上下文。`,
        evidenceRefs: group.spans.map(evidenceId),
      });
      continue;
    }
    repeated += group.spans.length;
    findings.push({
      id: `retry-loop:${group.key}:${group.spans[0]?.id ?? "unknown"}`,
      severity: "fail",
      class: "retry-loop",
      title: "同一工具错误被连续重复",
      detail: `${group.key} 在同一真实任务中连续失败 ${group.spans.length} 次；执行没有根据工具反馈及时换路。`,
      evidenceRefs: group.spans.map(evidenceId),
    });
  }
  return { findings, repeated, redundant };
}

function outcome(record: RealTaskRecord): RealTaskAssessment["outcome"] {
  if (record.evidence.userFeedback?.verdict === "rejected") return "fail";
  const gates = record.evidence.assertions;
  if (gates.some((assertion) => assertion.outcome === "fail")) return "fail";
  if (gates.length > 0 && gates.every((assertion) => assertion.outcome === "pass")) return "pass";
  return "unknown";
}

function verdict(
  taskOutcome: RealTaskAssessment["outcome"],
  health: RealTaskAssessment["health"],
): RealTaskAssessment["verdict"] {
  if (taskOutcome === "fail") return "verified-fail";
  if (taskOutcome === "pass") return health === "healthy" ? "verified-pass" : "verified-pass-with-issues";
  return health === "broken" ? "needs-review" : "unknown";
}

/**
 * Audits one ordinary product run without calling a model or trusting the agent's completion claim.
 * Explicit acceptance evidence decides task outcome; spans decide execution health.
 */
export function auditRealTask(
  input: RealTaskRecord,
  options: { readonly generatedAt?: number } = {},
): RealTaskAssessment {
  const record = parseRealTaskRecord(input);
  const spans = record.evidence.spans;
  const findings: RealTaskFinding[] = [];
  const toolSpans = spans.filter((span) => span.category === "tool");
  const toolErrors = toolSpans.filter((span) => span.status === "error");
  const mutations = toolSpans.filter((span) => span.mutation);
  const assertions = record.evidence.assertions;
  const taskOutcome = outcome(record);

  if (record.task.terminalStatus === "error") {
    findings.push({
      id: "terminal-error",
      severity: "fail",
      class: "execution",
      title: "真实任务以错误终止",
      detail: "执行主路没有正常收敛；先修复系统或工具错误，再解释任务结果。",
      evidenceRefs: [],
    });
  } else if (record.task.terminalStatus === "aborted") {
    findings.push({
      id: "terminal-aborted",
      severity: "warn",
      class: "execution",
      title: "真实任务被中止",
      detail: "中止可能是用户意图，也可能是恢复失败；没有验收证据时不能判定完成。",
      evidenceRefs: [],
    });
  } else if (record.task.terminalStatus === "unknown") {
    findings.push({
      id: "terminal-unknown",
      severity: "warn",
      class: "observation-gap",
      title: "缺少可信终态",
      detail: "执行记录没有提供可确认的完成、错误或中止状态。",
      evidenceRefs: [],
    });
  }

  if (toolErrors.length > 0) {
    findings.push({
      id: "tool-errors",
      severity: "warn",
      class: "tool-error",
      title: "真实任务出现工具错误",
      detail: `${toolErrors.length}/${toolSpans.length} 次工具调用失败；即使最终完成，也应保留为执行健康问题。`,
      evidenceRefs: toolErrors.map(evidenceId),
    });
  }

  const repeated = repeatedToolErrorFindings(spans);
  findings.push(...repeated.findings);

  if (mutations.length > 0 && assertions.length === 0) {
    findings.push({
      id: "unverified-change",
      severity: "warn",
      class: "unverified-change",
      title: "产生了副作用但没有独立验收",
      detail: `观察到 ${mutations.length} 次可能修改状态的工具调用，但没有文件、命令、浏览器状态或用户确认等验收证据。`,
      evidenceRefs: mutations.map(evidenceId),
    });
  }

  for (const assertion of assertions) {
    if (assertion.outcome === "pass") continue;
    findings.push({
      id: `assertion:${assertion.id}`,
      severity: assertion.outcome === "fail" ? "fail" : "info",
      class:
        assertion.outcome === "fail" ? "acceptance" : "observation-gap",
      title:
        assertion.outcome === "fail" ? "真实验收条件失败" : "验收条件尚不可判",
      detail: `${assertion.description}: ${assertion.detail}`,
      evidenceRefs: assertion.evidenceRefs,
    });
  }

  if (record.evidence.userFeedback?.verdict === "rejected") {
    findings.push({
      id: "user-rejected",
      severity: "fail",
      class: "user-rejected",
      title: "用户确认结果不正确",
      detail: record.evidence.userFeedback.detail || "用户拒绝了本次任务结果。",
      evidenceRefs: [],
    });
  }

  for (const gap of record.evidence.observationGaps) {
    findings.push({
      id: `gap:${gap}`,
      severity: "info",
      class: "observation-gap",
      title: "存在观测缺口",
      detail: gap,
      evidenceRefs: [],
    });
  }

  const health: RealTaskAssessment["health"] = findings.some(
    (finding) => finding.severity === "fail",
  )
    ? "broken"
    : findings.some((finding) => finding.severity === "warn")
      ? "degraded"
      : "healthy";
  const modelSpans = spans.filter((span) => span.category === "model");
  const assessment: RealTaskAssessment = {
    schema: "agent-lab/real-task-assessment@1",
    recordId: record.id,
    generatedAt: options.generatedAt ?? Date.now(),
    outcome: taskOutcome,
    health,
    verdict: verdict(taskOutcome, health),
    promotionRecommended:
      taskOutcome === "fail" ||
      findings.some((finding) =>
        ["retry-loop", "execution", "user-rejected"].includes(finding.class),
      ),
    findings,
    metrics: {
      durationMs: Math.max(0, record.task.finishedAt - record.task.startedAt),
      modelCalls: modelSpans.length,
      toolCalls: toolSpans.length,
      toolErrors: toolErrors.length,
      repeatedToolErrors: repeated.repeated,
      redundantToolCalls: repeated.redundant,
      mutations: mutations.length,
      tokensIn: sumKnown(modelSpans.map((span) => span.metrics.tokensIn)),
      tokensOut: sumKnown(modelSpans.map((span) => span.metrics.tokensOut)),
      costUsd: sumKnown(modelSpans.map((span) => span.metrics.costUsd)),
      assertionsPassed: assertions.filter((item) => item.outcome === "pass").length,
      assertionsFailed: assertions.filter((item) => item.outcome === "fail").length,
      assertionsUnknown: assertions.filter((item) => item.outcome === "unknown").length,
    },
  };
  return parseRealTaskAssessment(assessment);
}
