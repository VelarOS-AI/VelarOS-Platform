/**
 * 批处理调度：按依赖图和并发上限把一批读、搜、准备、应用、校验、回滚任务交给内核执行，内核的 runBatch 交给这里。
 * 只经参数里的内核接口（BatchKernelLike）干活，不持有状态；工作池指标随结果返回，由内核记下。
 */
import { first, isEmpty, isFalse, isPresent } from '@velaros-ai/core'

import { ProjectPolicyDefaults } from '../../contract/constants.js'
import type { BatchConflict, BatchInput, BatchKernelLike, BatchResult, BatchTask, BatchTaskResult, DagPoolMetrics } from '../../types/batch.js'
import type { PreparedTransaction } from '../../types/edit.js'
import { ProjectError, toErrorObject } from '../errors.js'

/** 任务的依赖是不是都已经结束（跑完或已标记结束）。 */
function depsDone(task: BatchTask, done: Set<string>): boolean {
  return (task.dependsOn ?? []).every((id) => done.has(id));
}

/** 任务的依赖里有没有失败的。 */
function depsFailed(task: BatchTask, failed: Set<string>): boolean {
  return (task.dependsOn ?? []).some((id) => failed.has(id));
}

/** 把一个任务交给内核对应的公开方法执行；custom 任务直接调它自带的 run。 */
async function executeBatchTask(kernel: BatchKernelLike, task: BatchTask): Promise<any> {
  const op = task.op;
  switch (op.kind) {
    case "read": return kernel.read(op.input);
    case "search": return kernel.search(op.input);
    case "resolve": return kernel.resolveTarget(op.input);
    case "prepare": return kernel.prepareEdit(op.input);
    case "apply": return kernel.applyEdit(op.input);
    case "validate": return kernel.validate(op.input);
    case "rollback": return kernel.rollback(op.input);
    case "custom": return op.run();
    default: throw new ProjectError("NOT_SUPPORTED", "未知批处理操作", { task });
  }
}

/** 取事务里某个文件各补丁的偏移范围（补丁元数据里的 startOffset、endOffset），给冲突检测用。 */
function patchRange(tx: PreparedTransaction, file: string): Array<{ start?: number; end?: number }> {
  return tx.patches.filter((p) => p.path === file).map((p) => ({ start: p.metadata?.startOffset as number | undefined, end: p.metadata?.endOffset as number | undefined }));
}

/** 两段补丁范围重不重叠；任一边缺偏移时按重叠算，宁可报冲突也不放过。 */
function overlaps(a: { start?: number; end?: number }, b: { start?: number; end?: number }): boolean {
  if (!isPresent(a.start) || !isPresent(a.end) || !isPresent(b.start) || !isPresent(b.end)) return true;
  return a.start <= b.end && b.start <= a.end;
}

/** 找出同一批里改到同一个文件、补丁范围又重叠的两两事务，prepare-then-apply 据此在应用前停下。 */
function detectBatchConflicts(items: Array<{ taskId: string; tx: PreparedTransaction }>): BatchConflict[] {
  const conflicts: BatchConflict[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      for (const file of a.tx.changedFiles) {
        if (!b.tx.changedFiles.includes(file)) continue;
        const rangesA = patchRange(a.tx, file);
        const rangesB = patchRange(b.tx, file);
        const hasOverlap = rangesA.some((ra) => rangesB.some((rb) => overlaps(ra, rb)));
        if (hasOverlap) conflicts.push({ taskA: a.taskId, taskB: b.taskId, file, reason: !isEmpty(rangesA) && !isEmpty(rangesB) ? "OVERLAPPING_RANGE" : "SAME_FILE" });
      }
    }
  }
  return conflicts;
}

/**
 * 按依赖图和并发上限跑一批里选中的任务：槽位一空就补下一个就绪任务；依赖失败的连带标成 DEPENDENCY_FAILED，
 * 剩下跑不动的报未满足或循环依赖。返回各任务结果、已应用与已准备的事务、失败的任务和工作池指标。
 */
