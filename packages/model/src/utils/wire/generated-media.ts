import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 视频任务必须有可安全拼入轮询路径的供应商身份。 */
export function readVideoGenerationJob(value: unknown): { id: string; status: string } {
  if (
    !isPlainObject(value) ||
    !isString(value.id) ||
    !isString(value.status) ||
    !/^[a-z\d_-]+$/iu.test(value.id)
  )
    throw new AppError('PROTOCOL', '视频任务回执无效。')
  return { id: value.id, status: value.status }
}
