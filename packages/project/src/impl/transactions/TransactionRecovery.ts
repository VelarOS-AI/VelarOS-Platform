/**
 * 事务写盘与恢复：`TransactionRecovery`。接口 `TransactionRecoveryApi`、注入依赖 `TransactionRecoveryDependencies` 与文件端口 `TransactionRecoveryStore` 在本文件的类上方。
 * 按字节计划写补丁、写前预检，写盘前捕获原状态，失败或重启后按落盘的恢复计划把文件恢复成原状；计划与判定的纯函数在 `utils/transactions/`。
 */

import { isString, isUndefined, optionalWhen } from "@velaros-ai/core";

import type { PreparedPatch } from "../../types/edit.js";
import type { ProjectFileAccess } from "../../types/file-access.js";
import type { ProjectExpectedBytes } from "../../types/files.js";
import type { FileSnapshot } from "../../types/snapshot.js";
import type { ProjectTextEncoding } from "../../types/text.js";
import type { ApplyRestoreState, ProjectTransactionPendingOperation, ProjectTransactionRestoreEntry, StoredTransaction, TransactionBytePlan } from "../../types/transaction.js";
import { ProjectError } from "../../utils/errors.js";
import { decodeProjectTextBuffer } from "../../utils/text.js";
import { bytesEqual, decodeStoredBytes } from "../../utils/transactions/byte-codec.js";
import { bytePatchFor, plannedBytes, prepareTransactionBytePlan } from "../../utils/transactions/byte-plan.js";
import { patchFileAttributes, patchTargetEncoding } from "../../utils/transactions/patch-attributes.js";
import { durableRestorePlan, fileStateMatches, refreshRecoveredBaseRevisions } from "../../utils/transactions/recovery-plan.js";

/** 事务写盘与恢复要用的文件端口：读快照、读原字节，以及带字节预检的写与删。内核把自己的 FileStore 交进来。 */
export interface TransactionRecoveryStore extends Pick<ProjectFileAccess, "snapshot"> {
  /** 删除一个文件；给了 expectedBytes 时先核对磁盘上的字节，对不上抛 CONFLICT_WITH_EXTERNAL_EDIT。 */
  remove(
    path: string,
    options?: {
      skipFileFilter?: boolean;
      expectedBytes?: ProjectExpectedBytes;
    },
  ): Promise<void>;
  /** 读文件的原始字节（受读取上限约束）；文件不存在返回 undefined。 */
  readTransactionBytes(path: string): Promise<Uint8Array | undefined>;
  /** 写一个文本文件：给了 transactionBytes 就原样写这些字节（先按 expectedBytes 预检），否则按 encoding 编码正文；返回写后的快照。 */
  write(
    path: string,
    content: string,
    options?: {
      skipFileFilter?: boolean;
      encoding?: ProjectTextEncoding;
      mode?: number;
      transactionBytes?: Uint8Array;
      expectedBytes?: ProjectExpectedBytes;
    },
  ): Promise<FileSnapshot>;
}

/** 事务写盘与恢复要内核注入的东西。 */
export interface TransactionRecoveryDependencies {
  /** 读写项目文件的端口。 */
  readonly store: TransactionRecoveryStore;
}

/**
 * 事务写盘与恢复：内存里按事务号保存字节计划（每个补丁写前、写后的确切字节），写补丁时按计划写并预检磁盘现状；
 * 写盘前捕获原状态，失败或重启后按落盘的恢复计划恢复，只覆盖能归属于本事务的内容。实例由内核持有，一个内核一份。
 */