async function runDag(
  kernel: BatchKernelLike,
  input: BatchInput,
  only?: (task: BatchTask) => boolean,
  options?: { failedDependencyIds?: Set<string> },
): Promise<{ results: BatchTaskResult[]; appliedTransactions: string[]; prepared: Array<{ taskId: string; tx: PreparedTransaction }>; failed: boolean; failedTaskIds: Set<string>; metrics: DagPoolMetrics }> {
  // 默认并发取策略配置的上限（缺省策略见 ProjectPolicyDefaults），调用方仍可显式调小；硬上限始终是 maxConcurrentBatchTasks。
  const cap = kernel.policy?.maxConcurrentBatchTasks ?? ProjectPolicyDefaults.maxConcurrentBatchTasks;
  const concurrency = Math.max(1, Math.min(input.concurrency ?? cap, cap));
  const stopOnError = input.stopOnError ?? true;
  const selected = input.tasks.filter((task) => !only || only(task));
  const selectedIds = new Set(selected.map((task) => task.id));
  const remaining = new Map(selected.map((task) => [task.id, task]));
  const done = new Set<string>(input.tasks.filter((task) => !selectedIds.has(task.id)).map((task) => task.id));
  const failedTaskIds = new Set(options?.failedDependencyIds ?? []);
  const results: BatchTaskResult[] = [];
  const appliedTransactions: string[] = [];
  const prepared: Array<{ taskId: string; tx: PreparedTransaction }> = [];
  let failed = false;
  let activeCount = 0;
  let peakActive = 0;
  let maxQueuedReady = 0;

  function markDependencyFailed(task: BatchTask): void {
    const now = Date.now();
    failed = true;
    failedTaskIds.add(task.id);
    done.add(task.id);
    remaining.delete(task.id);
    results.push({
      id: task.id,
      ok: false,
      error: { code: "DEPENDENCY_FAILED", message: "依赖任务失败，当前任务未执行", dependsOn: task.dependsOn },
      startedAt: now,
      finishedAt: now,
    });
  }

  // 持续回填的工作池：任一槽位空出立刻补下一个就绪任务，避免「整波等齐」造成的队头阻塞。
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    function launch(task: BatchTask): void {
      activeCount += 1;
      const startedAt = Date.now();
      // 用 Promise.resolve().then 包一层，保证 custom 任务的「同步抛错」也走 rejection 分支。
      void Promise.resolve()
        .then(() => executeBatchTask(kernel, task))
        .then(
          (result) => {
            if (task.op.kind === "apply" && (result)?.transactionId) appliedTransactions.push((result).transactionId);
            if (task.op.kind === "prepare" && (result)?.transactionId) prepared.push({ taskId: task.id, tx: result as PreparedTransaction });
            results.push({ id: task.id, ok: true, result, startedAt, finishedAt: Date.now() });
          },
          (error) => {
            failed = true;
            failedTaskIds.add(task.id);
            results.push({ id: task.id, ok: false, error: toErrorObject(error), startedAt, finishedAt: Date.now() });
          },
        )
        .finally(() => {
          activeCount -= 1;
          done.add(task.id);
          tick();
        });
    }

    function tick(): void {
      if (settled) return;

      // stopOnError：一旦有任务失败就停止派发新任务，仅等在飞任务跑完即收尾
      //（与旧 wave 调度「下一轮 break」一致——剩余未启动任务不进入结果）。
      if (failed && stopOnError) {
        if (activeCount === 0) settle();
        return;
      }

      // 把「依赖已失败」的任务（含级联）一次性标记为 DEPENDENCY_FAILED，直到不再有变化。
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of [...remaining.values()]) {
          if (depsFailed(task, failedTaskIds)) {
            markDependencyFailed(task);
            changed = true;
          }
        }
      }

      if (remaining.size === 0) {
        if (activeCount === 0) settle();
        return;
      }

      const allReady = [...remaining.values()].filter((task) => depsDone(task, done));
      const slots = Math.max(0, concurrency - activeCount);
      const ready = allReady.slice(0, slots);
      // 就绪但因并发上限没排上的任务数（池子压力信号）。
      maxQueuedReady = Math.max(maxQueuedReady, allReady.length - ready.length);
      for (const task of ready) {
        remaining.delete(task.id);
        launch(task);
      }
      peakActive = Math.max(peakActive, activeCount);

      // 没有可调度任务、也没有在飞任务，但仍有剩余 → 未满足依赖或循环依赖。
      if (isEmpty(ready) && activeCount === 0 && remaining.size > 0) {
        for (const task of [...remaining.values()]) {
          results.push({ id: task.id, ok: false, error: { message: "存在未满足的依赖或循环依赖" }, startedAt: Date.now(), finishedAt: Date.now() });
          failedTaskIds.add(task.id);
          remaining.delete(task.id);
          failed = true;
        }
        settle();
      }
    }

    tick();
  });

  return { results, appliedTransactions, prepared, failed, failedTaskIds, metrics: { concurrency, peakActive, maxQueuedReady } };
}

