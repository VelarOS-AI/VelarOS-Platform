/** 可调参数：不是对外承诺，改了不算改契约。对外承诺的上限在 `contract/constants.ts`。 */

export const CodeSurfaceTuning = Object.freeze({
  /** 单条日志超过这个长度就先截一刀，免得一行日志顶掉整份预算。 */
  logLineChars: 2_000,
  /** 程序不给 timeoutMs 时用这个；上限仍受 `CodeSurfaceLimits.timeoutMs` 钳制。 */
  defaultTimeoutMs: 30_000,
  /** 诊断代码帧里一行最多摆多长；再长就截，插字符跟着钳到行尾。 */
  frameLineChars: 200,
  /** 一条插手记录的说明最多多长；能力回的拒绝理由可能很长。 */
  noticeDetailChars: 300,
  /** 一条诊断的说明最多多长；类型错会把整个展开的类型打出来。 */
  diagnosticMessageChars: 600,
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
  /** 门最多同时替多少个会话记状态（导入过的模块）；再多就丢最久没用的，它下次来当新会话。 */
  gateSessions: 256,
  /** 门最多同时开着几条时间线（每个空间一条）；再多就丢最久没用的，下次用到再从磁盘读。 */
  gateTimelines: 32,
  /** 工作区超过这么多文件就不打标记了：每一步都要扫一遍，太大的目录扫不起。 */
  markerFiles: 200_000,
  /** 单个文件超过这么多字节不读内容，按大小与修改时间算哈希。 */
  markerHashBytes: 256 * 1024 * 1024,
  /** 一条时间线存的东西（代码、参数、结果、目录节点）超过这么多字节，就从最旧的调用清起。 */
  timelineBytes: 500 * 1024 * 1024,
  /** 逐行比代码时编辑距离超过这个数就不再细比，整段按删了重写算。 */
  diffEditLimit: 2_000,
  /** 差量里每处改动前后带几行上下文。 */
  diffContextLines: 3,
  /** 列时间线时，参数短于这个字数就原样摆在那一行里，长的只说有多长。 */
  historyInputChars: 120,
  /** 一行里最多点名几个改过的文件，多的说「等 N 个」。 */
  historyFileNames: 5,
  /** 重放对不上时最多逐个列几个文件。 */
  replayMismatchLines: 20,
})