export interface TransactionRecoveryApi {
  /** 拷一份当前全部字节计划（事务号 → 计划），失败时交给 restoreBytePlans 还原。 */
  captureBytePlans(): ReadonlyMap<string, TransactionBytePlan>;
  /** 用 captureBytePlans 拷下的那份整个替换当前的字节计划。 */
  restoreBytePlans(plans: ReadonlyMap<string, TransactionBytePlan>): void;
  /** 装入从落盘状态读回的字节计划；同一事务号的覆盖旧的。 */
  hydrateBytePlans(plans: readonly TransactionBytePlan[]): void;
  /** 要落盘的字节计划：只留仍在给定事务列表里的那些。 */
  persistedBytePlans(transactions: readonly StoredTransaction[]): TransactionBytePlan[];
  /** 删掉一个事务的字节计划（事务被淘汰或丢弃时）。 */
  deleteBytePlan(transactionId: string): void;
  /**
   * 按写盘前捕获的原字节为事务准备字节计划并记下：每个补丁写前、写后的确切字节，原字节取不到的路径标 beforeUnavailable。
   * 原文在准备期间变了、原文件无法无损解码、目标字节无法无损回读都抛出，计划不记。
   */
  prepareBytePlan(transaction: StoredTransaction, restore: ReadonlyMap<string, ApplyRestoreState>): void;
  /**
   * 为 apply 或 rollback 建落盘的恢复计划：每个改动路径的原状态，以及本事务写下后可能留下的各个状态（带字节计划里的字节）。
   * 有路径捕获不到可还原的原文、或找不到本事务留下的状态，抛 PATCH_APPLY_ERROR。
   */
  durableRestorePlan(
    transaction: StoredTransaction,
    kind: ProjectTransactionPendingOperation["kind"],
    restore: Map<string, ApplyRestoreState>,
  ): ProjectTransactionRestoreEntry[];
  /**
   * 写下一个补丁：apply 写新正文，rollback 写原文。有字节计划就原样写计划里的字节并预检磁盘现状（apply 时原字节取不到的不预检），
   * 没有就按目标编码（rollback 用原编码）写文本；返回写后的快照。预检对不上抛 CONFLICT_WITH_EXTERNAL_EDIT。
   */
  writePatch(transaction: StoredTransaction, patch: PreparedPatch, kind: "apply" | "rollback"): Promise<FileSnapshot>;
  /** 按补丁删除文件（删除类补丁 apply、新建类补丁 rollback）；有字节计划时先预检磁盘字节，对不上抛 CONFLICT_WITH_EXTERNAL_EDIT。 */
  removePatch(transaction: StoredTransaction, patch: PreparedPatch, kind: "apply" | "rollback"): Promise<void>;
  /** 写之前核对磁盘上的字节仍是计划里的写前字节，对不上抛 CONFLICT_WITH_EXTERNAL_EDIT；没有字节计划、或 apply 时原字节本就取不到的跳过。 */
  assertPatchBytes(transaction: StoredTransaction, patch: PreparedPatch, kind: "apply" | "rollback"): Promise<void>;
  /** 写盘前捕获每个路径的原始状态（是否存在、正文、原字节、编码、权限、能否还原），供失败时回滚；只读。捕获期间正文变了抛 CONFLICT_WITH_EXTERNAL_EDIT。 */
  captureApplyRestoreState(paths: readonly string[]): Promise<Map<string, ApplyRestoreState>>;
  /** 写盘中途失败时，把已经写过的路径恢复成写前状态；同 restore，外部改过的内容拒绝覆盖。 */
  restoreAppliedFiles(
    writtenOrder: readonly string[],
    restoreByPath: Map<string, ApplyRestoreState>,
    transaction: StoredTransaction,
    kind: ProjectTransactionPendingOperation["kind"],
  ): Promise<void>;
  /**
   * 按恢复计划把文件恢复成原状：先核对全部路径——当前内容要么已是原状态，要么是本事务留下的某个状态，
   * 否则抛 TRANSACTION_RECOVERY_CONFLICT 且一个文件都不动；再逐个写回或删除。恢复的是 apply 时顺带刷新事务各路径首个补丁的 base revision。
   */
  restore(pending: ProjectTransactionPendingOperation, transaction?: StoredTransaction): Promise<void>;
}

export class TransactionRecovery implements TransactionRecoveryApi {
  private readonly bytePlans = new Map<string, TransactionBytePlan>();

  public constructor(private readonly dependencies: TransactionRecoveryDependencies) {}

  public captureBytePlans(): ReadonlyMap<string, TransactionBytePlan> {
    return new Map(this.bytePlans);
  }
  public restoreBytePlans(
    plans: ReadonlyMap<string, TransactionBytePlan>,
  ): void {
    this.bytePlans.clear();
    for (const [id, plan] of plans) this.bytePlans.set(id, plan);
  }

  public hydrateBytePlans(plans: readonly TransactionBytePlan[]): void {
    for (const plan of plans) this.bytePlans.set(plan.transactionId, plan);
  }