/**
 * 跑一批任务：dag 模式依赖满足就跑；prepare-then-apply 先跑完非 apply 任务、查补丁冲突，没冲突再跑 apply。
 * atomic 的批次失败时按逆序回滚本批已应用的事务，回滚失败的另列在 rollbackFailures 里。
 */
export async function runBatch(kernel: BatchKernelLike, input: BatchInput): Promise<BatchResult> {
  const startedAt = Date.now();
  const rolledBackTransactions: string[] = [];
  const rollbackFailures: Array<{ transactionId: string; error: any }> = [];
  const preparedTransactions: PreparedTransaction[] = [];
  const phaseMetrics: DagPoolMetrics[] = [];
  let allResults: BatchTaskResult[] = [];
  let appliedTransactions: string[] = [];
  let failed = false;

  const buildMetrics = (): BatchResult["metrics"] => ({
    totalTasks: allResults.length,
    concurrencyLimit: first(phaseMetrics)?.concurrency ?? 0,
    peakActive: Math.max(0, ...phaseMetrics.map((m) => m.peakActive)),
    maxQueuedReady: Math.max(0, ...phaseMetrics.map((m) => m.maxQueuedReady)),
    durationMs: Date.now() - startedAt,
  });

  if (input.mode === "prepare-then-apply") {
    // prepare-then-apply 先集中生成补丁，再统一检测冲突，最后执行 apply 阶段。
    const nonApply = await runDag(kernel, input, (task) => task.op.kind !== "apply");
    phaseMetrics.push(nonApply.metrics);
    allResults = allResults.concat(nonApply.results);
    failed = nonApply.failed;
    preparedTransactions.push(...nonApply.prepared.map((p) => p.tx));
    const conflicts = isFalse(input.conflictCheck) ? [] : detectBatchConflicts(nonApply.prepared);
    if (!isEmpty(conflicts)) return { ok: false, results: allResults, conflicts, rolledBackTransactions, preparedTransactions, metrics: buildMetrics() };
    if (!failed || isFalse(input.stopOnError)) {
      const apply = await runDag(kernel, input, (task) => task.op.kind === "apply", {
        failedDependencyIds: nonApply.failedTaskIds,
      });
      phaseMetrics.push(apply.metrics);
      allResults = allResults.concat(apply.results);
      appliedTransactions = appliedTransactions.concat(apply.appliedTransactions);
      failed = failed || apply.failed;
    }
  } else {
    const dag = await runDag(kernel, input);
    phaseMetrics.push(dag.metrics);
    allResults = dag.results;
    appliedTransactions = dag.appliedTransactions;
    preparedTransactions.push(...dag.prepared.map((p) => p.tx));
    failed = dag.failed;
  }

  if (input.atomic && failed) {
    // atomic 失败时只回滚本批次已经 apply 成功的事务，且按逆序回滚。
    for (const tx of [...appliedTransactions].reverse()) {
      try {
        await kernel.rollback({ transactionId: tx });
        rolledBackTransactions.push(tx);
      } catch (error) {
        // rollback 失败不覆盖原 batch 结果，但必须显式上报：否则调用方会误以为
        // atomic 已完整撤销，而磁盘上仍残留该事务写入。详情仍保留在 transaction/journal。
        rollbackFailures.push({ transactionId: tx, error: toErrorObject(error) });
      }
    }
  }

  const result: BatchResult = {
    ok: allResults.every((r) => r.ok),
    results: allResults,
    rolledBackTransactions,
    preparedTransactions,
    metrics: buildMetrics(),
  };
  if (!isEmpty(rollbackFailures)) {
    result.rollbackFailures = rollbackFailures;
  }
  return result;
}
