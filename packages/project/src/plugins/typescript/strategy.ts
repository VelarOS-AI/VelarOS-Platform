import { isEmpty,isPresent } from "@velaros-ai/core";

import { ProjectError } from "../../errors.js";
import { removeNamedImportBinding } from "../../patch/import-mutation.js";
import type { PreparedPatch } from "../../types/edit.js";
import type { PatchStrategy, PatchStrategyInput } from "../../types/patch.js";
import { unifiedDiff } from "../../utils/diff.js";
import { id } from "../../utils/id.js";
import { countChangedLines } from "../../utils/text.js";

import { parseTs } from "./ast.js";

function patch(path: string, baseRevision: Optional<string>, oldContent: string, newContent: string, metadata?: Record<string, any>): PreparedPatch {
  const diff = unifiedDiff(path, oldContent, newContent);
  const changedLines = countChangedLines(diff);
  return {
    patchId: id("patch"),
    strategyId: "velaros.typescript.symbol-patch",
    path,
    baseRevision,
    oldContent,
    newContent,
    diff,
    changedLines,
    risk: "low", // 规模不代表风险,统一 low(真正危险在操作层判定)
    metadata,
  };
}

function findSymbolRange(input: PatchStrategyInput): { start: number; end: number } {
  const content = input.snapshot?.content ?? "";
  const op: any = input.intent.operation;
  if (isPresent(input.target?.range?.startOffset) && isPresent(input.target.range.endOffset)) return { start: input.target.range.startOffset, end: input.target.range.endOffset };
  const symbolRef = op.symbol;
  if (!symbolRef || !input.snapshot) throw new ProjectError("TARGET_NOT_FOUND", "replace_symbol 需要 targetId，或 operation.symbol 加 snapshot");
  const parsed = parseTs(input.snapshot.path, content);
  const matches = parsed.symbols.filter((symbol) => {
    if (symbol.name !== symbolRef.name) return false;
    if (symbolRef.kind && symbolRef.kind !== "any" && symbol.kind !== symbolRef.kind) return false;
    if (symbolRef.container && symbol.container !== symbolRef.container) return false;
    return true;
  });
  if (matches.length !== 1) {
    throw new ProjectError(isEmpty(matches) ? "TARGET_NOT_FOUND" : "AMBIGUOUS_TARGET", `replace_symbol 预期 1 个匹配，实际找到 ${matches.length} 个`);
  }
  return { start: matches[0].range.startOffset ?? 0, end: matches[0].range.endOffset ?? 0 };
}

/** 把 body 节点的 `{...}` 区间（含花括号）转成「花括号之间」的内容区间。 */
function innerBody(body: Optional<{ startOffset?: number; endOffset?: number }>): Optional<{ start: number; end: number }> {
  if (!isPresent(body?.startOffset) || !isPresent(body?.endOffset)) return undefined;
  // body 至少形如 `{}`（长度 2）才有意义；内容区间为开括号后到闭括号前。
  if (body.endOffset < body.startOffset + 2) return undefined;
  return { start: body.startOffset + 1, end: body.endOffset - 1 };
}

/**
 * 解析 replace_symbol mode=body 的「函数/方法体」内容区间。
 * 顺序：已解析目标里 adapter 算好的 AST bodyRange → 现解析 AST → 朴素花括号兜底。
 * 朴素法对默认参数对象 `= {}`、返回类型对象字面量 `): { x } {` 会取错花括号，
 * 因此优先用 AST 的真实 body 节点区间，避免改坏代码。
 */
function findBodyContentRange(
  input: PatchStrategyInput,
  content: string,
  symbolRange: { start: number; end: number },
): { start: number; end: number } | undefined {
  const fromTarget = innerBody(input.target?.metadata?.bodyRange as { startOffset?: number; endOffset?: number } | undefined);
  if (fromTarget) return fromTarget;

  if (input.snapshot) {
    const parsed = parseTs(input.snapshot.path, content);
    const matched =
      parsed.symbols.find((symbol) => symbol.range.startOffset === symbolRange.start && symbol.range.endOffset === symbolRange.end) ??
      parsed.symbols.find(
        (symbol) =>
          (symbol.range.startOffset ?? 0) <= symbolRange.start &&
          (symbol.range.endOffset ?? 0) >= symbolRange.end &&
          isPresent(symbol.bodyRange?.startOffset),
      );
    const fromAst = innerBody(matched?.bodyRange);
    if (fromAst) return fromAst;
  }

  // 兜底：AST 无 body（例如箭头函数 const 当前未携带 bodyRange）时退回朴素花括号匹配。
  const bodyOpen = content.indexOf("{", symbolRange.start);
  if (bodyOpen === -1 || bodyOpen >= symbolRange.end) return undefined;
  const bodyClose = content.lastIndexOf("}", symbolRange.end - 1);
  if (bodyClose <= bodyOpen) return undefined;
  return { start: bodyOpen + 1, end: bodyClose };
}

