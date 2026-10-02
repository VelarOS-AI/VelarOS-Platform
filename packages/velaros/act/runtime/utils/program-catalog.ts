import { isNumber, isPlainObject, isString, isUndefined, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProgramCatalogLimits } from '../../system/contract/constants.js'
import type { ProgramPublishInput, ProgramQuery } from '../../system/types/programs.js'

/** 目录入参守公开预算；源码预算和 import 仍由正式 Script 检查器拥有。 */
export function catalogPublication(input: ProgramPublishInput): ProgramPublishInput {
  if (
    !isPlainObject(input) ||
    Object.keys(input).some(
      (key) =>
        !['name', 'purpose', 'source', 'modules', 'inputDescription', 'baseRevision'].includes(key)
    )
  )
    throw AppError.withFields('VALIDATION', '程序发布字段无效', { effect: 'none' })
  for (const [name, value, max] of [
    ['name', input.name, ProgramCatalogLimits.nameChars],
    ['purpose', input.purpose, ProgramCatalogLimits.purposeChars],
  ] as const)
    if (!isString(value) || !value.trim() || value.length > max)
      throw AppError.withFields('VALIDATION', `${name} 需要非空正文，最多 ${max} 字符`, {
        effect: 'none',
      })
  if (!isString(input.source) || !input.source.trim())
    throw AppError.withFields('VALIDATION', 'source 需要完整源码', { effect: 'none' })
  if (
    !isUndefined(input.inputDescription) &&
    (!isString(input.inputDescription) ||
      input.inputDescription.length > ProgramCatalogLimits.inputDescriptionChars)
  )
    throw AppError.withFields('VALIDATION', 'inputDescription 超过公开上限', { effect: 'none' })
  if (
    !isUndefined(input.baseRevision) &&
    (!isNumber(input.baseRevision) ||
      !Number.isSafeInteger(input.baseRevision) ||
      input.baseRevision < 0 ||
      input.baseRevision >= Number.MAX_SAFE_INTEGER)
  )
    throw AppError.withFields('VALIDATION', 'baseRevision 需要非负整数', { effect: 'none' })
  if (
    !isUndefined(input.modules) &&
    (!isPlainObject(input.modules) || !Object.values(input.modules).every(isString))
  )
    throw AppError.withFields('VALIDATION', 'modules 需要源码字符串映射', { effect: 'none' })
  return structuredClone(input)
}

/** 目录分页严格核对预算，不隐式截断调用者的过滤条件。 */
export function catalogQuery(
  input: ProgramQuery
): Required<Omit<ProgramQuery, 'query'>> & Pick<ProgramQuery, 'query'> {
  if (
    !isPlainObject(input) ||
    Object.keys(input).some((key) => !['query', 'offset', 'limit'].includes(key)) ||
    (!isUndefined(input.query) && !isString(input.query))
  )
    throw new AppError('VALIDATION', '程序目录查询无效')
  const offset = input.offset ?? 0
  const limit = input.limit ?? ProgramCatalogLimits.page
  if (
    !isNumber(offset) ||
    !isNumber(limit) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ProgramCatalogLimits.maxPage
  )
    throw new AppError('VALIDATION', '程序目录分页超过公开上限')
  return { query: optionalWhen(isString, input.query), offset, limit }
}
