/** 可调参数：不是对外承诺，改了不算改契约。对外承诺的上限在 `contract/constants.ts`。 */

export const CodeSurfaceTuning = Object.freeze({
  /** 单次输出来源证明最多访问多少节点；超过时保留运行时校验，不新增程序拒绝条件。 */
  outputProofNodes: 256,
  /** 单条日志超过这个长度就先截一刀，免得一行日志顶掉整份预算。 */
  logLineChars: 2_000,
  /** 程序不给 timeoutMs 时用这个；上限仍受 `CodeSurfaceLimits.timeoutMs` 钳制。 */
  defaultTimeoutMs: 30_000,
  /** 诊断代码帧里一行最多摆多长；再长就截，插字符跟着钳到行尾。 */
  frameLineChars: 200,
  /** 一条插手记录的说明最多多长；能力回的拒绝理由可能很长。 */
  noticeDetailChars: 300,
  /** 一条诊断的说明最多多长；与 act 回执交给模型的截断口径一致，再长的部分模型本来也看不到。 */
  diagnosticMessageChars: 500,
  /** 执行账折完之后最多列几条；超出保留结尾（中断现场在尾部）。 */
  journalEntries: 60,
  /** 隔离进程的堆上限（MB）。爆了就终止——超时管得住死循环，管不住一个循环里把整个仓库读进数组。 */
  heapMb: 512,
  /** 崩溃说明里引用多少 stderr 给模型看；收下来的那 8000 字是给判定用的，不是给它读的。 */
  stderrQuoteChars: 600,
})
