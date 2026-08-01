import type {
  FailureClass,
  FindingSeverity,
  ObservationFace,
  RunArchive,
} from "../protocol/index.js";

export type VerdictLevel = "critical" | "warning" | "information" | "positive";

export interface ReportVerdict {
  readonly id: string;
  readonly level: VerdictLevel;
  readonly title: string;
  readonly detail: string;
}

export interface ReportDataGap {
  readonly face: ObservationFace | "history";
  readonly title: string;
  readonly effect: string;
}

export interface LegReportModel {
  readonly id: string;
  readonly title: string;
  readonly durationMs: number;
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly settleKind: string;
  readonly toolCalls: number | null;
  readonly contextPercent: number | null;
  readonly findingCounts: Readonly<Record<FindingSeverity, number>>;
}

export interface RunReportModel {
  readonly runId: string;
  readonly journeyId: string;
  readonly journeyVersion: number;
  readonly journeyTitle: string;
  readonly executorId: string;
  readonly executorLabel: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly passedLegs: number | null;
  readonly totalLegs: number;
  readonly completion: number | null;
  readonly toolCalls: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly drops: number;
  readonly failureCounts: Readonly<Partial<Record<FailureClass, number>>>;
  readonly verdicts: readonly ReportVerdict[];
  readonly gaps: readonly ReportDataGap[];
  readonly legs: readonly LegReportModel[];
  readonly archive: RunArchive;
}

function findingCounts(
  archive: RunArchive,
): Partial<Record<FailureClass, number>> {
  const counts: Partial<Record<FailureClass, number>> = {};
  const add = (failureClass: FailureClass): void => {
    counts[failureClass] = (counts[failureClass] ?? 0) + 1;
  };
  for (const finding of archive.findings) add(finding.failureClass);
  for (const leg of archive.legs) {
    for (const criterion of leg.criteria) {
      if (criterion.outcome.kind === "fail")
        add(criterion.outcome.failureClass);
    }
  }
  return counts;
}

function completion(archive: RunArchive): number | null {
  let weighted = 0;
  let weight = 0;
  for (const leg of archive.legs) {
    if (leg.score === null) continue;
    const definition = archive.journey.legs.find(
      (item) => item.id === leg.legId,
    );
    if (!definition) continue;
    weighted += leg.score * definition.weight;
    weight += definition.weight;
  }
  return weight > 0 ? weighted / weight : null;
}

function dataGaps(archive: RunArchive): readonly ReportDataGap[] {
  const gaps = new Map<string, ReportDataGap>();
  for (const [face, coverage] of Object.entries(
    archive.manifest.capabilities.observes,
  )) {
    if (coverage === "full") continue;
    gaps.set(face, {
      face: face as ObservationFace,
      title: coverage === "none" ? `没有 ${face} 观测` : `${face} 只有部分观测`,
      effect: "相关健康指标与跨执行体比较必须标为未知，不能按 0 处理。",
    });
  }
  if (archive.manifest.trial.replicate.ofK < 2) {
    gaps.set("history", {
      face: "history",
      title: "只有一次重复试验",
      effect: "这份运行能做回归证据，不能单独估计随机波动或可靠性区间。",
    });
  }
  return [...gaps.values()];
}

