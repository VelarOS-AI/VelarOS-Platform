import type {
  JobSpec,
  LabDriver,
  RunArchive,
  TrialSpec,
} from "../protocol/index.js";

export interface JobRuntime {
  readonly runTrial: (
    trial: TrialSpec,
    driver: LabDriver,
  ) => Promise<RunArchive>;
  readonly resolveDriver: (trial: TrialSpec) => Promise<LabDriver> | LabDriver;
  readonly onArchive?: (archive: RunArchive) => Promise<void> | void;
}

export async function runJob(
  job: JobSpec,
  runtime: JobRuntime,
): Promise<readonly RunArchive[]> {
  const pending = [...job.trials];
  const archives: RunArchive[] = [];
  const workers = Array.from(
    { length: Math.min(job.concurrency, pending.length) },
    async (): Promise<void> => {
      for (;;) {
        const trial = pending.shift();
        if (!trial) return;
        const driver = await runtime.resolveDriver(trial);
        const archive = await runtime.runTrial(trial, driver);
        archives.push(archive);
        await runtime.onArchive?.(archive);
      }
    },
  );
  await Promise.all(workers);
  return archives.sort((left, right) =>
    left.manifest.trial.id.localeCompare(right.manifest.trial.id),
  );
}

export interface MatrixJobInput {
  readonly id: string;
  readonly suiteId: string;
  readonly journeyIds: ReadonlyArray<{
    readonly id: string;
    readonly version: number;
  }>;
  readonly executorIds: readonly string[];
  readonly arms?: ReadonlyArray<string | null>;
  readonly replicates?: number;
  readonly seed?: number;
  readonly concurrency?: number;
  readonly archiveDirectory: string;
}

export function createMatrixJob(input: MatrixJobInput): JobSpec {
  const arms = input.arms?.length ? input.arms : [null];
  const replicates = input.replicates ?? 1;
  const seed = input.seed ?? 1;
  const trials: TrialSpec[] = [];
  for (const journey of input.journeyIds) {
    for (const executorId of input.executorIds) {
      for (const arm of arms) {
        const groupId = `${input.id}:${journey.id}:${arm ?? "default"}`;
        for (let index = 1; index <= replicates; index += 1) {
          trials.push({
            id: `${groupId}:${executorId}:r${index}`,
            journeyId: journey.id,
            journeyVersion: journey.version,
            executorId,
            arm,
            replicate: {
              groupId,
              index,
              ofK: replicates,
              seed: seed + index - 1,
            },
          });
        }
      }
    }
  }
  return {
    id: input.id,
    suiteId: input.suiteId,
    trials,
    concurrency: input.concurrency ?? 1,
    archiveDirectory: input.archiveDirectory,
  };
}
