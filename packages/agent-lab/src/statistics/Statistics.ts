import type { FailureClass, RunArchive } from "../protocol/index.js";

export interface IntervalEstimate {
  readonly estimate: number | null;
  readonly lower95: number | null;
  readonly upper95: number | null;
  readonly observations: number;
}

export interface ReliabilityEstimate extends IntervalEstimate {
  readonly successes: number;
  readonly attempts: number;
  readonly dropped: number;
}

export interface FailureDistribution {
  readonly classified: number;
  readonly unclassified: number;
  readonly byClass: Readonly<Partial<Record<FailureClass, number>>>;
}

export type ComparisonDecision =
  "a-better" | "b-better" | "inconclusive" | "not-comparable";

export interface ComparabilityResult {
  readonly comparable: boolean;
  readonly reasons: readonly string[];
}

export interface PairedComparison {
  readonly executorA: string;
  readonly executorB: string;
  readonly completionDifference: IntervalEstimate;
  readonly decision: ComparisonDecision;
  readonly minimumEffect: number;
  readonly matchedPairs: number;
  readonly clusters: number;
  readonly attrition: {
    readonly a: number;
    readonly b: number;
    readonly either: number;
  };
  readonly failureA: FailureDistribution;
  readonly failureB: FailureDistribution;
  readonly comparability: ComparabilityResult;
}

function normalQuantile95(): number {
  return 1.959963984540054;
}

export function wilsonInterval(
  successes: number,
  attempts: number,
): IntervalEstimate {
  if (attempts <= 0)
    return { estimate: null, lower95: null, upper95: null, observations: 0 };
  const z = normalQuantile95();
  const proportion = successes / attempts;
  const denominator = 1 + (z * z) / attempts;
  const center = (proportion + (z * z) / (2 * attempts)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / attempts +
        (z * z) / (4 * attempts * attempts),
    );
  return {
    estimate: proportion,
    lower95: Math.max(0, center - margin),
    upper95: Math.min(1, center + margin),
    observations: attempts,
  };
}

function archiveCompletion(archive: RunArchive): number | null {
  if (archive.drops.length > 0) return null;
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

export function estimateReliability(
  archives: readonly RunArchive[],
): ReliabilityEstimate {
  const values = archives.map(archiveCompletion);
  const attempts = values.filter((value) => value !== null).length;
  const successes = values.filter((value) => value === 1).length;
  const interval = wilsonInterval(successes, attempts);
  return {
    ...interval,
    successes,
    attempts,
    dropped: values.length - attempts,
  };
}

export function failureDistribution(
  archives: readonly RunArchive[],
): FailureDistribution {
  const byClass: Partial<Record<FailureClass, number>> = {};
  let classified = 0;
  let unclassified = 0;
  const record = (failureClass: FailureClass): void => {
    if (failureClass === "unclassified") unclassified += 1;
    else classified += 1;
    byClass[failureClass] = (byClass[failureClass] ?? 0) + 1;
  };
  for (const archive of archives) {
    for (const finding of archive.findings) record(finding.failureClass);
    for (const leg of archive.legs) {
      for (const criterion of leg.criteria) {
        if (criterion.outcome.kind === "fail")
          record(criterion.outcome.failureClass);
      }
    }
  }
  return { classified, unclassified, byClass };
}

function stableString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableString(item)}`)
    .join(",")}}`;
}

