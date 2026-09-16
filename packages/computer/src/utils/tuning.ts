/**
 * 包内可调参数：只影响本包实现的等待与缓冲，不是对外承诺，按宿主实测改这里一处。
 * 对外承诺（坐标上限、文本长度上限等）在工具 schema 与内核入参门里，不放这里。
 */
export const ComputerTuning = Object.freeze({
  /** 单个请求从写进 stdin 到收到应答的等待上限。 */
  requestTimeoutMs: 15_000,
  /**
   * 从 spawn 到收到 ready 握手的等待上限。
   * helper 卡在导入阶段、或握手行被上一轮残片污染时，没有这道闸，`start()` 永不 settle，
   * 请求的超时计时器又在 `await start()` 之后才装，调用方会无限期挂起（2026-09-16 实测）。
   */
  startupTimeoutMs: 20_000,
  /** stderr 只留尾部这么多字符：它唯一的用途是给启动失败当 detail，不是日志缓冲区。 */
  stderrTailChars: 8_000,
} as const)
