/**
 * 包内可调参数：阈值与保留的量。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 * 对外承诺的上限不在这里，在 `contract/constants.ts`。
 */

/** 文件能力的可调参数，按用途分组。 */
export const FileTuning = Object.freeze({
  /** 读写：FileOperations 与文本文件工具函数。 */
  io: Object.freeze({
    /** 小于这个字节数的文件写前一律重读核版本：印记的时间精度不够时，小文件重读几乎不花钱。 */
    alwaysRehashBytes: 64 * 1024,
  }),
  /** 留着能撤回的改动：FileChanges。单个文件的原文上限与留几次是对外承诺，在常量表。 */
  changes: Object.freeze({
    /** 所有留着的原文加起来最多多少字节，超了从最早的那次改动丢起。 */
    totalBytes: 64 * 1024 * 1024,
  }),
  /** 本机全局搜索：LocalFileSearch（宿主界面用，模型碰不到）。 */
  search: Object.freeze({
    /** 没给 limit 时最多返回多少条。 */
    limit: 60,
    /** 没给 maxDepth 时最多往下走几层目录。 */
    maxDepth: 6,
    /** 按内容搜时跳过大于这么多字节的文件。 */
    fileBytes: 1024 * 1024,
    /** 按内容搜没给 maxResultsPerFile 时每个文件最多几条。 */
    resultsPerFile: 5,
  }),
})
