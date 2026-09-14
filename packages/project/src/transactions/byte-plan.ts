import { isString, isUndefined } from "@velaros-ai/core";

import { ProjectError } from "../errors.js";
import type { PreparedPatch } from "../types/edit.js";
import type { StoredTransaction } from "../types/transaction.js";
import {
  decodeProjectTextBuffer,
  detectProjectTextEncoding,
  encodeProjectTextBuffer,
} from "../utils/text.js";

import {
  decodeStoredBytes,
  encodePreservingProjectBytes,
} from "./byte-codec.js";
import { patchFileAttributes, patchTargetEncoding } from "./patch-attributes.js";
import { isDeletePatch } from "./transaction-overlay.js";

/** 私有持久化记录；不会附加到补丁、快照或模型回执。 */
export interface TransactionBytePatch {
  readonly patchId: string;
  readonly path: string;
  readonly before?: string;
  readonly beforeUnavailable?: true;
  readonly after?: string;
}

export interface TransactionBytePlan {
  readonly transactionId: string;
  readonly patches: readonly TransactionBytePatch[];
}

export function prepareTransactionBytePlan(
  transaction: StoredTransaction,
  originals: ReadonlyMap<string, Uint8Array | undefined>,
  unavailable: ReadonlySet<string> = new Set(),
): TransactionBytePlan {
  const staged = new Map(originals);
  const deleted = new Map<string, Uint8Array>();
  const patches: TransactionBytePatch[] = [];
  const unknown = new Set(unavailable);
  for (const patch of transaction.patches) {
    const before = staged.get(patch.path);
    const beforeUnavailable = unknown.has(patch.path);
    if (
      !isUndefined(before) &&
      isString(patch.oldContent) &&
      decodeProjectTextBuffer(before) !== patch.oldContent
    )
      throw new ProjectError(
        "CONFLICT_WITH_EXTERNAL_EDIT",
        "字节计划准备期间文件正文变化。",
        { path: patch.path },
      );
    let after: Uint8Array | undefined;
    if (!isDeletePatch(patch)) {
      const sourcePath =
        patch.metadata?.op === "rename_file_create"
          ? patch.metadata.from
          : undefined;
      const source = isString(sourcePath)
        ? (staged.get(sourcePath) ?? deleted.get(sourcePath))
        : before;
      const content = patch.newContent ?? "";
      // 编码转换按目标编码整体重编码；其余写入保留原文件编码与可定位的原字节。
      const target = patchTargetEncoding(patch);
      const encoding =
        target ??
        (source
          ? detectProjectTextEncoding(source)
          : (patchFileAttributes(patch).textEncoding ?? "utf8"));
      if (!encoding)
        throw new ProjectError(
          "NOT_SUPPORTED",
          "原文件无法无损解码，拒绝构造字节计划。",
          { path: patch.path },
        );
      after =
        source && !target
          ? encodePreservingProjectBytes(
              source,
              decodeProjectTextBuffer(source)!,
              content,
              encoding,
            )
          : encodeProjectTextBuffer(content, encoding);
      // 无 BOM UTF-16 改为短文本后可能失去可识别性，由框架加同字节序 BOM。
      if (
        (encoding === "utf16le-nobom" || encoding === "utf16be-nobom") &&
        decodeProjectTextBuffer(after) !== content
      )
        after = encodeProjectTextBuffer(
          content,
          encoding === "utf16le-nobom" ? "utf16le" : "utf16be",
        );
    }
    if (after && decodeProjectTextBuffer(after) !== (patch.newContent ?? ""))
      throw new ProjectError(
        "INVALID_INPUT",
        "框架无法生成可无损回读的目标字节，事务尚未写入。",
        { path: patch.path },
      );
    if (isDeletePatch(patch) && before) deleted.set(patch.path, before);
    staged.set(patch.path, after);
    unknown.delete(patch.path);
    patches.push({
      patchId: patch.patchId,
      path: patch.path,
      beforeUnavailable: beforeUnavailable ? true : undefined,
      before: before ? Buffer.from(before).toString("base64") : undefined,
      after: after ? Buffer.from(after).toString("base64") : undefined,
    });
  }
  return { transactionId: transaction.transactionId, patches };
}

const BytePlanIndexes = new WeakMap<
  TransactionBytePlan,
  ReadonlyMap<string, TransactionBytePatch>
>();

export function bytePatchFor(
  plan: Optional<TransactionBytePlan>,
  patch: PreparedPatch,
): TransactionBytePatch | undefined {
  if (!plan) return undefined;
  let index = BytePlanIndexes.get(plan);
  if (!index) {
    index = new Map(
      plan.patches.map((value) => [`${value.path}\0${value.patchId}`, value]),
    );
    BytePlanIndexes.set(plan, index);
  }
  return index.get(`${patch.path}\0${patch.patchId}`);
}

export function plannedBytes(
  patch: TransactionBytePatch,
  kind: "apply" | "rollback",
): { before?: Buffer; after?: Buffer } {
  return {
    before: decodeStoredBytes(kind === "apply" ? patch.before : patch.after),
    after: decodeStoredBytes(kind === "apply" ? patch.after : patch.before),
  };
}
