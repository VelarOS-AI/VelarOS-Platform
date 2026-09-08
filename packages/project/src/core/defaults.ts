import type { CorePolicy } from "../types/policy.js";

// 与 package.json#version 手工同步，由 check:arch 机械对齐（漂移即红）。
// 留字面量而不从 package.json 读：本包会被打进消费方 bundle，ESM 里 import JSON 要
// resolveJsonModule + 打包器配合，代价大于一条门；而这条门刚抓到过一次真实漂移，说明它够用。
export const PROJECT_PACKAGE_VERSION = "2.0.14";

/** 保守默认值：有界读取、revision 防护、事务范围限制，高风险写入必须显式审批。 */
export const DEFAULT_CORE_POLICY: CorePolicy = {
  allowFullFileRewrite: false,
  requireBaseRevision: true,
  requireUniqueTarget: true,
  maxFileSizeToReadBytes: 5 * 1024 * 1024,
  maxSearchFileSizeBytes: 1024 * 1024,
  // 默认走轻量元数据 revision：snapshot 不为算哈希整文件读取，换取速度；
  // 如需识别「同 size+同 mtime」的内容改动，可显式切回 "content"。
  revisionStrategy: "metadata",
  enableRipgrepSearch: true,
  ripgrepTimeoutMs: 120_000,
  maxChangedFilesPerTransaction: 10,
  maxChangedLinesPerFile: 300,
  maxChangedLinesPerTransaction: 800,
  maxConcurrentBatchTasks: 8,
  readDeny: [],
  writeDeny: [],
  protectedFiles: [],
  generatedFiles: ["**/*.generated.*", "**/*.gen.*", "**/generated/**"],
  approval: {
    requireForHighRiskPatch: true,
  },
};