function replaceSymbol(input: PatchStrategyInput): PreparedPatch[] {
  if (!input.snapshot || input.snapshot.isBinary) throw new ProjectError("NOT_SUPPORTED", "replace_symbol 需要 JS/TS 文本 snapshot");
  const op: any = input.intent.operation;
  const content = input.snapshot.content ?? "";
  let { start, end } = findSymbolRange(input);
  if (op.mode === "body" || op.replaceBodyOnly) {
    const bodyRange = findBodyContentRange(input, content, { start, end });
    if (!bodyRange) throw new ProjectError("TARGET_NOT_FOUND", "replace_symbol mode=body 需要可解析的函数或方法 body 范围");
    start = bodyRange.start;
    end = bodyRange.end;
  }
  const newContent = content.slice(0, start) + op.replacement + content.slice(end);
  return [patch(input.snapshot.path, input.snapshot.revision, content, newContent, { op: "replace_symbol", targetId: input.intent.targetId })];
}

function insertAroundSymbol(input: PatchStrategyInput): PreparedPatch[] {
  if (!input.snapshot || input.snapshot.isBinary) throw new ProjectError("NOT_SUPPORTED", "insert_around_symbol 需要 JS/TS 文本 snapshot");
  const op: any = input.intent.operation;
  const content = input.snapshot.content ?? "";
  const { start, end } = findSymbolRange(input);
  const at = op.position === "before" ? start : end;
  const newContent = content.slice(0, at) + op.text + content.slice(at);
  return [patch(input.snapshot.path, input.snapshot.revision, content, newContent, { op: "insert_around_symbol", targetId: input.intent.targetId })];
}

function importStatement(op: any): string {
  // importStatement 优先（与 schema 契约一致）：调用方给了完整语句就原样使用，只补分号。
  if (op.importStatement) {
    const raw = String(op.importStatement).trim();
    return raw.endsWith(";") ? raw : `${raw};`;
  }
  if (op.sideEffectOnly) return `import "${op.module}";`;
  if (op.namespaceImport) return `import * as ${op.namespaceImport} from "${op.module}";`;
  const named = op.named && !op.named.isEmpty ? `{ ${[...new Set(op.named)].join(", ")} }` : "";
  if (op.defaultImport && named) return `import ${op.defaultImport}, ${named} from "${op.module}";`;
  if (op.defaultImport) return `import ${op.defaultImport} from "${op.module}";`;
  return `import ${named} from "${op.module}";`;
}

function addImport(input: PatchStrategyInput): PreparedPatch[] {
  if (!input.snapshot || input.snapshot.isBinary) throw new ProjectError("NOT_SUPPORTED", "add_import 需要 JS/TS 文本 snapshot");
  const op: any = input.intent.operation;
  const content = input.snapshot.content ?? "";
  const parsed = parseTs(input.snapshot.path, content);
  const imports = parsed.symbols.filter((s) => s.kind === "import");
  const existing = imports.find((symbol) => symbol.name === op.module);
  if (existing && op.sideEffectOnly) return [patch(input.snapshot.path, input.snapshot.revision, content, content, { op: "add_import", noop: true })];
  // 保守合并：同模块 import 已存在且包含 named imports 时，只把缺失名字追加到花括号内。
  if (existing && op.named && !op.named.isEmpty) {
    const oldStmt = content.slice(existing.range.startOffset ?? 0, existing.range.endOffset ?? 0);
    const braceMatch = oldStmt.match(/\{([^}]*)\}/);
    if (braceMatch) {
      const current = braceMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean);
      const merged = [...new Set([...current, ...op.named])];
      if (merged.length === current.length) return [patch(input.snapshot.path, input.snapshot.revision, content, content, { op: "add_import", noop: true })];
      const newStmt = oldStmt.replace(/\{[^}]*\}/, `{ ${merged.join(", ")} }`);
      const start = existing.range.startOffset ?? 0;
      const end = existing.range.endOffset ?? 0;
      return [patch(input.snapshot.path, input.snapshot.revision, content, content.slice(0, start) + newStmt + content.slice(end), { op: "add_import", merge: true })];
    }
  }
  const lastImport = imports.at(-1);
  const stmt = importStatement(op);
  const at = lastImport?.range?.endOffset ?? 0;
  const prefix = at === 0 ? "" : content.slice(at, at + 1) === "\n" ? "" : "\n";
  const suffix = at === 0 ? "\n" : "\n";
  const newContent = content.slice(0, at) + prefix + stmt + suffix + content.slice(at);
  return [patch(input.snapshot.path, input.snapshot.revision, content, newContent, { op: "add_import", module: op.module })];
}

