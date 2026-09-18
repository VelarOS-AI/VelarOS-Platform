/**
 * 包内可调参数：都是取舍，没有唯一正确的值；要调就改这一个文件，全包跟着变。
 * 对外承诺的上限不在这里，在 `contract/constants.ts`。
 */

/** 把图压进上限时的可调参数。 */
export const ImageTuning = Object.freeze({
  /** 一共最多请宿主压几次（含第一次）：每次还超 base64 上限，就把长边收一截再请。 */
  shrinkAttempts: 4,
  /** 每次重试把长边收到上一次的多少。 */
  shrinkFactor: 0.7,
})
