/**
 * 包内可调参数：阈值与保留条数。都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 * 对外承诺的上限不在这里，在 `contract/constants.ts`。
 */

/** 文件能力的可调参数，按用途分组。 */
export const FileTuning = Object.freeze({
  /** 读写：FileOperations 与文本文件工具函数。 */
  io: Object.freeze({
    /** 超过留版本上限的文件整个写入前只读开头这么多字节认编码。 */
    textSniffBytes: 8192,
    /** 小于这个字节数的文件写前一律重读核版本：印记的时间精度不够时，小文件重读几乎不花钱。 */
    alwaysRehashBytes: 64 * 1024,
  }),
  /** 改动前留下的版本：FileHistory。单份上限就是对外承诺的 `FileLimits.versionedBytes`。 */
  history: Object.freeze({
    /** 每个文件最多留几份。 */
    snapshotsPerFile: 10,
    /** 全部版本加起来最多多少字节，超了从最早的删起。 */
    totalBytes: 64 * 1024 * 1024,
  }),
  /** 看图：把图压进上限。 */
  image: Object.freeze({
    /** 压一次还超 base64 上限时，最多再试几次。 */
    shrinkAttempts: 4,
    /** 每次重试把长边收到上一次的多少。 */
    shrinkFactor: 0.7,
  }),
})
