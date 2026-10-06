/**
 * 上限：把模型给的数字钳进这件能力承诺的范围。
 */

import { isUndefined } from '@velaros-ai/core'

/**
 * 把一个正整数上限钳到 `limit`；没给就返回 undefined（由宿主用它自己的缺省）。
 *
 * **钳而不拒**是仓库的口径：超了按上限跑，别为一个数字废掉一整次调用。
 * 放在操作方法里而不是入参校验里，是因为预算属于那件能力自己——靠调用方那一侧拦，换一个入口就漏了。
 */
export function clampPositive(value: Optional<number>, limit: number): Optional<number> {
  return isUndefined(value) ? undefined : Math.max(1, Math.min(Math.floor(value), limit))
}
