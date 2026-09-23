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
    compiledPrompt: `${modelRequestEncoder.encode(request)}\n\n${FrameHeading}\n${frame}`,
  }
}
