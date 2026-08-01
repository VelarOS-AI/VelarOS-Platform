import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RunArchive } from "../protocol/index.js";
import { parseRunArchive } from "../protocol/index.js";

import { readRunArchiveView } from "./ArchiveView.js";

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(runId)) {
    throw new Error(`Unsafe run id: ${runId}`);
  }
}

function archivePath(root: string, runId: string): string {
  assertSafeRunId(runId);
  return join(resolve(root), runId, "report.json");
}

/**
 * Writes a validated v3 archive atomically. Historical archives are read-only and never enter here.
 */
export async function writeRunArchive(
  root: string,
  archive: RunArchive,
): Promise<string> {
  const parsed = parseRunArchive(archive);
  const target = archivePath(root, parsed.manifest.runId);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporary, target);
  return target;
}

export async function readRunArchive(
  path: string,
): Promise<ReturnType<typeof readRunArchiveView>> {
  const text = await readFile(path, "utf8");
  return readRunArchiveView(JSON.parse(text));
}

export interface HistoryEntry {
  readonly recordedAt: number;
  readonly runId: string;
  readonly trialId: string;
  readonly journeyId: string;
  readonly journeyVersion: number;
  readonly executorId: string;
  readonly taskDigest: string;
  readonly passedLegs: number | null;
  readonly totalLegs: number;
  readonly drops: number;
  readonly failuresByClass: Readonly<Record<string, number>>;
}

export function createHistoryEntry(archive: RunArchive): HistoryEntry {
  const knownLegs = archive.legs.filter((leg) => leg.passed !== null);
  const failuresByClass: Record<string, number> = {};
  for (const finding of archive.findings) {
    failuresByClass[finding.failureClass] =
      (failuresByClass[finding.failureClass] ?? 0) + 1;
  }
  for (const leg of archive.legs) {
    for (const criterion of leg.criteria) {
      if (criterion.outcome.kind !== "fail") continue;
      failuresByClass[criterion.outcome.failureClass] =
        (failuresByClass[criterion.outcome.failureClass] ?? 0) + 1;
    }
  }
  return {
    recordedAt: archive.manifest.finishedAt,
    runId: archive.manifest.runId,
    trialId: archive.manifest.trial.id,
    journeyId: archive.journey.id,
    journeyVersion: archive.journey.version,
    executorId: archive.manifest.executor.executorId,
    taskDigest: archive.manifest.harness.taskDigest,
    passedLegs:
      knownLegs.length === 0
        ? null
        : knownLegs.filter((leg) => leg.passed === true).length,
    totalLegs: archive.legs.length,
    drops: archive.drops.length,
    failuresByClass,
  };
}

export async function appendHistory(
  path: string,
  archive: RunArchive,
): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(createHistoryEntry(archive))}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}
