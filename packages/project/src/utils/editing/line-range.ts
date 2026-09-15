import { isArray, isNumber, isUndefined } from '@velaros-ai/core'

import type { ProjectLineRange } from '../../types/editing.js'
import { ProjectError } from '../errors.js'

/** 把行范围写法（51、[51]、[42,45]）核对后换成起止行，首尾行都包含在内；写法不合法时拒绝。 */
export function normalizeProjectLineRange(range: ProjectLineRange): readonly [number, number] {
  const values: readonly number[] = isNumber(range) ? [range] : range
  if (
    !isArray(values) || values.length < 1 || values.length > 2 ||
    [...values].some((value) => !Number.isSafeInteger(value) || value < 1) ||
    (values.length === 2 && values[1] < values[0])
  ) {
    throw new ProjectError('INVALID_INPUT', 'range 必须是正整数、[行号] 或 [起始行, 结束行]，范围包含首尾行。', { range })
  }
  return [values[0], values[1] ?? values[0]]
}

/** 把 project:read 的行范围写法（51、[51]、[42,45]）换成起止行；没给范围返回 undefined。 */
export function readLineRange(range?: ProjectLineRange): Optional<{ startLine: number; endLine: number }> {
  if (isUndefined(range)) return undefined
  const [startLine, endLine] = normalizeProjectLineRange(range)
  return { startLine, endLine }
}
