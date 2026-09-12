import { isEmpty, isPresent } from '@velaros-ai/core'

import { isJsTsPath, type JsTsSymbol, parseJsTs, selectJsTsSymbols } from "../adapters/jsts-ast.js";
import { ProjectError } from "../errors.js";
import type { OffsetRange } from "../types/common.js";
import type { EditOperation, PreparedPatch } from "../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../types/patch.js";
import type { FileSnapshot } from "../types/snapshot.js";
import { unifiedDiff } from "../utils/diff.js";
import { id } from "../utils/id.js";
import { countChangedLines } from "../utils/text.js";

import { planAddImport, planRemoveImport, type SourceSplice } from "./import-mutation.js";

type SymbolOperation = Extract<
  EditOperation,
  { type: "replace_symbol" | "insert_around_symbol" | "insert_before_symbol" | "insert_after_symbol" }
>;

/** 同一实现以不同身份注册：核心策略与 TypeScript 插件策略只差 id 与优先级。 */
export interface JsTsPatchStrategyIdentity {
  id: string;
  priority: number;
}

const HandledOperations = new Set<string>([
  "replace_symbol",
  "insert_around_symbol",
  "insert_before_symbol",
  "insert_after_symbol",
  "add_import",
  "remove_import",
]);

/** 符号歧义时在错误里列出的候选上限，足够模型补 kind/container，又不把整份大纲塞进错误。 */
const MaxListedCandidates = 8;

interface LocatedSymbol {
  range: OffsetRange;
  /** insert_* 的锚点：多声明语句里的绑定取整条语句，插入永远落在语句边界上，不会切进声明列表中间。 */
  anchor: OffsetRange;
  body?: OffsetRange;
}

export function jsTsPatchStrategy(): PatchStrategy {
  return createJsTsPatchStrategy({ id: "jsts.patch", priority: 90 });
}

export function createJsTsPatchStrategy(identity: JsTsPatchStrategyIdentity): PatchStrategy {
  return {
    id: identity.id,
    priority: identity.priority,
    canHandle(input: PatchStrategyInput) {
      return HandledOperations.has(input.intent.operation.type);
    },
    prepare(input: PatchStrategyInput): PreparedPatch[] {
      const snapshot = input.snapshot;
      if (!snapshot || snapshot.isBinary || !isPresent(snapshot.content)) throw new ProjectError("NOT_SUPPORTED", "JS/TS patch 需要文本 snapshot");
      const content = snapshot.content;
      const operation = input.intent.operation;
      const targetId = input.intent.targetId;

      if (operation.type === "add_import" || operation.type === "remove_import") {
        if (!isJsTsPath(snapshot.path)) throw new ProjectError("NOT_SUPPORTED", `${operation.type} 只支持 JS/TS 文件：${snapshot.path}`);
        const splice = operation.type === "add_import"
          ? planAddImport(snapshot.path, content, operation)
          : planRemoveImport(snapshot.path, content, operation);
        // 去重命中也产出显式 noop 补丁，而不是空数组——空数组会让该操作从事务里凭空消失。
        if (!splice) return [makePatch(identity.id, snapshot, content, content, { op: operation.type, noop: true })];
        return [makePatch(identity.id, snapshot, content, applySplice(content, splice), { op: operation.type, startOffset: splice.start, endOffset: splice.end })];
      }
      if (!isSymbolOperation(operation)) throw new ProjectError("NOT_SUPPORTED", `不支持的 JS/TS 操作：${operation.type}`);

      const located = locateSymbol(input, snapshot, content, operation);
      const splice = symbolSplice(located, operation);
      return [makePatch(identity.id, snapshot, content, applySplice(content, splice), {
        op: operation.type,
        mode: operation.type === "replace_symbol" ? operation.mode ?? "whole" : undefined,
        targetId,
        startOffset: splice.start,
        endOffset: splice.end,
      })];
    },
  };
}

function isSymbolOperation(operation: EditOperation): operation is SymbolOperation {
  return operation.type === "replace_symbol"
    || operation.type === "insert_around_symbol"
    || operation.type === "insert_before_symbol"
    || operation.type === "insert_after_symbol";
}

