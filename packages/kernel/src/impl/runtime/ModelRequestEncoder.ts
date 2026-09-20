import { Ajv, type ValidateFunction } from 'ajv'

import type { ModelRequestEncoderApi } from '../../contract/provides.js'
import type { ModelResponseFormat, ModelTurnRequest, ModelUserMessage } from '../../types/model.js'
import { driverModelMessages,driverModelPrompt } from '../../utils/runtime/model-request.js'
import { immutableOperationJson } from '../../utils/runtime/operation-schema.js'

class ModelRequestEncoder implements ModelRequestEncoderApi {
  private readonly validators = new WeakMap<object, ValidateFunction>()

  public response(request: ModelTurnRequest): ModelResponseFormat {
    const response = request.response
    if (!response || response.type !== 'json' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(response.name) || typeof response.description !== 'string' || response.schema?.type !== 'object') throw new Error('模型响应格式必须是命名的 JSON 对象契约')
    return immutableOperationJson(response)
  }

  public output(format: ModelResponseFormat, value: unknown): unknown {
    let validate = this.validators.get(format.schema)
    if (!validate) {
      validate = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(format.schema)
      this.validators.set(format.schema, validate)
    }
    const copy = immutableOperationJson(value)
    if (!validate(copy)) throw Object.assign(new Error(`模型响应不符合 ${format.name} schema: ${JSON.stringify(validate.errors)}`), { code: 'MODEL_RESPONSE_SCHEMA' })
    return copy
  }

  public messages(request: ModelTurnRequest): ModelUserMessage[] { return driverModelMessages(request) }
  public encode(request: ModelTurnRequest): string { return driverModelPrompt(request) }
}

/** 模型传输编码器负责序列化与响应校验，不做选材或业务派发。 */
export const modelRequestEncoder: ModelRequestEncoderApi = new ModelRequestEncoder()