export function checkComparability(
  archives: readonly RunArchive[],
): ComparabilityResult {
  if (archives.length < 2)
    return { comparable: false, reasons: ["At least two runs are required"] };
  const reasons = new Set<string>();
  const groups = new Map<string, RunArchive[]>();
  for (const archive of archives) {
    const key = `${archive.journey.id}@${archive.journey.version}:${archive.manifest.trial.arm ?? "default"}`;
    const group = groups.get(key) ?? [];
    group.push(archive);
    groups.set(key, group);
    if (archive.manifest.capabilities.preservesNativeExecution !== true) {
      reasons.add(
        `${archive.manifest.executor.executorId} does not preserve native execution`,
      );
    }
  }
  for (const group of groups.values()) {
    const reference = group[0];
    for (const archive of group.slice(1)) {
      if (
        archive.manifest.harness.taskDigest !==
        reference.manifest.harness.taskDigest
      ) {
        reasons.add(`${reference.journey.id}: task digest differs`);
      }
      if (
        archive.manifest.harness.detectorDigest !==
        reference.manifest.harness.detectorDigest
      ) {
        reasons.add(`${reference.journey.id}: detector set differs`);
      }
      if (
        archive.manifest.harness.policyDigest !==
        reference.manifest.harness.policyDigest
      ) {
        reasons.add(`${reference.journey.id}: evaluation policy differs`);
      }
      if (
        stableString(archive.manifest.budget) !==
        stableString(reference.manifest.budget)
      ) {
        reasons.add(`${reference.journey.id}: budget differs`);
      }
      if (
        archive.manifest.harness.consumerCommit !==
        reference.manifest.harness.consumerCommit
      ) {
        reasons.add(`${reference.journey.id}: consumer source commit differs`);
      }
    }
  }
  return { comparable: reasons.size === 0, reasons: [...reasons].sort() };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pairedKey(archive: RunArchive): string {
  const replicate = archive.manifest.trial.replicate;
  return `${archive.journey.id}@${archive.journey.version}:${replicate.groupId}:${replicate.index}:${replicate.seed}`;
}

function clusterKey(archive: RunArchive): string {
  return `${archive.journey.id}@${archive.journey.version}:${archive.manifest.trial.arm ?? "default"}`;
}

interface Pair {
  readonly cluster: string;
  readonly a: number;
  readonly b: number;
}

function matchPairs(
  archivesA: readonly RunArchive[],
  archivesB: readonly RunArchive[],
): {
  readonly pairs: readonly Pair[];
  readonly droppedA: number;
  readonly droppedB: number;
  readonly droppedEither: number;
} {
  const a = new Map(archivesA.map((archive) => [pairedKey(archive), archive]));
  const b = new Map(archivesB.map((archive) => [pairedKey(archive), archive]));
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const pairs: Pair[] = [];
  let droppedA = 0;
  let droppedB = 0;
  let droppedEither = 0;
  for (const key of keys) {
    const archiveA = a.get(key);
    const archiveB = b.get(key);
    const valueA = archiveA ? archiveCompletion(archiveA) : null;
    const valueB = archiveB ? archiveCompletion(archiveB) : null;
    if (valueA === null) droppedA += 1;
    if (valueB === null) droppedB += 1;
    if (valueA === null || valueB === null || !archiveA || !archiveB) {
      droppedEither += 1;
      continue;
    }
    pairs.push({ cluster: clusterKey(archiveA), a: valueA, b: valueB });
  }
  return { pairs, droppedA, droppedB, droppedEither };
}

export interface PairedComparisonOptions {
  readonly minimumEffect?: number;
  readonly bootstrapSamples?: number;
  readonly seed?: number;
}

function clusterBootstrap(
  pairs: readonly Pair[],
  samples: number,
  seed: number,
): IntervalEstimate {
  if (pairs.length === 0)
    return { estimate: null, lower95: null, upper95: null, observations: 0 };
  const byCluster = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const cluster = byCluster.get(pair.cluster) ?? [];
    cluster.push(pair);
    byCluster.set(pair.cluster, cluster);
  }
  const clusters = [...byCluster.values()];
  const estimate = mean(pairs.map((pair) => pair.a - pair.b));
  if (clusters.length < 2)
    return {
      estimate,
      lower95: null,
      upper95: null,
      observations: pairs.length,
    };
  const random = seededRandom(seed);
  const distribution: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const selected: Pair[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    distribution.push(mean(selected.map((pair) => pair.a - pair.b)));
  }
  distribution.sort((left, right) => left - right);
  return {
    estimate,
    lower95: percentile(distribution, 0.025),
    upper95: percentile(distribution, 0.975),
    observations: pairs.length,
  };
}

export function compareExecutors(
  archives: readonly RunArchive[],
  executorA: string,
  executorB: string,
  options: PairedComparisonOptions = {},
): PairedComparison {
  const archivesA = archives.filter(
    (archive) => archive.manifest.executor.executorId === executorA,
  );
  const archivesB = archives.filter(
    (archive) => archive.manifest.executor.executorId === executorB,
  );
  const comparability = checkComparability([...archivesA, ...archivesB]);
  const matched = matchPairs(archivesA, archivesB);
  const minimumEffect = options.minimumEffect ?? 0;
  const completionDifference = clusterBootstrap(
    matched.pairs,
    options.bootstrapSamples ?? 10_000,
    options.seed ?? 1,
  );
  let decision: ComparisonDecision = "inconclusive";
  if (!comparability.comparable) decision = "not-comparable";
  else if (
    completionDifference.lower95 !== null &&
    completionDifference.lower95 > minimumEffect
  ) {
    decision = "a-better";
  } else if (
    completionDifference.upper95 !== null &&
    completionDifference.upper95 < -minimumEffect
  ) {
    decision = "b-better";
  }
  return {
    executorA,
    executorB,
    completionDifference,
    decision,
    minimumEffect,
    matchedPairs: matched.pairs.length,
    clusters: new Set(matched.pairs.map((pair) => pair.cluster)).size,
    attrition: {
      a: matched.droppedA,
      b: matched.droppedB,
      either: matched.droppedEither,
    },
    failureA: failureDistribution(archivesA),
    failureB: failureDistribution(archivesB),
    comparability,
  };
}