function verdicts(
  archive: RunArchive,
  failures: Readonly<Partial<Record<FailureClass, number>>>,
  gaps: readonly ReportDataGap[],
): readonly ReportVerdict[] {
  const output: ReportVerdict[] = [];
  if (archive.drops.length > 0) {
    output.push({
      id: "attrition",
      level: "critical",
      title: "本次运行含环境或基础设施丢弃",
      detail: `${archive.drops.length} 项结果不进入能力分子或分母，必须单列。`,
    });
  }
  if ((failures.integrity ?? 0) > 0) {
    output.push({
      id: "integrity",
      level: "critical",
      title: "验证器完整性不成立",
      detail: "这份结果不能用于认证或比较，先修复证据隔离或验证器被篡改问题。",
    });
  }
  if ((failures["state-corruption"] ?? 0) > 0) {
    output.push({
      id: "state-corruption",
      level: "critical",
      title: "会话持久态或运行态留下损坏指纹",
      detail: `命中 ${failures["state-corruption"]} 项状态损坏类失败。`,
    });
  }
  if ((failures.loop ?? 0) > 0) {
    output.push({
      id: "loop",
      level: "critical",
      title: "旅程出现打转或被看门狗终止",
      detail: `命中 ${failures.loop} 项打转类失败。`,
    });
  }
  if ((failures["tool-failure"] ?? 0) > 0) {
    output.push({
      id: "tool-failure",
      level: "critical",
      title: "工具执行失败不是零",
      detail: `命中 ${failures["tool-failure"]} 项工具失败。`,
    });
  }
  if ((failures["budget-exhausted"] ?? 0) > 0) {
    output.push({
      id: "budget-exhausted",
      level: "warning",
      title: "执行体耗尽共享预算",
      detail: "预算失败与能力失败分开记账，但它仍是本次任务未在约束内完成。",
    });
  }
  if ((failures.timeout ?? 0) > 0) {
    output.push({
      id: "timeout",
      level: "warning",
      title: "旅程发生超时",
      detail:
        "检查执行体是否在工作、是否等待外部输入，以及墙钟与工作时长预算是否合理。",
    });
  }
  if ((failures.unclassified ?? 0) > 0) {
    output.push({
      id: "unclassified",
      level: "warning",
      title: "失败闭集尚未覆盖全部现象",
      detail: `${failures.unclassified} 项失败仍未分类；不要把它们并入最相近类别。`,
    });
  }
  const failedLegs = archive.legs.filter((leg) => leg.passed === false).length;
  const unknownLegs = archive.legs.filter((leg) => leg.passed === null).length;
  if (failedLegs > 0) {
    output.push({
      id: "leg-failure",
      level: "critical",
      title: "旅程里程碑没有全部通过",
      detail: `${failedLegs}/${archive.legs.length} 段明确失败。`,
    });
  }
  if (unknownLegs > 0) {
    output.push({
      id: "unknown-leg",
      level: "warning",
      title: "部分里程碑没有得到可判结果",
      detail: `${unknownLegs}/${archive.legs.length} 段为未知，而不是失败或 0 分。`,
    });
  }
  if (archive.legs.length < archive.journey.legs.length) {
    output.push({
      id: "journey-incomplete",
      level: "critical",
      title: "连续旅程提前结束",
      detail: `只执行 ${archive.legs.length}/${archive.journey.legs.length} 段。`,
    });
  }
  if (gaps.length > 0) {
    output.push({
      id: "observation-gaps",
      level: "information",
      title: "报告存在不可观测面",
      detail: `${gaps.length} 个数据面未被完整观测；这些位置一律显示未知。`,
    });
  }
  const hasCritical = output.some((item) => item.level === "critical");
  if (!hasCritical && archive.legs.length > 0 && unknownLegs === 0) {
    output.push({
      id: "all-gates-green",
      level: "positive",
      title: "本次旅程的显式门判据全部成立",
      detail:
        "这是一次运行的结论；可靠性与跨执行体差异仍需重复试验和配对统计。",
    });
  }
  return output;
}

export function createRunReportModel(archive: RunArchive): RunReportModel {
  const failures = findingCounts(archive);
  const gaps = dataGaps(archive);
  const knownLegs = archive.legs.filter((leg) => leg.passed !== null);
  return {
    runId: archive.manifest.runId,
    journeyId: archive.journey.id,
    journeyVersion: archive.journey.version,
    journeyTitle: archive.journey.title,
    executorId: archive.manifest.executor.executorId,
    executorLabel:
      archive.manifest.executor.model ?? archive.manifest.executor.executorId,
    startedAt: archive.manifest.startedAt,
    durationMs: archive.manifest.finishedAt - archive.manifest.startedAt,
    passedLegs:
      knownLegs.length === 0
        ? null
        : knownLegs.filter((leg) => leg.passed === true).length,
    totalLegs: archive.legs.length,
    completion: completion(archive),
    toolCalls: archive.manifest.usage.toolCalls,
    totalTokens: archive.usage?.totalTokens ?? null,
    costUsd: archive.usage?.costUsd ?? null,
    drops: archive.drops.length,
    failureCounts: failures,
    verdicts: verdicts(archive, failures, gaps),
    gaps,
    legs: archive.legs.map((leg) => ({
      id: leg.legId,
      title:
        archive.journey.legs.find((item) => item.id === leg.legId)?.title ??
        leg.legId,
      durationMs: leg.finishedAt - leg.startedAt,
      score: leg.score,
      passed: leg.passed,
      settleKind: leg.settleOutcome.kind,
      toolCalls:
        leg.observation.coverage.turns === "none"
          ? null
          : leg.observation.turns.reduce(
              (sum, turn) => sum + turn.toolCalls.length,
              0,
            ),
      contextPercent: leg.observation.runtime?.contextPercent ?? null,
      findingCounts: {
        fail: leg.findings.filter((finding) => finding.severity === "fail")
          .length,
        warn: leg.findings.filter((finding) => finding.severity === "warn")
          .length,
        info: leg.findings.filter((finding) => finding.severity === "info")
          .length,
      },
    })),
    archive,
  };
}
