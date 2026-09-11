import { isEmpty, isFalse, isPresent, toOptional } from '@velaros-ai/core'

import { findJsTsSymbols } from "../adapters/jsts-adapter.js";
import { ProjectError } from "../errors.js";
import type { PreparedPatch } from "../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";
import { unifiedDiff } from "../utils/diff.js";
import { id } from "../utils/id.js";
import { countChangedLines } from "../utils/text.js";

import { removeNamedImportBinding } from "./import-mutation.js";

function makePatch(path: string, baseRevision: LooseOptional<string>, oldContent: string, newContent: string, metadata?: Record<string, any>): PreparedPatch {
  const diff = unifiedDiff(path, oldContent, newContent);
  const changedLines = countChangedLines(diff);
  return {
    patchId: id("patch"),
    strategyId: "jsts.patch",
    path,
    baseRevision: toOptional(baseRevision),
    oldContent,
    newContent,
    diff,
    changedLines,
    risk: "low", // 规模不代表风险,统一 low(真正危险在操作层判定)
    metadata,
  };
}

function importInsertOffset(content: string): number {
  const lines = content.split("\n");
  let offset = 0;
  let lastImportEnd = 0;
  let sawImport = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const lineEnd = offset + line.length + 1;
    if (trimmed.startsWith("#!") || trimmed === "'use strict';" || trimmed === '"use strict";' || isEmpty(trimmed)) {
      offset = lineEnd;
      continue;
    }
    if (/^import\s/.test(trimmed)) {
      sawImport = true;
      lastImportEnd = lineEnd;
      offset = lineEnd;
      continue;
    }
    break;
  }
  return sawImport ? lastImportEnd : offset;
}

