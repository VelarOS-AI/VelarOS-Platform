import { z } from "zod";

import type {
  ObservationCoverage,
  ObservationFace,
  RunArchive,
} from "../protocol/index.js";
import { ObservationFaces } from "../protocol/index.js";
import { sha256Json } from "../runner/index.js";
import {
  checkComparability,
  compareExecutors,
  estimateReliability,
} from "../statistics/index.js";

export type CertificationStatus =
  "certified" | "conditional" | "inconclusive" | "rejected";
export type CertificationCheckStatus = "pass" | "fail" | "unknown";

export interface CertificationSubject {
  readonly kind: "agent" | "mod";
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface CertificationPolicy {
  readonly id: string;
  readonly version: number;
  readonly requiredJourneyIds: readonly string[];
  readonly minimumReplicatesPerJourney: number;
  readonly minimumReliability: number;
  readonly maximumAttritionRate: number;
  readonly requiredObservationCoverage: Readonly<
    Partial<Record<ObservationFace, Exclude<ObservationCoverage, "none">>>
  >;
  readonly requireSeparateVerifier: boolean;
  readonly requireNativeExecution: boolean;
  readonly requireBaseline: boolean;
  readonly maximumBaselineRegression: number;
}

export interface CertificationCheck {
  readonly id: string;
  readonly status: CertificationCheckStatus;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, boolean | number | string | null>>;
}

export interface CertificationReport {
  readonly schema: "agent-lab/certification@1";
  readonly subject: CertificationSubject;
  readonly policy: CertificationPolicy;
  readonly status: CertificationStatus;
  readonly checks: readonly CertificationCheck[];
  readonly runIds: readonly string[];
  readonly baselineRunIds: readonly string[];
  readonly issuedAt: number;
  readonly digest: string;
}

export interface CertificationInput {
  readonly subject: CertificationSubject;
  readonly policy: CertificationPolicy;
  readonly archives: readonly RunArchive[];
  readonly baselineArchives?: readonly RunArchive[];
  readonly subjectExecutorId: string;
  readonly baselineExecutorId?: string;
  readonly now?: () => number;
}

const IdentifierSchema = z.string().trim().min(1).max(160);

export const CertificationSubjectSchema = z.strictObject({
  kind: z.enum(["agent", "mod"]),
  id: IdentifierSchema,
  version: z.string().trim().min(1).max(160),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const CertificationPolicySchema = z.strictObject({
  id: IdentifierSchema,
  version: z.number().int().positive(),
  requiredJourneyIds: z.array(IdentifierSchema).min(1),
  minimumReplicatesPerJourney: z.number().int().positive(),
  minimumReliability: z.number().min(0).max(1),
  maximumAttritionRate: z.number().min(0).max(1),
  requiredObservationCoverage: z
    .object(
      Object.fromEntries(
        ObservationFaces.map((face) => [
          face,
          z.enum(["partial", "full"]).optional(),
        ]),
      ) as Record<
        ObservationFace,
        z.ZodOptional<z.ZodEnum<{ partial: "partial"; full: "full" }>>
      >,
    )
    .strict(),
  requireSeparateVerifier: z.boolean(),
  requireNativeExecution: z.boolean(),
  requireBaseline: z.boolean(),
  maximumBaselineRegression: z.number().min(0).max(1),
});

export function parseCertificationSubject(
  value: unknown,
): CertificationSubject {
  return CertificationSubjectSchema.parse(value);
}

export function parseCertificationPolicy(value: unknown): CertificationPolicy {
  return CertificationPolicySchema.parse(value) as CertificationPolicy;
}

function check(
  id: string,
  status: CertificationCheckStatus,
  summary: string,
  evidence: CertificationCheck["evidence"] = {},
): CertificationCheck {
  return { id, status, summary, evidence };
}

function coverageRank(value: ObservationCoverage): number {
  if (value === "full") return 2;
  if (value === "partial") return 1;
  return 0;
}

function journeyChecks(
  policy: CertificationPolicy,
  archives: readonly RunArchive[],
): readonly CertificationCheck[] {
  const checks: CertificationCheck[] = [];
  for (const journeyId of policy.requiredJourneyIds) {
    const runs = archives.filter((archive) => archive.journey.id === journeyId);
    if (runs.length < policy.minimumReplicatesPerJourney) {
      checks.push(
        check(
          `journey:${journeyId}:replicates`,
          "unknown",
          `旅程 ${journeyId} 的重复试验不足`,
          {
            observed: runs.length,
            required: policy.minimumReplicatesPerJourney,
          },
        ),
      );
      continue;
    }
    const reliability = estimateReliability(runs);
    const lower = reliability.lower95;
    checks.push(
      check(
        `journey:${journeyId}:reliability`,
        lower === null
          ? "unknown"
          : lower >= policy.minimumReliability
            ? "pass"
            : "fail",
        `旅程 ${journeyId} 的单次可靠性下界`,
        {
          estimate: reliability.estimate,
          lower95: lower,
          required: policy.minimumReliability,
          attempts: reliability.attempts,
          dropped: reliability.dropped,
        },
      ),
    );
  }
  return checks;
}

function coverageChecks(
  policy: CertificationPolicy,
  archives: readonly RunArchive[],
): readonly CertificationCheck[] {
  const checks: CertificationCheck[] = [];
  for (const [face, required] of Object.entries(
    policy.requiredObservationCoverage,
  )) {
    if (!required) continue;
    const missing = archives.filter(
      (archive) =>
        coverageRank(
          archive.manifest.capabilities.observes[face as ObservationFace],
        ) < coverageRank(required),
    );
    checks.push(
      check(
        `coverage:${face}`,
        missing.length === 0 ? "pass" : "unknown",
        missing.length === 0
          ? `观测面 ${face} 满足要求`
          : `观测面 ${face} 不足，不能据此判健康`,
        { insufficientRuns: missing.length, totalRuns: archives.length },
      ),
    );
  }
  return checks;
}

function integrityChecks(
  policy: CertificationPolicy,
  archives: readonly RunArchive[],
): readonly CertificationCheck[] {
  const integrityFailures = archives.reduce(
    (count, archive) =>
      count +
      archive.findings.filter(
        (finding) =>
          finding.failureClass === "integrity" && finding.severity === "fail",
      ).length,
    0,
  );
  const sharedVerifiers = archives.filter(
    (archive) => archive.manifest.capabilities.verifierIsolation !== "separate",
  ).length;
  const nonNative = archives.filter(
    (archive) => !archive.manifest.capabilities.preservesNativeExecution,
  ).length;
  return [
    check(
      "integrity-findings",
      integrityFailures === 0 ? "pass" : "fail",
      integrityFailures === 0
        ? "未发现验证器完整性失败"
        : "发现验证器完整性失败",
      { failures: integrityFailures },
    ),
    check(
      "verifier-isolation",
      !policy.requireSeparateVerifier
        ? "pass"
        : sharedVerifiers === 0
          ? "pass"
          : "unknown",
      sharedVerifiers === 0 ? "验证器与被测执行环境隔离" : "验证器隔离能力不足",
      { insufficientRuns: sharedVerifiers },
    ),
    check(
      "native-execution",
      !policy.requireNativeExecution
        ? "pass"
        : nonNative === 0
          ? "pass"
          : "fail",
      nonNative === 0 ? "保留执行体原生行为" : "部分运行没有保留执行体原生行为",
      { nonNativeRuns: nonNative },
    ),
  ];
}

function attritionCheck(
  policy: CertificationPolicy,
  archives: readonly RunArchive[],
): CertificationCheck {
  if (archives.length === 0)
    return check("attrition", "unknown", "没有可用运行");
  const dropped = archives.filter((archive) => archive.drops.length > 0).length;
  const rate = dropped / archives.length;
  return check(
    "attrition",
    rate <= policy.maximumAttritionRate ? "pass" : "fail",
    "环境与基础设施丢弃率",
    {
      rate,
      maximum: policy.maximumAttritionRate,
      dropped,
      total: archives.length,
    },
  );
}

function baselineCheck(input: CertificationInput): CertificationCheck {
  const baseline = input.baselineArchives ?? [];
  if (!input.policy.requireBaseline && baseline.length === 0)
    return check("baseline", "pass", "本策略不要求基线对照");
  if (baseline.length === 0 || !input.baselineExecutorId)
    return check("baseline", "unknown", "缺少成对基线，不能判断增益或回归");
  const all = [...input.archives, ...baseline];
  const comparable = checkComparability(all);
  if (!comparable.comparable)
    return check(
      "baseline",
      "unknown",
      `基线不可比: ${comparable.reasons.join("; ")}`,
    );
  const comparison = compareExecutors(
    all,
    input.subjectExecutorId,
    input.baselineExecutorId,
    { minimumEffect: input.policy.maximumBaselineRegression },
  );
  if (comparison.completionDifference.lower95 === null)
    return check("baseline", "unknown", "成对样本簇不足，不能给出区间判断", {
      pairs: comparison.matchedPairs,
      clusters: comparison.clusters,
    });
  const lower = comparison.completionDifference.lower95;
  return check(
    "baseline",
    lower >= -input.policy.maximumBaselineRegression ? "pass" : "fail",
    "相对基线的完成度回归下界",
    {
      estimate: comparison.completionDifference.estimate,
      lower95: lower,
      maximumRegression: input.policy.maximumBaselineRegression,
      pairs: comparison.matchedPairs,
      clusters: comparison.clusters,
    },
  );
}

function reportStatus(
  checks: readonly CertificationCheck[],
): CertificationStatus {
  if (checks.some((item) => item.status === "fail")) return "rejected";
  if (checks.some((item) => item.status === "unknown")) return "inconclusive";
  return "certified";
}

export function certifySubject(input: CertificationInput): CertificationReport {
  const subjectArchives = input.archives.filter(
    (archive) =>
      archive.manifest.executor.executorId === input.subjectExecutorId,
  );
  const checks = [
    ...journeyChecks(input.policy, subjectArchives),
    ...coverageChecks(input.policy, subjectArchives),
    ...integrityChecks(input.policy, subjectArchives),
    attritionCheck(input.policy, subjectArchives),
    baselineCheck(input),
  ];
  const issuedAt = (input.now ?? Date.now)();
  const unsigned = {
    schema: "agent-lab/certification@1" as const,
    subject: input.subject,
    policy: input.policy,
    status: reportStatus(checks),
    checks,
    runIds: subjectArchives.map((archive) => archive.manifest.runId).sort(),
    baselineRunIds: (input.baselineArchives ?? [])
      .map((archive) => archive.manifest.runId)
      .sort(),
    issuedAt,
  };
  return { ...unsigned, digest: sha256Json(unsigned) };
}
