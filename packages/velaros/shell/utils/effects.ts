import { AppError } from '@velaros-ai/core/error'

/**
 * 命令真正启动之前的一步（解析工作目录、危险命令等用户点头）：失败时原错误照样抛出，另带 `effect: 'none'`，
 * 装配层据此把回执记成没有效果——被拒或越界的命令一个进程都没起，会话不该因此进入待核对。
 */
export async function beforeCommand<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    const failure = AppError.from(error)
    throw AppError.withFields(failure.code, failure.message, { effect: 'none' }, error)
  }
}
