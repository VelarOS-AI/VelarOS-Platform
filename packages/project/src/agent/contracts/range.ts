import { z } from 'zod'

const Line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const ProjectLineRangeSchema = z.union([
  Line,
  z.tuple([Line]),
  z.tuple([Line, Line]).refine(([start, end]) => end >= start, '结束行必须大于或等于起始行。'),
]).describe('行号或连续闭区间：51、[51]、[42,45]。')
