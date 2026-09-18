/**
 * 包内可调参数：都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 * 对外承诺的上限不在这里，在 `contract/constants.ts`。
 */

/** 看图的可调参数，按用途分组。 */
export const ImageTuning = Object.freeze({
  /** 一共最多请宿主压几次（含第一次）：每次还超 base64 上限，就把长边收一截再请。 */
  shrinkAttempts: 4,
  /** 每次重试把长边收到上一次的多少。 */
  shrinkFactor: 0.7,
  /** 本机看图端口在 macOS 上调系统自带的 sips 裁图缩图（LocalImagePort）。 */
  sips: Object.freeze({
    /** 一次 sips 调用的超时毫秒数。 */
    timeoutMs: 2_000,
    /** 一次 sips 调用最多收多少字节的输出。 */
    outputBytes: 8 * 1024 * 1024,
  }),
})