function normalizeImport(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

function resolveSymbolRange(
  content: string,
  input: PatchStrategyInput,
  operation: {
    type: string;
    symbol?: { kind?: string; name: string; container?: string };
  },
): { start: number; end: number } {
  const targetRange = input.target?.range;
  if (isPresent(targetRange?.startOffset) && isPresent(targetRange.endOffset)) return { start: targetRange.startOffset, end: targetRange.endOffset };

  const symbol = operation.symbol;
  if (!symbol) {
    throw new ProjectError("TARGET_NOT_FOUND", `${operation.type} 需要 targetId 或 operation.symbol`);
  }
  const matches = findJsTsSymbols(content).filter((candidate) => {
    if (candidate.name !== symbol.name) return false;
    if (symbol.kind && symbol.kind !== "any" && candidate.kind !== symbol.kind) return false;
    return !symbol.container || candidate.container === symbol.container;
  });
  if (matches.length !== 1) {
    throw new ProjectError(
      isEmpty(matches) ? "TARGET_NOT_FOUND" : "AMBIGUOUS_TARGET",
      `${operation.type} 预期 1 个 symbol，实际找到 ${matches.length} 个`,
    );
  }
  return {
    start: matches[0].range.startOffset ?? 0,
    end: matches[0].range.endOffset ?? 0,
  };
}

export function jsTsPatchStrategy(): PatchStrategy {
  return {
    id: "jsts.patch",
    priority: 90,
    canHandle(input: PatchStrategyInput) {
      return ["replace_symbol", "insert_around_symbol", "insert_before_symbol", "insert_after_symbol", "add_import", "remove_import"].includes(input.intent.operation.type);
    },
    prepare(input: PatchStrategyInput): PreparedPatch[] {
      const op: any = input.intent.operation;
      const snap = input.snapshot;
      if (!snap || snap.isBinary || !isPresent(snap.content)) throw new ProjectError("NOT_SUPPORTED", "JS/TS patch 需要文本 snapshot");
      const content = snap.content;

      if (op.type === "add_import") {
        let rawImport: string | undefined;
        if (op.importStatement) {
          rawImport = op.importStatement;
        } else if (op.module) {
          if (op.sideEffectOnly) {
            rawImport = `import "${op.module}"`;
          } else if (op.namespaceImport) {
            rawImport = `import * as ${op.namespaceImport} from "${op.module}"`;
          } else {
            const hasNamedImports = !!op.named && !op.named.isEmpty;
            const defaultPart = op.defaultImport ? `${op.defaultImport}${hasNamedImports ? ", " : ""}` : "";
            const namedPart = hasNamedImports ? `{ ${op.named.join(", ")} } ` : "";
            rawImport = `import ${defaultPart}${namedPart}from "${op.module}"`;
          }
        }
        if (!rawImport) throw new ProjectError("INVALID_INPUT", "add_import 需要 importStatement 或 module");
        const stmt = normalizeImport(rawImport);
        // 去重命中：返回显式 noop 补丁（与 TS 策略一致），而不是空数组——
        // 空数组会让该操作从事务里凭空消失，易被误读为成功执行。
        if (!isFalse(op.dedupe) && content.includes(stmt)) return [makePatch(snap.path, snap.revision, content, content, { op: "add_import", noop: true })];
        const at = importInsertOffset(content);
        const prefix = at > 0 && !content.slice(0, at).endsWith("\n") ? "\n" : "";
        const suffix = content.slice(at).startsWith("\n") || at === content.length ? "" : "\n";
        const newContent = `${content.slice(0, at) + prefix + stmt  }\n${  suffix  }${content.slice(at)}`;
        return [makePatch(snap.path, snap.revision, content, newContent, { op: "add_import", startOffset: at, endOffset: at })];
      }

      if (op.type === "remove_import") {
        let start = -1;
        let end = -1;
        if (op.importStatement) {
          const stmt = normalizeImport(op.importStatement);
          start = content.indexOf(stmt);
          end = start >= 0 ? start + stmt.length : -1;
        } else if ((op.moduleSpecifier || op.module) && !op.name) {
          // op.module 是 op.moduleSpecifier 的别名；带 name 时只删除对应 binding。
          const specifier = op.moduleSpecifier ?? op.module;
          const re = new RegExp(`^.*from\\s+["']${String(specifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'];?\\s*$`, "m");
          const match = re.exec(content);
          if (match) {
            start = match.index;
            end = match.index + match[0].length;
          }
        } else if (op.name) {
          const specifier = op.moduleSpecifier ?? op.module;
          const escapedSpecifier = String(specifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`^.*from\\s+["']${escapedSpecifier}["'];?\\s*$`, "m");
          const match = re.exec(content);
          if (match) {
            start = match.index;
            end = match.index + match[0].length;
            const removal = removeNamedImportBinding(match[0], op.name);
            if (removal.status === "not_found") {
              throw new ProjectError("TARGET_NOT_FOUND", `未找到 named import：${op.name}`);
            }
            if (removal.status === "updated") {
              const newContent = content.slice(0, start) + removal.statement + content.slice(end);
              return [makePatch(snap.path, snap.revision, content, newContent, { op: "remove_import", startOffset: start, endOffset: end })];
            }
          }
        }
        if (start < 0 || end < 0) throw new ProjectError("TARGET_NOT_FOUND", "未找到 import 语句");
        if (content[end] === "\n") end++;
        const newContent = content.slice(0, start) + content.slice(end);
        return [makePatch(snap.path, snap.revision, content, newContent, { op: "remove_import", startOffset: start, endOffset: end })];
      }

      const { start, end } = resolveSymbolRange(content, input, op);

      if (op.type === "replace_symbol") {
        let replaceStart = start;
        let replaceEnd = end;
        if (op.mode === "body") {
          // 优先用已解析目标携带的 AST body 区间（含花括号）。核心 jsts 策略不引入 TS 编译器，
          // 无元数据时退回朴素花括号匹配；但若无法可靠定位 body，必须显式报错——
          // 绝不静默把「只改 body」退化成替换整个声明（旧兜底会悄悄改坏代码）。
          const metaBody = input.target?.metadata?.bodyRange as { startOffset?: number; endOffset?: number } | undefined;
          if (isPresent(metaBody?.startOffset) && isPresent(metaBody?.endOffset) && metaBody.endOffset >= metaBody.startOffset + 2) {
            replaceStart = metaBody.startOffset + 1;
            replaceEnd = metaBody.endOffset - 1;
          } else {
            const bodyOpen = content.indexOf("{", start);
            const bodyClose = bodyOpen !== -1 && bodyOpen < end ? content.lastIndexOf("}", end - 1) : -1;
            if (bodyOpen === -1 || bodyOpen >= end || bodyClose <= bodyOpen) {
              throw new ProjectError("TARGET_NOT_FOUND", "replace_symbol mode=body 需要可解析的函数或方法 body 范围");
            }
            replaceStart = bodyOpen + 1;
            replaceEnd = bodyClose;
          }
        }
        const newContent = content.slice(0, replaceStart) + op.replacement + content.slice(replaceEnd);
        return [makePatch(snap.path, snap.revision, content, newContent, { op: "replace_symbol", mode: op.mode ?? "whole", targetId: input.intent.targetId, startOffset: replaceStart, endOffset: replaceEnd })];
      }
      if (op.type === "insert_before_symbol") {
        const newContent = content.slice(0, start) + op.text + content.slice(start);
        return [makePatch(snap.path, snap.revision, content, newContent, { op: "insert_before_symbol", targetId: input.intent.targetId, startOffset: start, endOffset: start })];
      }
      if (op.type === "insert_after_symbol") {
        const newContent = content.slice(0, end) + op.text + content.slice(end);
        return [makePatch(snap.path, snap.revision, content, newContent, { op: "insert_after_symbol", targetId: input.intent.targetId, startOffset: end, endOffset: end })];
      }
      if (op.type === "insert_around_symbol") {
        const at = op.position === "before" ? start : end;
        const newContent = content.slice(0, at) + op.text + content.slice(at);
        return [makePatch(snap.path, snap.revision, content, newContent, { op: "insert_around_symbol", targetId: input.intent.targetId, startOffset: at, endOffset: at })];
      }
      throw new ProjectError("NOT_SUPPORTED", `不支持的 JS/TS 操作：${op.type}`);
    },
  };
}
