import { Ajv, type ValidateFunction } from 'ajv'

import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ModelRequestEncoderApi } from '../../contract/provides.js'
import type {
  ModelHistoryMessage,
  ModelResponseFormat,
  ModelTurnRequest,
} from '../../types/model.js'
import { driverModelMessages, driverModelPrompt } from '../../utils/runtime/model-request.js'
import { immutableOperationJson } from '../../utils/runtime/operation-schema.js'

class ModelRequestEncoder implements ModelRequestEncoderApi {
  private readonly validators = new WeakMap<object, ValidateFunction>()

  public response(request: ModelTurnRequest): ModelResponseFormat {
    const response = request.response
    if (response?.type === 'text' && Object.keys(response).length === 1)
      return Object.freeze({ type: 'text' })
    if (
      !response ||
      response.type !== 'json' ||
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(response.name) ||
      !isString(response.description) ||
      response.schema?.type !== 'object'
    )
      throw new AppError('VALIDATION', '模型响应格式必须是 text 或命名的 JSON 对象契约')
    return immutableOperationJson(response)
  }

  public output(format: ModelResponseFormat, value: unknown): unknown {
    if (format.type === 'text') {
      if (!isString(value)) throw new AppError('VALIDATION', '文本响应必须是字符串')
      return value
    }
    let validate = this.validators.get(format.schema)
    if (!validate) {
      validate = new Ajv({
        strict: true,
        allErrors: true,
        coerceTypes: false,
        useDefaults: false,
        removeAdditional: false,
      }).compile(format.schema)
      this.validators.set(format.schema, validate)
    }
    const copy = immutableOperationJson(value)
    if (!validate(copy))
      throw new AppError(
        'MODEL_RESPONSE_SCHEMA',
        `模型响应不符合 ${format.name} schema: ${JSON.stringify(validate.errors)}`
      )
    return copy
  }

  public messages(request: ModelTurnRequest): ModelHistoryMessage[] {
    return driverModelMessages(request)
  }
  public encode(request: ModelTurnRequest): string {
    return driverModelPrompt(request)
  }
}

/** 模型传输编码器负责序列化与响应校验，不做选材或业务派发。 */
export const modelRequestEncoder: ModelRequestEncoderApi = new ModelRequestEncoder()
