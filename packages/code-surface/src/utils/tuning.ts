/** 可调参数：不是对外承诺，改了不算改契约。对外承诺的上限在 `contract/constants.ts`。 */

export const CodeSurfaceTuning = Object.freeze({
  /** 单条日志超过这个长度就先截一刀，免得一行日志顶掉整份预算。 */
  logLineChars: 2_000,
  /** 程序不给 timeoutMs 时用这个；上限仍受 `CodeSurfaceLimits.timeoutMs` 钳制。 */
  defaultTimeoutMs: 30_000,
  /** 诊断代码帧里一行最多摆多长；再长就截，插字符跟着钳到行尾。 */
  frameLineChars: 200,
  /** 执行账折完之后最多列几条；超出保留结尾（中断现场在尾部）。 */
  journalEntries: 60,
  /** 隔离进程的堆上限（MB）。爆了就终止——超时管得住死循环，管不住一个循环里把整个仓库读进数组。 */
  heapMb: 512,
  /**
   * 隔离进程 stderr 收多少字符。
   *
   * 留**头**不留尾，与日志相反：进程崩溃时要紧的那句在最前面，后面跟的是一长串 native stack。
   * 按尾巴截会把「heap out of memory」连同判据一起裁掉——第一版就栽在这里。
   */
  stderrCaptureChars: 8_000,
  /** 崩溃说明里引用多少 stderr 给模型看；收下来的那 8000 字是给判定用的，不是给它读的。 */
  stderrQuoteChars: 600,
})
