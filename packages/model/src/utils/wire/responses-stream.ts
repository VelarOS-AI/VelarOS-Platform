import { isPlainObject, isString, isTrue, Log } from '@velaros-ai/core'
import { AppError, createAbortError } from '@velaros-ai/core/error'

import type { OpenAIModelFetch } from '../../types/adapters.js'
import { ModelTuning } from '../tuning.js'

import { readJsonRequestBody } from './fetch-shims.js'
import { responseTerminalKind } from './stream-terminal.js'

/** 内置 Responses 以协议终端结束 SDK 输入，SDK 仍负责校验与生成完整结束状态。 */
export function createResponsesFetch(fetchImpl?: OpenAIModelFetch): OpenAIModelFetch {
  return async (input, init) => {
    const response = await (fetchImpl ?? globalThis.fetch)(input, init)
    const url = input instanceof Request ? input.url : String(input)
    if (
      !isTrue(readJsonRequestBody(init)?.stream) ||
      !response.ok ||
      !response.body ||
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'text/event-stream' ||
      // base 只用于解析浏览器允许的相对 URL，不参与实际请求。
      !new URL(url, 'https://model.invalid/').pathname.endsWith('/responses')
    )
      return response
    return new Response(terminalBody(response.body, init?.signal), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/** 按 SSE 空行分帧，保留原始字节；终端后的传输清理不阻塞 SDK 的正常 flush。 */
function terminalBody(
  body: ReadableStream<Uint8Array>,
  signal?: Nullable<AbortSignal>
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let buffer = new Uint8Array(1024)
  let length = 0
  let lineLength = 0
  let afterCR = false
  let settled = false
  let firstEvent = true
  let abort: (() => void) | undefined
  const dispose = (cancel: boolean, reason?: unknown) => {
    if (abort) signal?.removeEventListener('abort', abort)
    // cancel 可以抛错、拒绝或永不完成；协议终端已经完整交付时不再改变响应事实。
    if (cancel) {
      try {
        void reader.cancel(reason).catch(() => {
          Log.tag('ModelStream').debug('Responses 终态后的传输取消未完成')
        })
      } catch {
        Log.tag('ModelStream').debug('Responses 终态后的传输清理未完成')
      }
    }
    try {
      reader.releaseLock()
    } catch {
      Log.tag('ModelStream').debug('Responses 终态后的传输清理未完成')
    }
  }
  const append = (part: Uint8Array) => {
    if (length + part.byteLength > ModelTuning.stream.responseEventBytes)
      throw new AppError('LIMIT', 'Responses SSE 单个事件超过缓冲上限')
    if (length + part.byteLength > buffer.byteLength) {
      const next = new Uint8Array(
        Math.min(
          ModelTuning.stream.responseEventBytes,
          Math.max(buffer.byteLength * 2, length + part.byteLength)
        )
      )
      next.set(buffer.subarray(0, length))
      buffer = next
    }
    buffer.set(part, length)
    length += part.byteLength
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (settled) return
        settled = true
        const reason = signal?.reason ?? createAbortError()
        controller.error(reason)
        dispose(true, reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    },
    async pull(controller) {
      try {
        while (!settled) {
          const result = await reader.read()
          if (settled) return
          if (result.done) {
            settled = true
            if (length) controller.enqueue(buffer.slice(0, length))
            controller.close()
            dispose(false)
            return
          }
          const chunk = result.value
          let offset = 0
          let emitted = false
          for (let index = 0; index < chunk.byteLength; index++) {
            if (length + index - offset + 1 > ModelTuning.stream.responseEventBytes)
              throw new AppError('LIMIT', 'Responses SSE 单个事件超过缓冲上限')
            const byte = chunk[index]!
            if (afterCR && byte === 10) {
              afterCR = false
              continue
            }
            afterCR = false
            if (byte !== 10 && byte !== 13) {
              lineLength++
              continue
            }
            const boundary = lineLength === 0
            lineLength = 0
            afterCR = byte === 13
            if (!boundary) continue
            // 同一块里的 CRLF 一起转发；跨块的 LF 是已完成 CR 分隔符的可选续字节。
            if (afterCR && chunk[index + 1] === 10) {
              index++
              afterCR = false
            }
            append(chunk.subarray(offset, index + 1))
            const event = buffer.slice(0, length)
            const terminal = isResponseTerminalEvent(event, firstEvent)
            firstEvent = false
            controller.enqueue(event)
            emitted = true
            length = 0
            offset = index + 1
            if (terminal) {
              // CR 单独也完成 SSE 空行；补 LF 让 SDK 无须等待 CRLF 的下一块或网络 EOF。
              // 只补等价行分隔符，保留 data 原字节；普通事件和正文不做重写。
              if (event.at(-1) === 13) controller.enqueue(new Uint8Array([10]))
              settled = true
              controller.close()
              dispose(true)
              return
            }
          }
          append(chunk.subarray(offset))
          if (emitted) return
        }
      } catch (error) {
        Log.tag('ModelStream').debug('Responses SSE 读取进入异常分支')
        if (settled) return
        settled = true
        controller.error(error)
        dispose(true, error)
      }
    },
    cancel(reason) {
      if (settled) return
      settled = true
      dispose(true, reason)
    },
  })
}

/** 只识别 JSON 顶层的 Responses 终端；具体形状由原 SDK 再校验，不接受伪终端正文。 */
function isResponseTerminalEvent(event: Uint8Array, firstEvent: boolean): boolean {
  const data: string[] = []
  const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(event)
  const text = firstEvent ? decoded.replace(/^\uFEFF/u, '') : decoded
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (line === 'data') data.push('')
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
  }
  try {
    const record: unknown = JSON.parse(data.join('\n'))
    return isPlainObject(record) && isString(responseTerminalKind(record))
  } catch {
    Log.tag('ModelStream').debug('SSE data 不是 JSON，原字节继续交由 SDK 处理')
    return false
  }
}
