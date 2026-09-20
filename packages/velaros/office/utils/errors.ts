/**
 * 外部转换的失败拼成带专属码的错误：缺转换器、命令失败或没有产出、MarkItDown 不可用。
 * message 是写给模型看的：缺什么、为什么要它、命令输出的结尾——程序只看得到 code 与 message，要它知道的都写在这里。
 */

import { isNonBlankString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { OfficeErrorCodes } from '../contract/constants.js'
import type { OfficeSystemCommandResult } from '../types/office.js'

import { OfficeTuning } from './tuning.js'

/** 本机缺某个外部命令：说清缺哪个、为什么要它，并请模型如实告诉用户，不要自己去装。 */
export function converterMissingError(command: string, purpose: string): AppError {
  return new AppError(
    OfficeErrorCodes.converterMissing,
    `本机没找到 ${command}：${purpose}。请如实告诉用户需要先装好它，不要自己去装依赖。`
  )
}

/** MarkItDown 没装或被用户停用：toMarkdown 做不了，PDF 可以改用 readPdf、Office 文档可以改用 preview。 */
export function markItDownUnavailableError(): AppError {
  return new AppError(
    OfficeErrorCodes.markItDownUnavailable,
    '没找到 MarkItDown（没装，或在设置里停用了），toMarkdown 做不了。PDF 可以改用 readPdf 读文字，Word、PowerPoint、Excel 可以改用 preview；要装请用户在插件市场里装。'
  )
}

/** 外部命令失败：写明是超时、取消还是退出码不对，再附上输出的结尾，照着改了再试。 */
export function conversionFailedError(operation: string, result: OfficeSystemCommandResult, note = ''): AppError {
  const log = commandLogTail(result)
  return new AppError(
    OfficeErrorCodes.conversionFailed,
    `${operation}失败（${describeCommandEnding(result)}）${note}${isNonBlankString(log) ? `。输出的结尾：\n${log}` : '，命令没有输出。'}`
  )
}

/** 外部命令跑完了、却没有产出预期的文件。 */
export function missingOutputError(operation: string, expected: string): AppError {
  return new AppError(OfficeErrorCodes.conversionFailed, `${operation}的命令跑完了，却没有生成 ${expected}。`)
}

/** 命令是怎么结束的：超时、被取消，还是退出码不为零。 */
function describeCommandEnding(result: OfficeSystemCommandResult): string {
  if (result.timedOut) return '超时'
  if (result.aborted) return '被取消'
  return `退出码 ${result.exitCode ?? '未知'}`
}

/** 命令输出的结尾：stdout 与 stderr 接在一起，只留最后一段。 */
function commandLogTail(result: OfficeSystemCommandResult): string {
  return [result.stdout, result.stderr]
    .filter(isNonBlankString)
    .join('\n')
    .slice(-OfficeTuning.command.failureLogChars)
    .trim()
}
