import type { JsonValue, RiskLevel } from "./common.js";
import type { FileSnapshot } from "./snapshot.js";

/** project 内核可转换为补丁的所有编辑原语联合类型。 */
export type EditOperation =
  | ReplaceTextOperation
  | InsertTextOperation
  | InsertTextAtAnchorOperation
  | AppendTextOperation
  | PrependTextOperation
  | DeleteTextOperation
  | CreateFileOperation
  | DeleteFileOperation
  | RenameFileOperation
  | ReplaceSymbolOperation
  | InsertAroundSymbolOperation
  | InsertBeforeSymbolOperation
  | InsertAfterSymbolOperation
  | AddImportOperation
  | RemoveImportOperation
  | JsonPatchOperation
  | CustomEditOperation;

export interface ReplaceTextOperation {
  type: "replace_text";
  /** 目标文件路径；没有 targetId 时必填。 */
  path?: string;
  /** 可选精确锚点；除非 constraints 另有指定，否则应唯一存在。 */
  oldText?: string;
  newText: string;
  /** 安全断言：总匹配数必须等于该值；不决定修改数量。 */
  expectedMatches?: number;
  /** 只修改第几个匹配（1-based）。 */
  occurrence?: number;
  /** 修改全部匹配。 */
  replaceAll?: boolean;
  anchors?: {
    before?: string;
    after?: string;
    mustContain?: string[];
  };
}

export interface InsertTextOperation {
  type: "insert_text";
  /** 目标文件路径；没有 targetId 时必填。 */
  path?: string;
  position: "before" | "after";
  text: string;
}

export interface InsertTextAtAnchorOperation {
  type: "insert_text_at_anchor";
  path: string;
  /** 用于替代数字行 offset 的字面量文本锚点。 */
  anchorText: string;
  position: "before" | "after";
  text: string;
  expectedMatches?: number;
  occurrence?: number;
  replaceAll?: boolean;
  skipIfAlreadyPresent?: boolean;
}

export interface AppendTextOperation {
  type: "append_text";
  path: string;
  text: string;
  skipIfAlreadyPresent?: boolean;
}

export interface PrependTextOperation {
  type: "prepend_text";
  path: string;
  text: string;
  skipIfAlreadyPresent?: boolean;
}

export interface DeleteTextOperation {
  type: "delete_text";
  /** 目标文件路径；没有 targetId 时必填。 */
  path?: string;
  oldText?: string;
  expectedMatches?: number;
  occurrence?: number;
  replaceAll?: boolean;
}

