import type { BatchMetrics } from "./batch.js";

export type JsonValue = Nullable<boolean | number | string | JsonValue[] | { [key: string]: JsonValue }>;

/** 根据变更文件数和变更行数推导出的粗粒度风险等级。 */
export type RiskLevel = "low" | "medium" | "high";

/** 1-based 行范围，可附带 UTF-16 列号以及字节/JS 字符串 offset。 */
export interface Range {
  startLine: number;
  endLine: number;
  /** startLine 上的 1-based UTF-16 列号（可从 offset 推导时存在）。 */
  startColumn?: number;
  /** 匹配结束位置在 endLine 上的 1-based UTF-16 列号。 */
  endColumn?: number;
  startOffset?: number;
  endOffset?: number;
}

export interface OffsetRange {
  startOffset: number;
  endOffset: number;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  /** diagnostic 绑定工作区文件时的相对路径。 */
  path?: string;
  line?: number;
  column?: number;
  source?: string;
  data?: any;
}

export interface DiffResult {
  diff: string;
  changedFiles: string[];
  changedLines: number;
}

export interface WorkspaceStatus {
  root: string;
  /** 内存内核当前保留的事务数量。 */
  transactions: number;
  targets: number;
  journalEvents: number;
  locks: string[];
  plugins: string[];
  adapters: string[];
  validators: string[];
  /** 当前正在运行的批处理数量。 */
  runningBatches: number;
  /** 最近一次批处理的工作池指标（用于观测并发利用率/排队压力）。 */
  lastBatch?: BatchMetrics;
}

export type TrustSource = "system" | "user" | "workspace" | "tool" | "external";
export type TrustLevel = "trusted" | "untrusted";

/** 标记内容来自可信控制面，还是不可信的项目/用户文本。 */
export interface TrustLabel {
  source: TrustSource;
  trust: TrustLevel;
}