function removeImport(input: PatchStrategyInput): PreparedPatch[] {
  if (!input.snapshot || input.snapshot.isBinary) throw new ProjectError("NOT_SUPPORTED", "remove_import 需要 JS/TS 文本 snapshot");
  const op: any = input.intent.operation;
  const content = input.snapshot.content ?? "";
  if (op.importStatement) {
    const statement = String(op.importStatement).trim();
    const normalized = statement.endsWith(";") ? statement : `${statement};`;
    const start = content.indexOf(normalized);
    if (start < 0) throw new ProjectError("TARGET_NOT_FOUND", "未找到 import 语句");
    let end = start + normalized.length;
    if (content[end] === "\n") end++;
    return [patch(input.snapshot.path, input.snapshot.revision, content, content.slice(0, start) + content.slice(end), { op: "remove_import", importStatement: normalized })];
  }
  const moduleSpecifier = op.moduleSpecifier ?? op.module;
  const parsed = parseTs(input.snapshot.path, content);
  const imports = parsed.symbols.filter((s) => s.kind === "import" && (!moduleSpecifier || s.name === moduleSpecifier));
  if (isEmpty(imports)) throw new ProjectError("TARGET_NOT_FOUND", `未找到 import：${moduleSpecifier ?? op.name ?? "<any>"}`);
  if (imports.length > 1) throw new ProjectError("AMBIGUOUS_TARGET", `remove_import 找到 ${imports.length} 个 import；请用 importStatement 指定完整语句`);
  const target = imports[0];
  const start = target.range.startOffset ?? 0;
  const statementEnd = target.range.endOffset ?? 0;
  let removalEnd = statementEnd;
  if (content[removalEnd] === "\n") removalEnd++;
  // 带 name 时只删该 binding；最后一个 named binding 被删且没有 default 时才整条删除。
  if (op.name) {
    const removal = removeNamedImportBinding(content.slice(start, statementEnd), op.name);
    if (removal.status === "not_found") throw new ProjectError("TARGET_NOT_FOUND", `未找到 named import：${op.name}`);
    if (removal.status === "updated") return [patch(input.snapshot.path, input.snapshot.revision, content, content.slice(0, start) + removal.statement + content.slice(statementEnd), { op: "remove_import", module: moduleSpecifier, name: op.name })];
  }
  return [patch(input.snapshot.path, input.snapshot.revision, content, content.slice(0, start) + content.slice(removalEnd), { op: "remove_import", module: moduleSpecifier, name: op.name })];
}

const TypeScriptPatchHandlers: Record<string, (input: PatchStrategyInput) => PreparedPatch[]> = {
  replace_symbol: replaceSymbol,
  insert_around_symbol: insertAroundSymbol,
  add_import: addImport,
  remove_import: removeImport,
};

export function typescriptPatchStrategy(): PatchStrategy {
  return {
    id: "velaros.typescript.symbol-patch",
    priority: 100,
    canHandle(input: PatchStrategyInput) {
      return input.intent.operation.type in TypeScriptPatchHandlers;
    },
    prepare(input: PatchStrategyInput): PreparedPatch[] {
      const type = input.intent.operation.type;
      const handler = TypeScriptPatchHandlers[type];
      if (handler) return handler(input);
      throw new ProjectError("NOT_SUPPORTED", `不支持的 TypeScript patch 操作：${type}`);
    },
  };
}
