import { AppError } from '@velaros-ai/core'

import { VelarosCliErrorCodes, VelarosCliExitCodes } from '../contract/constants.js'

/**
 * 命令行解析或执行阶段产生的稳定错误：错误码与退出码一起带着走。
 * 错误类不出包，外面按失败信封里的 `error.code` 判断，不按文字。
 */
export class VelarosCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number = VelarosCliExitCodes.failure,
    public readonly details: PlainObject = {},
  ) {
    super(message)
    this.name = 'VelarosCliError'
  }
}

/** 把任意异常收成命令行错误：本包抛的原样返回，其余收成 `EXECUTION_ERROR`（退出码 1）。 */
export function normalizeVelarosCliError(error: unknown): VelarosCliError {
  if (error instanceof VelarosCliError) return error

  return new VelarosCliError(
    VelarosCliErrorCodes.executionError,
    AppError.getMessage(error),
    VelarosCliExitCodes.failure,
  )
}
