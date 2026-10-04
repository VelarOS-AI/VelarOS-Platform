import { Ajv, type ValidateFunction } from 'ajv'

import { isArray, isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ModelRequestEncoderApi } from '../../contract/provides.js'
import type {
  ModelContinuation,
  ModelHistoryMessage,
  ModelResponseFormat,
  ModelToolExchange,
  ModelTurnRequest,
} from '../../types/model.js'
import {
  driverModelContinuation,
  driverModelMessages,
  driverModelPrompt,
  driverModelToolExchange,
} from '../../utils/runtime/model-request.js'
import { immutableOperationJson } from '../../utils/runtime/operation-schema.js'

class ModelRequestEncoder implements ModelRequestEncoderApi {
  private readonly validators = new WeakMap<object, ValidateFunction>()

  public response(request: ModelTurnRequest): ModelResponseFormat {
    const response = request.response
    if (response?.type === 'text' && Object.keys(response).length === 1)
      return Object.freeze({ type: 'text' })
    if (
      response?.type === 'tools' &&
      isArray(response.tools) &&
      !isEmpty(response.tools) &&
      response.tools.length <= 32
    ) {
      const names = new Set<string>()
      for (const tool of response.tools) {
        this.response({ ...request, response: { type: 'json', ...tool } })
        if (names.has(tool.name)) throw new AppError('VALIDATION', '工具名称重复')
        names.add(tool.name)
      }
      return immutableOperationJson(response)
    }
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
    if (format.type !== 'json') {
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
  public continuation(value: unknown): ModelContinuation {
    return driverModelContinuation(value)
  }
  public toolExchange(value: unknown): ModelToolExchange {
    return driverModelToolExchange(value)
  }
  public encode(request: ModelTurnRequest): string {
    return driverModelPrompt(request)
  }
}

/** 模型传输编码器负责序列化与响应校验，不做选材或业务派发。 */
export const modelRequestEncoder: ModelRequestEncoderApi = new ModelRequestEncoder()
