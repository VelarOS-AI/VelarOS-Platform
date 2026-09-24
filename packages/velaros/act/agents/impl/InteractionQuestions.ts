/**
 * 宿主读 interaction 事件里的提问：`InteractionQuestions` 与整个进程唯一的 `interactionQuestions`。
 * 接口 `InteractionQuestionsApi` 在本文件的类上方。详情是 `ask` 自己发出去的选项与表单，读回时照同一套规则核对。
 */

import { isArray, isNull, isPlainObject, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  InteractionField,
  InteractionOption,
  InteractionRequest,
} from '../types/interaction.js'
import {
  checkInteractionRequest,
  readInteractionField,
  readInteractionOptions,
} from '../utils/requests.js'

/** 宿主读 interaction 事件里的提问，据此画点选卡或表单。 */
export interface InteractionQuestionsApi {
  /** kind 为 input、详情里带选项或表单且形状核对无误时返回完整问题；只有一句话的问题、确认与能力请求返回 null。 */
  read(request: {
    readonly kind: string
    readonly message: string
    readonly detail?: unknown
  }): Nullable<InteractionRequest>
}

class InteractionQuestions implements InteractionQuestionsApi {
  public read(request: {
    readonly kind: string
    readonly message: string
    readonly detail?: unknown
  }): Nullable<InteractionRequest> {
    const detail = request.detail
    if (request.kind !== 'input' || !isPlainObject(detail)) return null
    const options = readInteractionOptions(detail.options)
    const fields = isArray(detail.fields) ? detail.fields.map(readInteractionField) : undefined
    if ((!options && !fields) || isNull(options) || fields?.includes(null)) return null
    const question: {
      message: string
      options?: readonly InteractionOption[]
      fields?: readonly InteractionField[]
      multiple?: boolean
      allowText?: boolean
    } = { message: request.message }
    if (options) question.options = options
    if (fields) question.fields = fields as InteractionField[]
    if (isTrue(detail.multiple)) question.multiple = true
    if (isTrue(detail.allowText)) question.allowText = true
    try {
      checkInteractionRequest(question)
    } catch (error) {
      // 核对不过的详情当普通问题处理，不猜哪里坏了
      if (error instanceof AppError && error.code === 'VALIDATION') return null
      throw error
    }
    return question
  }
}

/** 整个进程只有一份的提问读取器。 */
export const interactionQuestions: InteractionQuestionsApi = new InteractionQuestions()
