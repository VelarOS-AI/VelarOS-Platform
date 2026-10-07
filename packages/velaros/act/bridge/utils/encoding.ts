import { isString } from '@velaros-ai/core'
import type { ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

/** 网页只有用户消息口：完整保留中立指令、历史角色和响应合同，图像另走真实上传。 */
export function externalModelPrompt(request: ModelTurnRequest): string {
  let imageIndex = 0
  const messages = modelRequestEncoder.messages(request).map((message) => {
    if (isString(message.content)) return message
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'image'
          ? { type: 'image', mediaType: part.mediaType, attachment: ++imageIndex }
          : part
      ),
    }
  })
  return JSON.stringify({
    instructions: request.instructions,
    messages,
    response: modelRequestEncoder.response(request),
  })
}

/** 按正式编码器的消息顺序提取真实图像，与文字中的附件编号一致。 */
export function externalModelImages(request: ModelTurnRequest) {
  return modelRequestEncoder.messages(request).flatMap((message) =>
    isString(message.content)
      ? []
      : message.content.flatMap((part) =>
          part.type === 'image'
            ? [
                {
                  type: 'image-data' as const,
                  mediaType: part.mediaType,
                  label: '模型请求附件',
                  data: part.image.slice(part.image.indexOf(',') + 1),
                },
              ]
            : []
        )
  )
}