  public persistedBytePlans(
    transactions: readonly StoredTransaction[],
  ): TransactionBytePlan[] {
    const retained = new Set(
      transactions.map((transaction) => transaction.transactionId),
    );
    return [...this.bytePlans.values()].filter((plan) =>
      retained.has(plan.transactionId),
    );
  }
  public deleteBytePlan(transactionId: string): void {
    this.bytePlans.delete(transactionId);
  }

  public prepareBytePlan(
    transaction: StoredTransaction,
    restore: ReadonlyMap<string, ApplyRestoreState>,
  ): void {
    this.bytePlans.set(
      transaction.transactionId,
      prepareTransactionBytePlan(
        transaction,
        new Map(
          [...restore].map(([path, state]) => [
            path,
            decodeStoredBytes(state.bytes),
          ]),
        ),
        new Set(
          [...restore]
            .filter(([, state]) => state.existedBefore && !state.restorable)
            .map(([path]) => path),
        ),
      ),
    );
  }

  public durableRestorePlan(
    transaction: StoredTransaction,
    kind: ProjectTransactionPendingOperation["kind"],
    restore: Map<string, ApplyRestoreState>,
  ): ProjectTransactionRestoreEntry[] {
    return durableRestorePlan(
      transaction,
      kind,
      restore,
      this.bytePlans.get(transaction.transactionId),
    );
  }

  public async writePatch(
    transaction: StoredTransaction,
    patch: PreparedPatch,
    kind: "apply" | "rollback",
  ): Promise<FileSnapshot> {
    const entry = bytePatchFor(
      this.bytePlans.get(transaction.transactionId),
      patch,
    );
    const bytes = entry ? plannedBytes(entry, kind) : undefined;
    const attributes = patchFileAttributes(patch);
    // 没有字节计划时的文本写入也要遵守编码转换的目标；回滚一律回到原编码。
    const target = kind === "apply" ? patchTargetEncoding(patch) : undefined;
    return this.dependencies.store.write(
      patch.path,
      (kind === "apply" ? patch.newContent : patch.oldContent) ?? "",
      {
        skipFileFilter: true,
        encoding: target ?? attributes.textEncoding,
        mode: attributes.mode,
        transactionBytes: bytes?.after,
        expectedBytes:
          bytes && !(kind === "apply" && entry?.beforeUnavailable)
            ? { exists: !isUndefined(bytes.before), bytes: bytes.before }
            : undefined,
      },
    );
  }

  public async removePatch(
    transaction: StoredTransaction,
    patch: PreparedPatch,
    kind: "apply" | "rollback",
  ): Promise<void> {
    const entry = bytePatchFor(
      this.bytePlans.get(transaction.transactionId),
      patch,
    );
    const bytes = entry ? plannedBytes(entry, kind) : undefined;
    await this.dependencies.store.remove(patch.path, {
      skipFileFilter: true,
      expectedBytes:
        bytes && !(kind === "apply" && entry?.beforeUnavailable)
          ? { exists: !isUndefined(bytes.before), bytes: bytes.before }
          : undefined,
    });
  }

  public async assertPatchBytes(
    transaction: StoredTransaction,
    patch: PreparedPatch,
    kind: "apply" | "rollback",
  ): Promise<void> {
    const entry = bytePatchFor(
      this.bytePlans.get(transaction.transactionId),
      patch,
    );
    if (!entry || (kind === "apply" && entry.beforeUnavailable)) return;
    const current = await this.dependencies.store.readTransactionBytes(
      patch.path,
    );
    if (!bytesEqual(current, plannedBytes(entry, kind).before))
      throw new ProjectError(
        "CONFLICT_WITH_EXTERNAL_EDIT",
        "事务字节预检发现外部修改。",
        { path: patch.path, transactionId: transaction.transactionId },
      );
  }

