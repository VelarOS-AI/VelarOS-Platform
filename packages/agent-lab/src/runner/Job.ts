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

/**
 * 跑完一个 job 的全部试验。
 *
 * 一个试验失败就**停止派发**并等在飞的试验收尾，再把第一个错误抛给调用方。原先是
 * `Promise.all` 一拒绝就返回，其余 worker 却还在队列里取试验、开会话、发提示词——调用方早已
 * 拿不到它们的归档，被测执行体那边却还在跑，会话与费用都在后台继续。
 */
export async function runJob(
  job: JobSpec,
  runtime: JobRuntime,
): Promise<readonly RunArchive[]> {
  const pending = [...job.trials];
  const archives: RunArchive[] = [];
  let failed = false;
  let failure: unknown = null;
  const workers = Array.from(
    { length: Math.min(job.concurrency, pending.length) },
    async (): Promise<void> => {
      for (;;) {
        if (failed) return;
        const trial = pending.shift();
        if (!trial) return;
        try {
          const driver = await runtime.resolveDriver(trial);
          const archive = await runtime.runTrial(trial, driver);
          archives.push(archive);
          await runtime.onArchive?.(archive);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
          return;
        }
      }
    },
  );
  // worker 自己不再抛，所以这里一定等到每个在飞的试验都收了尾，不留后台会话。
  await Promise.all(workers);
  if (failed) throw failure;
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
