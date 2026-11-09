import { isString } from '@velaros-ai/core'
import { modelRequestEncoder, type ModelTurnRequest } from '@velaros-ai/kernel'

import type { ActImage } from '../types/act.js'

/** 按完整身份和重复次数核对附件；失效返回 undefined，仍有效的附件不在帧尾重复发送。 */
export function remainingFrameImages(
  current: readonly ActImage[],
  retained: readonly ActImage[]
): Optional<readonly ActImage[]> {
  const remaining = [...current]
  for (const image of retained) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.data === image.data &&
        candidate.mediaType === image.mediaType &&
        candidate.origin === image.origin &&
        candidate.label === image.label
    )
    if (index < 0) return undefined
    remaining.splice(index, 1)
  }
  return remaining
}

/** 本帧协议段的标题；运行说明告诉模型控制标记只在这一段给出。 */
const FrameHeading = '本帧协议（宿主生成；控制标记以最后出现的这一段为准）：'

/**
 * 稳定材料与本轮协议分别编码；协议和动态观察处于不保留的尾区，
 * 不随已接受的稳定帧进入下一轮缓存前缀。
 */
export function framedRequest(request: ModelTurnRequest, frame: string): ModelTurnRequest {
  return {
    ...request,
    compiledPrompt: modelRequestEncoder.encode(request),
    protocol: `${request.response.type === 'tools' ? '本轮执行要求：' : FrameHeading}\n${frame}`,
  }
}

/** 请求里实际发送的文字字符数（UTF-16），用来把 token 窗口换算成投影的字符预算。 */
export function requestChars(request: ModelTurnRequest): number {
  return (
    request.instructions.length +
    (request.response.type === 'tools' ? JSON.stringify(request.response.tools).length : 0) +
    modelRequestEncoder
      .messages(request)
      .reduce(
        (sum, message) =>
          sum +
          (message.role === 'assistant' && message.toolExchange
            ? JSON.stringify(message.toolExchange).length
            : isString(message.content)
              ? message.content.length
              : message.content.reduce(
                  (parts, part) => parts + (part.type === 'text' ? part.text.length : 0),
                  0
                )),
        0
      )
  )
}