  /** 写盘前捕获每个受影响路径的原始状态，供 apply 失败时回滚（只读，不改写盘语义）。 */
  public async captureApplyRestoreState(
    paths: readonly string[],
  ): Promise<Map<string, ApplyRestoreState>> {
    const restoreByPath = new Map<string, ApplyRestoreState>();
    for (const file of paths) {
      if (restoreByPath.has(file)) continue;
      const before = await this.dependencies.store.snapshot(file, true, {
        skipFileFilter: true,
      });
      const bytes = isString(before.content)
        ? await this.dependencies.store.readTransactionBytes(file)
        : undefined;
      if (
        bytes &&
        isString(before.content) &&
        decodeProjectTextBuffer(bytes) !== before.content
      )
        throw new ProjectError(
          "CONFLICT_WITH_EXTERNAL_EDIT",
          "捕获事务原字节时文件正文变化。",
          { path: file },
        );
      restoreByPath.set(file, {
        bytes: bytes ? Buffer.from(bytes).toString("base64") : undefined,
        existedBefore: before.exists && !before.isDirectory,
        // 仅文本文件可按字符串还原；二进制/超限文件无法捕获正文，回滚时尽力而为。
        oldContent: optionalWhen(isString(before.content), before.content),
        encoding: before.textEncoding,
        mode: before.mode,
        restorable:
          isString(before.content) || !before.exists || before.isDirectory,
      });
    }
    return restoreByPath;
  }

  /** 内存事务也使用内容归属预检；失败恢复不能覆盖此间发生的外部编辑。 */
  public async restoreAppliedFiles(
    writtenOrder: readonly string[],
    restoreByPath: Map<string, ApplyRestoreState>,
    transaction: StoredTransaction,
    kind: ProjectTransactionPendingOperation["kind"],
  ): Promise<void> {
    const attempted = {
      ...transaction,
      changedFiles: [...new Set(writtenOrder)],
    };
    await this.restore(
      {
        transactionId: transaction.transactionId,
        previousStatus: transaction.status,
        kind,
        restore: this.durableRestorePlan(attempted, kind, restoreByPath),
      },
      transaction,
    );
  }
  public async restore(
    pending: ProjectTransactionPendingOperation,
    transaction?: StoredTransaction,
  ): Promise<void> {
    const recovered = new Map<string, FileSnapshot>();
    const writes: Array<{
      restore: ProjectTransactionPendingOperation["restore"][number];
      expected?: Uint8Array;
    }> = [];
    for (const restore of [...pending.restore].reverse()) {
      const current = await this.dependencies.store.snapshot(
        restore.path,
        true,
        {
          skipFileFilter: true,
        },
      );
      const currentBytes =
        current.exists && !current.isDirectory
          ? await this.dependencies.store.readTransactionBytes(restore.path)
          : undefined;
      const matches = (state: (typeof restore.ownedStates)[number]) =>
        fileStateMatches(current, state) &&
        (isUndefined(state.bytes) ||
          bytesEqual(currentBytes, decodeStoredBytes(state.bytes)));
      if (matches(restore)) {
        recovered.set(restore.path, current);
        continue;
      }
      if (!restore.ownedStates.some(matches)) {
        throw new ProjectError(
          "TRANSACTION_RECOVERY_CONFLICT",
          `事务恢复拒绝覆盖无法归属于本事务的外部内容：${restore.path}`,
          {
            transactionId: pending.transactionId,
            operation: pending.kind,
            path: restore.path,
            actualRevision: current.revision,
          },
          "请先人工保全当前文件，再决定保留外部内容还是事务恢复点。",
        );
      }
      writes.push({ restore, expected: currentBytes });
    }
    // 先检查全部路径，避免发现后面的外部冲突时，前面的文件已经被恢复。
    for (const { restore, expected } of writes) {
      if (restore.exists) {
        const snapshot = await this.dependencies.store.write(
          restore.path,
          restore.content!,
          {
            skipFileFilter: true,
            encoding: restore.encoding,
            transactionBytes: decodeStoredBytes(restore.bytes),
            expectedBytes: { exists: !isUndefined(expected), bytes: expected },
            mode: restore.mode,
          },
        );
        recovered.set(restore.path, snapshot);
      } else {
        await this.dependencies.store.remove(restore.path, {
          skipFileFilter: true,
          expectedBytes: { exists: !isUndefined(expected), bytes: expected },
        });
        const snapshot = await this.dependencies.store.snapshot(
          restore.path,
          true,
          {
            skipFileFilter: true,
          },
        );
        recovered.set(restore.path, snapshot);
      }
    }
    if (transaction && pending.kind === "apply")
      refreshRecoveredBaseRevisions(transaction, recovered);
  }
}
