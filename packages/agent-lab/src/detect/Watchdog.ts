import type { Finding, Observation } from "../protocol/index.js";

import type { LoopThresholds } from "./Builtins.js";
import { DefaultLoopThresholds } from "./Builtins.js";
import { collectToolCalls, normalizeObservation } from "./Normalize.js";

export interface WatchdogSignal {
  readonly detectorId: string;
  readonly key: string;
  readonly count: number;
  readonly abortAt: number;
  readonly reason: string;
}

export interface WatchdogBaseline {
  readonly counts: Readonly<Record<string, number>>;
  readonly findingKeys: readonly string[];
}

function signalCounts(
  observation: Observation,
  thresholds: LoopThresholds,
): readonly WatchdogSignal[] {
  const calls = collectToolCalls(observation);
  const repeatCounts = new Map<string, number>();
  const toolMapCounts = new Map<string, number>();
  let previousRetryKey: string | null = null;
  let consecutiveRetryCount = 0;
  for (const call of calls) {
    const input = JSON.stringify(call.input);
    const retryKey = `${call.name}\u0000${input}`;
    consecutiveRetryCount = retryKey === previousRetryKey ? consecutiveRetryCount + 1 : 1;
    repeatCounts.set(
      retryKey,
      Math.max(repeatCounts.get(retryKey) ?? 0, consecutiveRetryCount),
    );
    previousRetryKey = retryKey;
    if (call.name === "tooling:map") {
      toolMapCounts.set(input, (toolMapCounts.get(input) ?? 0) + 1);
    }
  }

  const signals: WatchdogSignal[] = [];
  for (const [key, count] of repeatCounts) {
    signals.push({
      detectorId: "tool-retry-loop",
      key: `retry:${key}`,
      count,
      abortAt: thresholds.retryAbort,
      reason: `同一工具与参数在本次等待窗口连续重复 ${count} 次`,
    });
  }
  for (const [key, count] of toolMapCounts) {
    signals.push({
      detectorId: "toolmap-read-loop",
      key: `toolmap:${key}`,
      count,
      abortAt: thresholds.toolMapReadAbort,
      reason: `同一工具目录页在本次等待窗口读取 ${count} 次`,
    });
  }
  for (const turn of normalizeObservation(observation).turns) {
    signals.push({
      detectorId: "turn-tool-density",
      key: `turn:${turn.id}`,
      count: turn.toolCalls.length,
      abortAt: thresholds.turnDensityAbort,
      reason: `单轮工具调用在本次等待窗口达到 ${turn.toolCalls.length} 次`,
    });
  }
  return signals;
}

function findingKey(finding: Finding): string {
  return `${finding.detectorId}\u0000${finding.summary}`;
}

export function createWatchdogBaseline(
  observation: Observation,
  findings: readonly Finding[],
  activeDetectorIds: ReadonlySet<string>,
  thresholds: LoopThresholds = DefaultLoopThresholds,
): WatchdogBaseline {
  return {
    counts: Object.fromEntries(
      signalCounts(observation, thresholds)
        .filter((signal) => activeDetectorIds.has(signal.detectorId))
        .map((signal) => [signal.key, signal.count]),
    ),
    findingKeys: findings
      .filter((finding) => activeDetectorIds.has(finding.detectorId))
      .map(findingKey),
  };
}

export function selectAbortCandidate(
  observation: Observation,
  findings: readonly Finding[],
  baseline: WatchdogBaseline,
  activeDetectorIds: ReadonlySet<string>,
  thresholds: LoopThresholds = DefaultLoopThresholds,
): WatchdogSignal | null {
  for (const signal of signalCounts(observation, thresholds).filter((item) =>
    activeDetectorIds.has(item.detectorId),
  )) {
    const delta = signal.count - (baseline.counts[signal.key] ?? 0);
    if (delta >= signal.abortAt) return { ...signal, count: delta };
  }
  const baselineFindings = new Set(baseline.findingKeys);
  const fatal = findings.find(
    (item) =>
      activeDetectorIds.has(item.detectorId) &&
      item.severity === "fail" &&
      !baselineFindings.has(findingKey(item)),
  );
  return fatal
    ? {
        detectorId: fatal.detectorId,
        key: findingKey(fatal),
        count: 1,
        abortAt: 1,
        reason: fatal.summary,
      }
    : null;
}
