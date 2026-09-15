/**
 * 事务字节计划：每个补丁写前、写后的确切字节。apply 按它原样写、写前按它预检，rollback 按它写回原字节，不经过重新编码。
 */

import { isString, isUndefined } from "@velaros-ai/core";
import { textCodec } from "@velaros-ai/text-files";

import type { PreparedPatch } from "../../types/edit.js";
import type { StoredTransaction, TransactionBytePatch, TransactionBytePlan } from "../../types/transaction.js";
import { ProjectError, projectErrorFromTextFile } from "../errors.js";

import { decodeStoredBytes } from "./byte-codec.js";
import { patchFileAttributes, patchTargetEncoding } from "./patch-attributes.js";
import { isDeletePatch } from "./patch-chain.js";

/**
 * 按写盘前捕获的原字节（originals，路径 → 字节）为事务准备字节计划：同一路径的补丁依次接在前一补丁的写后字节上，
 * 写后字节保留原文件编码与没改动片段的原字节（编码转换补丁按目标编码整体重编码）；unavailable 里的路径原字节取不到，标 beforeUnavailable。
 * 原文在准备期间变了抛 CONFLICT_WITH_EXTERNAL_EDIT，原文件无法无损解码抛 NOT_SUPPORTED，目标字节无法无损回读抛 INVALID_INPUT。
 */
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
      textCodec.decode(before)?.content !== patch.oldContent
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
          ? textCodec.detect(source)
          : (patchFileAttributes(patch).textEncoding ?? "utf8"));
      if (!encoding)
        throw new ProjectError(
          "NOT_SUPPORTED",
          "原文件无法无损解码，拒绝构造字节计划。",
          { path: patch.path },
        );
      try {
        after =
          source && !target
            ? textCodec.encodePreserving(
                source,
                textCodec.decode(source)!.content,
                content,
                encoding,
              )
            : textCodec.encode(content, encoding);
        // 无 BOM UTF-16 改为短文本后可能失去可识别性，由框架加同字节序 BOM。
        if (
          (encoding === "utf16le-nobom" || encoding === "utf16be-nobom") &&
          textCodec.decode(after)?.content !== content
        )
          after = textCodec.encode(
            content,
            encoding === "utf16le-nobom" ? "utf16le" : "utf16be",
          );
      } catch (error) {
        throw projectErrorFromTextFile(error);
      }
    }
    if (after && textCodec.decode(after)?.content !== (patch.newContent ?? ""))
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

/** 在字节计划里找某个补丁的那一项（按路径与补丁号，索引按计划对象缓存）；没有计划或找不到返回 undefined。 */
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

/** 按方向取一个补丁的字节：apply 是写前 → 写后，rollback 反过来；都解回字节。 */
export function plannedBytes(
  patch: TransactionBytePatch,
  kind: "apply" | "rollback",
): { before?: Buffer; after?: Buffer } {
  return {
    before: decodeStoredBytes(kind === "apply" ? patch.before : patch.after),
    after: decodeStoredBytes(kind === "apply" ? patch.after : patch.before),
  };
}
