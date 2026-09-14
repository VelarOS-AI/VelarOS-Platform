import { isString, isUndefined, optionalWhen } from "@velaros-ai/core";

import { ProjectError } from "../errors.js";
import { type ProjectTransactionPendingOperation } from "../persistence/transaction-state.js";
import type { PreparedPatch } from "../types/edit.js";
import type { ProjectFileAccess } from "../types/file-access.js";
import type { FileSnapshot } from "../types/snapshot.js";
import type { StoredTransaction } from "../types/transaction.js";
import { decodeProjectTextBuffer } from "../utils/text.js";

import { bytesEqual, decodeStoredBytes } from "./byte-codec.js";
import {
  bytePatchFor,
  plannedBytes,
  prepareTransactionBytePlan,
  type TransactionBytePlan,
} from "./byte-plan.js";
import { patchFileAttributes, patchTargetEncoding } from "./patch-attributes.js";
import {
  type ApplyRestoreState,
  durableRestorePlan,
  fileStateMatches,
  refreshRecoveredBaseRevisions,
} from "./recovery-plan.js";
interface TransactionRecoveryDependencies {
  readonly store: Pick<ProjectFileAccess, "snapshot"> & {
    remove(
      path: string,
      options?: {
        skipFileFilter?: boolean;
        expectedBytes?: { exists: boolean; bytes?: Uint8Array };
      },
    ): Promise<void>;
    readTransactionBytes(path: string): Promise<Uint8Array | undefined>;
    write(
      path: string,
      content: string,
      options?: {
        skipFileFilter?: boolean;
        encoding?: import("../types/text.js").ProjectTextEncoding;
        mode?: number;
        transactionBytes?: Uint8Array;
        expectedBytes?: { exists: boolean; bytes?: Uint8Array };
      },
    ): Promise<FileSnapshot>;
  };
}
export class TransactionRecovery {
  private readonly bytePlans = new Map<string, TransactionBytePlan>();

  constructor(private readonly dependencies: TransactionRecoveryDependencies) {}

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
  ) {
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
