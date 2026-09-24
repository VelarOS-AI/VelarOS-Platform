import {
  isArray,
  isBlank,
  isBoolean,
  isEmpty,
  isNull,
  isPlainObject,
  isString,
  isTrue,
  isUndefined,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { AgentsLimits, InteractionLimits } from '../contract/constants.js'
import type {
  InteractionField,
  InteractionOption,
  InteractionRequest,
} from '../types/interaction.js'

/** 交互说明的长度核对：空的或超过上限的直接拒绝，一次交互都不发起。 */
export function checkInteractionMessage(message: string): void {
  if (isEmpty(message) || message.length > InteractionLimits.messageChars)
    throw new AppError('VALIDATION', `message 需要 1 到 ${InteractionLimits.messageChars} 个字符`)
}

/** 派给子任务的材料条数核对：超过上限直接拒绝，子任务不会启动。 */
export function checkAgentMaterials(materials: Optional<readonly unknown[]>): void {
  if ((materials?.length ?? 0) > AgentsLimits.materials)
    throw new AppError('VALIDATION', `materials 最多 ${AgentsLimits.materials} 条`)
}

const FieldKinds = ['text', 'number', 'boolean', 'choice']

/** 提问的选项与表单核对：数量、id 唯一、文字长度和互斥关系不对就直接拒绝，一次交互都不发起。 */
export function checkInteractionRequest(input: InteractionRequest): void {
  checkInteractionMessage(input.message)
  if (input.options && input.fields)
    throw new AppError('VALIDATION', 'options 与 fields 不能同时给')
  if (!input.options && (input.multiple || input.allowText))
    throw new AppError('VALIDATION', 'multiple 与 allowText 只能和 options 一起用')
  if (input.options) checkOptions(input.options, 'options')
  if (!input.fields) return
  if (isEmpty(input.fields) || input.fields.length > InteractionLimits.fields)
    throw new AppError('VALIDATION', `fields 需要 1 到 ${InteractionLimits.fields} 项`)
  checkIds(
    input.fields.map((field) => field.id),
    'fields'
  )
  for (const field of input.fields) {
    const path = `fields.${field.id}`
    checkText(field.label, `${path}.label`, InteractionLimits.labelChars)
    if (!FieldKinds.includes(field.kind))
      throw new AppError('VALIDATION', `${path}.kind 只能是 ${FieldKinds.join('、')}`)
    if (field.kind === 'choice') checkOptions(field.options ?? [], `${path}.options`)
    else if (field.options || field.multiple)
      throw new AppError('VALIDATION', `${path}：只有 choice 字段能给 options 与 multiple`)
    if (!isUndefined(field.placeholder))
      checkText(field.placeholder, `${path}.placeholder`, InteractionLimits.descriptionChars, true)
  }
}

/** 选项：2 到上限个，id 唯一，最多一个建议项。 */
function checkOptions(options: readonly InteractionOption[], path: string): void {
  if (options.length < 2 || options.length > InteractionLimits.options)
    throw new AppError('VALIDATION', `${path} 需要 2 到 ${InteractionLimits.options} 个选项`)
  checkIds(
    options.map((option) => option.id),
    path
  )
  for (const option of options) {
    checkText(option.label, `${path}.${option.id}.label`, InteractionLimits.labelChars)
    if (!isUndefined(option.description))
      checkText(
        option.description,
        `${path}.${option.id}.description`,
        InteractionLimits.descriptionChars,
        true
      )
  }
  if (options.filter((option) => option.recommended).length > 1)
    throw new AppError('VALIDATION', `${path} 最多标一个 recommended`)
}

/** id 非空、不超长且互不重复。 */
function checkIds(ids: readonly string[], path: string): void {
  for (const id of ids) checkText(id, `${path} 的 id`, InteractionLimits.idChars)
  if (new Set(ids).size !== ids.length) throw new AppError('VALIDATION', `${path} 的 id 不能重复`)
}

/** 文字长度：默认必须非空；allowEmpty 时只查上限。 */
function checkText(text: string, path: string, max: number, allowEmpty = false): void {
  if ((!allowEmpty && isBlank(text)) || text.length > max)
    throw new AppError('VALIDATION', `${path} 需要 ${allowEmpty ? 0 : 1} 到 ${max} 个字符`)
}

/** 宿主读回的选项列表；缺席为 undefined，形状不对为 null。 */
export function readInteractionOptions(value: unknown): Optional<Nullable<InteractionOption[]>> {
  if (isUndefined(value)) return undefined
  if (!isArray(value)) return null
  const options: InteractionOption[] = []
  for (const item of value) {
    if (!isPlainObject(item) || !isString(item.id) || !isString(item.label)) return null
    if (!isUndefined(item.description) && !isString(item.description)) return null
    if (!isUndefined(item.recommended) && !isBoolean(item.recommended)) return null
    const option: { id: string; label: string; description?: string; recommended?: boolean } = {
      id: item.id,
      label: item.label,
    }
    if (isString(item.description)) option.description = item.description
    if (isTrue(item.recommended)) option.recommended = true
    options.push(option)
  }
  return options
}

/** 宿主读回的表单一项；形状不对为 null。 */
export function readInteractionField(value: unknown): Nullable<InteractionField> {
  if (!isPlainObject(value) || !isString(value.id) || !isString(value.label)) return null
  if (!FieldKinds.includes(String(value.kind))) return null
  const options = readInteractionOptions(value.options)
  if (isNull(options)) return null
  const field: {
    id: string
    label: string
    kind: InteractionField['kind']
    options?: readonly InteractionOption[]
    multiple?: boolean
    required?: boolean
    placeholder?: string
  } = { id: value.id, label: value.label, kind: value.kind as InteractionField['kind'] }
  if (options) field.options = options
  if (isTrue(value.multiple)) field.multiple = true
  if (isTrue(value.required)) field.required = true
  if (isString(value.placeholder)) field.placeholder = value.placeholder
  return field
}
