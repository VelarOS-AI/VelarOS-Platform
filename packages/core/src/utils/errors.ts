/**
 * 错误对象上的通用字段读取（显式函数形式，与任何领域无关）。
 */

import { isPlainObject, isString } from '../typeGuards'

/**
 * 读出系统错误上的 errno 码（`ENOENT`、`EACCES`、`ECONNREFUSED` 等）；不是这类错误就返回 null。
 *
 * Node 的 `fs`、`child_process`、`net` 把失败原因放在 `error.code` 这个字符串字段上，调用方据此分支；
 * 仓里十来处各写一份同样的读法，统一到这里。只读字段、不 import 任何 Node 模块，浏览器侧也能用。
 */
export function readErrnoCode(error: unknown): Nullable<string> {
  if (!isPlainObject(error)) return null

  return isString(error.code) ? error.code : null
}
