import { isArray, isNumber } from '@velaros-ai/core'

import { ProjectError } from '../../errors.js'
import type { ProjectLineRange } from '../types.js'

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