export interface CreateFileOperation {
  type: "create_file";
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface DeleteFileOperation {
  type: "delete_file";
  path: string;
}

export interface RenameFileOperation {
  type: "rename_file";
  from: string;
  to: string;
}

export interface ReplaceSymbolOperation {
  type: "replace_symbol";
  /** 没有 targetId 时由 Agent 直接提供的项目相对路径。 */
  path?: string;
  /** adapter 解析的符号选择器；路径通常来自 targetId 或 operation.path。 */
  symbol?: {
    kind?: string;
    name: string;
    container?: string;
  };
  replacement: string;
  mode?: "whole" | "body";
}

export interface InsertAroundSymbolOperation {
  type: "insert_around_symbol";
  /** 没有 targetId 时由 Agent 直接提供的项目相对路径。 */
  path?: string;
  symbol?: {
    kind?: string;
    name: string;
    container?: string;
  };
  position: "before" | "after";
  text: string;
}

export interface InsertBeforeSymbolOperation {
  type: "insert_before_symbol";
  symbol?: {
    kind?: string;
    name: string;
    container?: string;
  };
  text: string;
}

export interface InsertAfterSymbolOperation {
  type: "insert_after_symbol";
  symbol?: {
    kind?: string;
    name: string;
    container?: string;
  };
  text: string;
}

export interface AddImportOperation {
  type: "add_import";
  path?: string;
  importStatement?: string;
  module?: string;
  named?: string[];
  defaultImport?: string;
  namespaceImport?: string;
  sideEffectOnly?: boolean;
  dedupe?: boolean;
}

export interface RemoveImportOperation {
  type: "remove_import";
  path?: string;
  importStatement?: string;
  moduleSpecifier?: string;
  module?: string;
  name?: string;
}

export interface JsonPatchOperation {
  type: "json_patch";
  /** 目标 JSON 文件路径；没有 targetId 时必填。 */
  path?: string;
  patches: Array<
    | { op: "add" | "replace"; path: string; value: JsonValue }
    | { op: "remove"; path: string }
  >;
}

export interface CustomEditOperation {
  type: "custom";
  adapterId?: string;
  payload: any;
}

export interface EditConstraints {
  /** prepared transaction 的总补丁大小超过该限制时拒绝。 */
  maxChangedLines?: number;
  allowFullFileRewrite?: boolean;
  /** 要求选中的文本、锚点或符号匹配指定次数。 */
  expectedMatches?: number;
  onlyModifyTarget?: boolean;
}

/** 单个编辑请求，以及可选目标和原因元数据。 */
export interface EditIntent {
  targetId?: string;
  reason?: string;
  operation: EditOperation;
  constraints?: EditConstraints;
}

export interface PrepareEditInput {
  /** 将编辑与新读取上下文绑定起来的 evidence pack。 */
  evidenceId?: string;
  operations: EditIntent[];
  /** 没有 resolved target 自带 base revision 时使用的兼容 revision 防护。 */
  baseRevision?: string;
  /** 按项目相对路径绑定调用方读取到的 revision；优先于兼容的 baseRevision。 */
  baseRevisions?: Record<string, string>;
  dryRun?: boolean;
  metadata?: Record<string, any>;
}

export interface PreparedPatch {
  patchId: string;
  strategyId: string;
  path: string;
  /** 准备补丁时基于的 revision；存在时 apply 阶段会再次检查。 */
  baseRevision?: string;
  /**
   * 补丁写入前该路径的原文，rollback 据此写回。覆盖或删除既有文件却缺席，表示取不到原文
   * （二进制或超出读取上限的文件）：回滚无法恢复，事务因此是高风险。
   */
  oldContent?: string;
  newContent?: string;
  diff: string;
  changedLines: number;
  risk: RiskLevel;
  metadata?: Record<string, any>;
}

export interface PreparedTransaction {
  transactionId: string;
  status: "prepared";
  /** applyEdit 会按顺序精确重放的补丁列表。 */
  patches: PreparedPatch[];
  changedFiles: string[];
  diff: string;
  changedLines: number;
  risk: RiskLevel;
  createdAt: number;
  baseSnapshots: FileSnapshot[];
  metadata?: Record<string, any>;
}

export interface ApplyEditInput {
  transactionId: string;
}

export interface AmendEditInput {
  transactionId: string;
  operations: EditIntent[];
  evidenceId?: string;
  metadata?: Record<string, any>;
}

export interface ApplyResult {
  status: "applied";
  transactionId: string;
  changedFiles: string[];
  /** 写入前观察到的 revision，按路径索引。 */
  oldRevisions: Record<string, string>;
  /** 写入后的 revision；被删除路径使用 "deleted"。 */
  newRevisions: Record<string, string>;
  rebasedFiles?: string[];
  /** 新建后挂上 git intent-to-add 的路径。 */
  gitTrackedFiles?: string[];
  /** 删除后撤掉残留 intent-to-add 索引项的路径；带真实暂存内容的索引项不会出现在这里，也不会被改动。 */
  gitUntrackedFiles?: string[];
}

export interface RollbackInput {
  transactionId: string;
}

export interface RollbackResult {
  status: "rolled_back";
  transactionId: string;
  changedFiles: string[];
  /** 回滚删掉新建文件后撤掉的 git 索引项。 */
  gitUntrackedFiles?: string[];
  /** 回滚恢复的文件里，apply 删除时撤掉过 intent-to-add、现已挂回的路径。 */
  gitTrackedFiles?: string[];
}
