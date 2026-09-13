import type { CorePolicy } from '../types/policy.js'

// 与 package.json#version 手工同步，由 check:arch 机械对齐（漂移即红）。
// 留字面量而不从 package.json 读：本包会被打进消费方 bundle，ESM 里 import JSON 要
// resolveJsonModule + 打包器配合，代价大于一条门；而这条门刚抓到过一次真实漂移，说明它够用。
export const PROJECT_PACKAGE_VERSION = '2.0.20'

/** 保守默认值：有界读取、revision 防护、事务范围限制，高风险写入必须显式审批。 */
export const DEFAULT_CORE_POLICY: CorePolicy = {
  allowFullFileRewrite: false,
  requireBaseRevision: true,
  requireUniqueTarget: true,
  maxFileSizeToReadBytes: 5 * 1024 * 1024,
  maxSearchFileSizeBytes: 1024 * 1024,
  // 编辑版本默认绑定内容指纹；同长度且 mtime 被保留的外部修改也必须被发现。
  revisionStrategy: 'content',
  enableRipgrepSearch: true,
  ripgrepTimeoutMs: 120_000,
  maxChangedFilesPerTransaction: 100,
  maxChangedLinesPerFile: 20_000,
  maxChangedLinesPerTransaction: 50_000,
  maxConcurrentBatchTasks: 8,
  readDeny: [],
  writeDeny: [],
  protectedFiles: [],
  generatedFiles: ['**/*.generated.*', '**/*.gen.*', '**/generated/**'],
  approval: {
    requireForHighRiskPatch: true,
  },
}