function symbolSplice(located: LocatedSymbol, operation: SymbolOperation): SourceSplice {
  switch (operation.type) {
    case "replace_symbol": {
      if (operation.mode !== "body") return { start: located.range.startOffset, end: located.range.endOffset, text: operation.replacement };
      if (!located.body) {
        throw new ProjectError(
          "TARGET_NOT_FOUND",
          "replace_symbol mode=body 需要可替换的 body（函数/方法的块体或箭头表达式体，类、interface、enum、namespace 的花括号体）；该目标没有，请改用 mode=whole",
        );
      }
      return { start: located.body.startOffset, end: located.body.endOffset, text: operation.replacement };
    }
    case "insert_around_symbol": {
      const at = operation.position === "before" ? located.anchor.startOffset : located.anchor.endOffset;
      return { start: at, end: at, text: operation.text };
    }
    case "insert_before_symbol":
      return { start: located.anchor.startOffset, end: located.anchor.startOffset, text: operation.text };
    case "insert_after_symbol":
      return { start: located.anchor.endOffset, end: located.anchor.endOffset, text: operation.text };
  }
}

/**
 * 定位符号操作的区间。已解析 target 带偏移时以它为准，并对齐到同一 AST 符号以取得 body 与插入锚点；
 * 否则按 operation.symbol 在 AST 中唯一匹配。范围永远来自 AST，不做括号计数式推断——非 JS/TS 目标
 * 因此没有 body，mode=body 显式失败而不是猜一个区间。
 */
function locateSymbol(input: PatchStrategyInput, snapshot: FileSnapshot, content: string, operation: SymbolOperation): LocatedSymbol {
  const range = input.target?.range;
  if (isPresent(range?.startOffset) && isPresent(range.endOffset)) {
    const aligned = isJsTsPath(snapshot.path)
      ? parseJsTs(snapshot.path, content).symbols.find((symbol) => symbol.range.startOffset === range.startOffset && symbol.range.endOffset === range.endOffset)
      : undefined;
    if (aligned) return locatedFrom(aligned);
    const offsets = { startOffset: range.startOffset, endOffset: range.endOffset };
    return { range: offsets, anchor: offsets };
  }

  // 只带行号的 target（如代码智能定位）没有偏移，退回用它的符号描述在 AST 里重新定位。
  const query = operation.symbol ?? input.target?.symbol;
  if (!query) throw new ProjectError("TARGET_NOT_FOUND", `${operation.type} 需要 targetId 或 operation.symbol`);
  if (!isJsTsPath(snapshot.path)) throw new ProjectError("NOT_SUPPORTED", `${operation.type} 按 symbol 定位只支持 JS/TS 文件：${snapshot.path}`);
  const matches = selectJsTsSymbols(parseJsTs(snapshot.path, content).symbols, query);
  const label = `${query.container ? `${query.container}.` : ""}${query.name}`;
  if (isEmpty(matches)) throw new ProjectError("TARGET_NOT_FOUND", `${operation.type} 未找到符号：${label}`);
  if (matches.length > 1) {
    throw new ProjectError(
      "AMBIGUOUS_TARGET",
      `${operation.type} 找到 ${matches.length} 个名为 ${label} 的符号：${matches.slice(0, MaxListedCandidates).map(describeSymbol).join("；")}`,
      { candidates: matches.map(describeSymbol) },
      "请补充 symbol.kind（成对访问器可写 getter / setter）或 symbol.container，使其只匹配一个符号。",
    );
  }
  return locatedFrom(matches[0]);
}

function locatedFrom(symbol: JsTsSymbol): LocatedSymbol {
  return { range: symbol.range, anchor: symbol.statementRange ?? symbol.range, body: symbol.bodyRange };
}

function describeSymbol(symbol: JsTsSymbol): string {
  const accessor = symbol.metadata.accessor ? `${symbol.metadata.accessor}，` : "";
  return `${symbol.kind} ${symbol.container ? `${symbol.container}.` : ""}${symbol.name}（${accessor}第 ${symbol.range.startLine} 行）`;
}

function applySplice(content: string, splice: SourceSplice): string {
  return content.slice(0, splice.start) + splice.text + content.slice(splice.end);
}

/** `oldContent` 是 prepare 入口已确认读到的原文（没有正文的快照在入口就被拒绝），回滚据此写回。 */
function makePatch(strategyId: string, snapshot: FileSnapshot, oldContent: string, newContent: string, metadata: Record<string, unknown>): PreparedPatch {
  const diff = unifiedDiff(snapshot.path, oldContent, newContent);
  return {
    patchId: id("patch"),
    strategyId,
    path: snapshot.path,
    baseRevision: snapshot.revision,
    oldContent,
    newContent,
    diff,
    changedLines: countChangedLines(diff),
    risk: "low", // 规模不代表风险,统一 low(真正危险在操作层判定)
    metadata,
  };
}
