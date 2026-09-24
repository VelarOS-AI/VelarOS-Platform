import {
  isArray,
  isBoolean,
  isFiniteNumber,
  isNonBlankString,
  isPlainObject,
  isString,
  isTrue,
  isUndefined,
  optionalWhen,
} from '@velaros-ai/core'

import { InteractionLimits } from '../contract/constants.js'
import type {
  ConfirmationAnswer,
  InteractionAnswer,
  InteractionField,
  InteractionFieldValue,
  InteractionRequest,
} from '../types/interaction.js'

/** 发给宿主的提问详情：选项与表单原样带上；只是一句话的问题没有详情。 */
export function interactionDetail(
  input: InteractionRequest
): Optional<Omit<InteractionRequest, 'message'>> {
  if (!input.options && !input.fields) return undefined
  const detail: {
    options?: InteractionRequest['options']
    fields?: InteractionRequest['fields']
    multiple?: boolean
    allowText?: boolean
  } = {}
  if (input.options) detail.options = input.options
  if (input.fields) detail.fields = input.fields
  if (input.multiple) detail.multiple = true
  if (input.allowText) detail.allowText = true
  return detail
}

/**
 * 宿主或父任务给的回答整理成 InteractionAnswer：字符串当自由作答；对象里只留下和问题对得上的部分
 * （问题里有的选项、字段和对应类型的值），其余丢掉。回答来自宿主，不在这里拒绝。
 */
export function normalizeInteractionAnswer(
  request: InteractionRequest,
  value: unknown
): InteractionAnswer {
  if (isString(value)) return { text: clip(value) }
  if (!isPlainObject(value)) return { text: clip(JSON.stringify(value) ?? '') }
  const answer: {
    text?: string
    choices?: string[]
    values?: Record<string, InteractionFieldValue>
    declined?: boolean
    reason?: string
  } = {}
  if (isString(value.text)) answer.text = clip(value.text)
  if (request.options && isArray(value.choices)) {
    const choices = pickOptions(request.options, value.choices)
    answer.choices = request.multiple ? choices : choices.slice(0, 1)
  }
  if (request.fields && isPlainObject(value.values)) {
    const values: Record<string, InteractionFieldValue> = {}
    for (const field of request.fields) {
      const picked = fieldValue(field, value.values[field.id])
      if (!isUndefined(picked)) values[field.id] = picked
    }
    answer.values = values
  }
  if (isTrue(value.declined)) answer.declined = true
  const reason = readReason(value)
  if (reason) answer.reason = reason
  return answer
}

/**
 * 确认的回答整理成 ConfirmationAnswer：布尔值或带 approved 的对象照实转；其余形状一律按不同意，
 * 原文当理由——含糊的回答不能被当成同意。
 */
export function normalizeConfirmationAnswer(value: unknown): ConfirmationAnswer {
  if (isBoolean(value)) return { approved: value }
  if (isPlainObject(value) && isBoolean(value.approved)) {
    const reason = value.approved ? undefined : readReason(value)
    return reason ? { approved: false, reason } : { approved: value.approved }
  }
  const text = clip(isString(value) ? value : (JSON.stringify(value) ?? '')).trim()
  return text ? { approved: false, reason: text } : { approved: false }
}

/** 问题里有的选项 id，按回答里的顺序去重。 */
function pickOptions(
  options: NonNullable<InteractionRequest['options']>,
  picked: readonly unknown[]
): string[] {
  const ids = new Set(options.map((option) => option.id))
  return [...new Set(picked.filter((id): id is string => isString(id) && ids.has(id)))]
}

/** 一个字段的值：类型对不上就当没填。 */
function fieldValue(field: InteractionField, value: unknown): Optional<InteractionFieldValue> {
  switch (field.kind) {
    case 'text':
      return isString(value) ? clip(value) : undefined
    case 'number':
      return optionalWhen(isFiniteNumber, isNonBlankString(value) ? Number(value) : value)
    case 'boolean':
      return optionalWhen(isBoolean, value)
    case 'choice': {
      const choices = pickOptions(field.options ?? [], isArray(value) ? value : [value])
      if (field.multiple) return choices
      return choices[0]
    }
  }
}

/** 对方给的理由：reason 或 message，去掉首尾空白后非空才算。 */
function readReason(value: Record<string, unknown>): Optional<string> {
  const reason = isString(value.reason)
    ? value.reason
    : isString(value.message)
      ? value.message
      : ''
  return clip(reason).trim() || undefined
}

/** 回答里的文字按上限截断。 */
function clip(text: string): string {
  return text.slice(0, InteractionLimits.answerChars)
}
