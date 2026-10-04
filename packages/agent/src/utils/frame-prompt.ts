import { isString } from '@velaros-ai/core'
import { modelRequestEncoder, type ModelTurnRequest } from '@velaros-ai/kernel'

/** 本帧协议段的标题；运行说明告诉模型控制标记只在这一段给出。 */
const FrameHeading = '本帧协议（宿主生成；控制标记以最后出现的这一段为准）：'

/**
 * 每帧会变的协议、阶段与恢复说明接在最后一条消息的运行时材料之后，
 * 系统提示在会话内保持不变，供应商才能缓存请求前缀。
 */
export function framedRequest(request: ModelTurnRequest, frame: string): ModelTurnRequest {
  return {
    ...request,
    compiledPrompt: `${modelRequestEncoder.encode(request)}\n\n${request.response.type === 'tools' ? '本轮执行要求：' : FrameHeading}\n${frame}`,
  }
}

/** 请求里实际发送的文字字符数（UTF-16），用来把 token 窗口换算成投影的字符预算。 */
export function requestChars(request: ModelTurnRequest): number {
  return (
    request.instructions.length +
    (request.response.type === 'tools' ? JSON.stringify(request.response.tools).length : 0) +
    (request.compiledPrompt?.length ?? 0) +
    (request.history ?? []).reduce(
      (sum, message) =>
        sum +
        (isString(message.content)
          ? message.content.length
          : message.content.reduce(
              (parts, part) => parts + (part.type === 'text' ? part.text.length : 0),
              0
            )),
      0
    )
  )
}
