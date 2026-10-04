import { isEmpty, isNull } from '@velaros-ai/core'

import { CodeSurfaceErrorCodes } from '../contract/constants.js'

import { CodeSurfaceTuning } from './tuning.js'

/** 将真实进程终止和有界诊断映射为程序失败。 */
export function describeChildExit(
  code: Nullable<number>,
  stderr: string
): {
  code: string
  message: string
} {
  if (stderr.includes('heap out of memory'))
    return {
      code: CodeSurfaceErrorCodes.tooLarge,
      message:
        `脚本把 ${CodeSurfaceTuning.heapMb}MB 堆用光了，已被终止。` +
        '别把结果整个攒在内存里——边拿边筛、只留要用的那几个字段，或者分几次做。',
    }
  const quoted = stderr.slice(0, CodeSurfaceTuning.stderrQuoteChars).trim()
  const why = isNull(code) ? '被信号杀掉' : `码 ${code}`
  return {
    code: CodeSurfaceErrorCodes.runnerCrashed,
    message: isEmpty(quoted) ? `隔离进程意外退出，${why}。` : `隔离进程意外退出，${why}：${quoted}`,
  }
}
