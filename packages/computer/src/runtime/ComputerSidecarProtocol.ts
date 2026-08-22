import { isFalse, isPlainObject, isString, isTrue, numberOrNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  ComputerCommand,
  ComputerHelperRequest,
  ComputerHelperResponse,
} from './types'

/**
 * Python 桌面控制 helper 的 stdio 线协议（行分隔 JSON）编解码。
 *
 * 导览（§5.3b ①算法与协议不变量）
 * - **一行一帧**：请求与响应都是单行 JSON + `\n`。所以 helper 侧任何 `print` 调试输出都会变成
 *   一条坏帧——解码失败必须是**可跳过**的（调用方丢这一行继续读），不能升级成致命错误。
 * - **id 关联**：`id` 是请求方分配的关联键，响应原样带回。`id=0` 保留给 helper 启动握手；
 *   `id` 缺失或非数字一律归一成 `null`，表示「这帧无法关联到任何请求」。
 * - **`ok` 是必填判别式**：`true` → 有 `result`，`false` → 有 `error`。**缺 `ok` 一律抛**，
 *   不猜、不给默认值——猜错会让一次失败的桌面动作看起来像成功。反过来 `error` 内部的
 *   `code`/`message` 缺失则**补占位**：这一帧的判别式已经确定是失败，缺的只是诊断文本，
 *   为文案缺失把整帧作废没有价值。
 * - **`result` 是断言不是校验**：`TResult` 由调用方指定，这里不认识各命令的返回形状，也不该认识
 *   （否则协议层要跟着每个新命令改）。形状约束归 `types.ts` 的命令表，运行期不二次校验。
 * - 全文件无副作用，所以线格式可以脱离真实 sidecar 单测。
 */

/** 把一次请求编码成单行、以换行结尾的 JSON。 */
export function encodeComputerRequest(
  id: number,
  command: ComputerCommand,
  payload: Record<string, unknown> = {}
): string {
  const request: ComputerHelperRequest = { id, command, payload }
  return `${JSON.stringify(request)}\n`
}

/** 解码一行 helper 响应；JSON 坏或信封不合法一律抛，调用方无须再防御性复检形状。 */
export function decodeComputerResponse<TResult = unknown>(
  line: string
): ComputerHelperResponse<TResult> {
  const trimmed = line.trim()
  if (!trimmed) throw new AppError('COMPUTER_PROTOCOL_INVALID', 'Empty computer-helper response line')

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new AppError(
      'COMPUTER_PROTOCOL_INVALID',
      `Invalid computer-helper response JSON: ${AppError.getMessage(error)}`,
      error
    )
  }

  if (!isPlainObject(parsed))
    throw new AppError('COMPUTER_PROTOCOL_INVALID', 'Computer-helper response is not an object')

  const id = numberOrNull(parsed.id)

  if (isTrue(parsed.ok)) return { id, ok: true, result: parsed.result as TResult }

  if (isFalse(parsed.ok)) {
    const error = isPlainObject(parsed.error) ? parsed.error : {}
    return {
      id,
      ok: false,
      error: {
        code: isString(error.code) ? error.code : 'helper_error',
        message: isString(error.message) ? error.message : 'Unknown computer-helper error',
      },
    }
  }

  throw new AppError(
    'COMPUTER_PROTOCOL_INVALID',
    'Computer-helper response missing boolean "ok" field'
  )
}

/**
 * 把流式 stdout 缓冲切成完整行。
 *
 * 返回值里的 `rest` 是**尾部未完成片段**，必须由调用方带进下一次读取——丢了它就会把一帧 JSON
 * 从中间截断，表现为随机的解码失败。
 */
export function drainResponseLines(buffer: string): {
  lines: string[]
  rest: string
} {
  const segments = buffer.split('\n')
  const rest = segments.pop() ?? ''
  const lines = segments.map((segment) => segment.trim()).filter(Boolean)
  return { lines, rest }
}
