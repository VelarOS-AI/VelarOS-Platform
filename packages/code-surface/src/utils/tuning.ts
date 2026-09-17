/** 可调参数：不是对外承诺，改了不算改契约。对外承诺的上限在 `contract/constants.ts`。 */

export const CodeSurfaceTuning = Object.freeze({
  /** 单条日志超过这个长度就先截一刀，免得一行日志顶掉整份预算。 */
  logLineChars: 2_000,
  /** 程序不给 timeoutMs 时用这个；上限仍受 `CodeSurfaceLimits.timeoutMs` 钳制。 */
  defaultTimeoutMs: 30_000,
  /** 诊断代码帧里一行最多摆多长；再长就截，插字符跟着钳到行尾。 */
  frameLineChars: 200,
})
