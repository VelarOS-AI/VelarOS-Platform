import { isArray, isBoolean, isPlainObject, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { CodeProgramEditLimits, CodeSurfaceLimits } from '@velaros-ai/script/contracts'

import { ScriptLeaseLimits } from '../../system/contract/constants.js'
import type { ScriptSubmission } from '../types/session.js'

/** 提交不合约定：在任何检查、存档与执行之前拒绝。 */
function submissionInput(message: string): Error {
  return AppError.withFields('INPUT_SCHEMA', `输入不符合脚本提交约定：${message}`, {
    effect: 'none',
  })
}

/** 只含这些字段的普通对象。 */
function checkFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) throw submissionInput(`${label} 不接受字段 ${extra}`)
}

/** 长度在范围内的字符串。 */
function checkText(
  value: unknown,
  label: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): void {
  if (!isString(value) || value.length < min || value.length > max)
    throw submissionInput(`${label} 需要 ${min} 到 ${max} 个字符`)
}

/** 值全是字符串的普通对象（附属模块、大字符串旁路）。 */
function checkStrings(value: unknown, label: string): void {
  if (!isPlainObject(value) || !Object.values(value).every(isString))
    throw submissionInput(`${label} 必须是值为字符串的对象`)
}

/** 一组精确替换：每处 oldText 不为空，一次最多 `CodeProgramEditLimits.edits` 处。 */
function checkEdits(value: unknown, label: string): void {
  if (!isArray(value) || value.length < 1 || value.length > CodeProgramEditLimits.edits)
    throw submissionInput(`${label} 需要 1 到 ${CodeProgramEditLimits.edits} 处替换`)
  value.forEach((edit, index) => {
    if (!isPlainObject(edit)) throw submissionInput(`${label}[${index}] 必须是对象`)
    checkFields(edit, ['oldText', 'newText', 'module'], `${label}[${index}]`)
    checkText(edit.oldText, `${label}[${index}].oldText`, 1)
    checkText(edit.newText, `${label}[${index}].newText`, 0)
    if (!isUndefined(edit.module)) checkText(edit.module, `${label}[${index}].module`, 0)
  })
}

/** 一段程序：给正文（source），或引用已存档的源码（sourceRef，可带替换）；观察还可以只给替换，改当前那一份。execute 另可声明结果租约。 */
function checkProgram(value: unknown, label: 'observe' | 'execute'): void {
  if (!isPlainObject(value)) throw submissionInput(`${label} 必须是对象`)
  const lease = label === 'execute' ? ['retainTurns', 'timeoutMs'] : ['refresh']
  if (
    label === 'execute' &&
    !isUndefined(value.timeoutMs) &&
    (!Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > CodeSurfaceLimits.maxExecutionTimeoutMs)
  )
    throw submissionInput(
      `timeoutMs 需要 1 到 ${CodeSurfaceLimits.maxExecutionTimeoutMs} 的整数毫秒`
    )
  if (label === 'observe' && !isUndefined(value.refresh) && !isBoolean(value.refresh))
    throw submissionInput('observe.refresh 必须是布尔值')
  if (!isUndefined(value.snapshot)) {
    if (label !== 'observe') throw submissionInput('snapshot 只能用于 observe')
    checkFields(value, ['snapshot', 'refresh'], label)
    if (!isPlainObject(value.snapshot)) throw submissionInput('snapshot 必须是对象')
    checkFields(value.snapshot, ['provider', 'plan', 'input'], 'snapshot')
    checkText(value.snapshot.provider, 'snapshot.provider', 1, 128)
    checkText(value.snapshot.plan, 'snapshot.plan', 1, 128)
    if (!Object.hasOwn(value.snapshot, 'input')) throw submissionInput('snapshot 需要 input')
  } else if (!isUndefined(value.source)) {
    checkFields(value, ['source', 'language', 'modules', 'input', 'blobs', ...lease], label)
    checkText(value.source, `${label}.source`, 1)
    if (!isUndefined(value.language) && value.language !== 'node')
      throw submissionInput('language 必须是 node')
    if (!isUndefined(value.modules)) checkStrings(value.modules, `${label}.modules`)
  } else if (!isUndefined(value.sourceRef)) {
    checkFields(value, ['sourceRef', 'edits', 'input', 'blobs', ...lease], label)
    checkText(value.sourceRef, `${label}.sourceRef`, 1, 128)
    if (!isUndefined(value.edits)) checkEdits(value.edits, `${label}.edits`)
  } else if (label === 'observe' && !isUndefined(value.edits)) {
    checkFields(value, ['edits', 'input', 'blobs', ...lease], label)
    checkEdits(value.edits, `${label}.edits`)
  } else {
    throw submissionInput(
      label === 'observe'
        ? 'observe 需要 source、sourceRef 或 edits'
        : 'execute 需要 source 或 sourceRef'
    )
  }
  if (!isUndefined(value.blobs)) checkStrings(value.blobs, `${label}.blobs`)
  const turns = value.retainTurns
  if (
    !isUndefined(turns) &&
    turns !== 'task' &&
    turns !== 'segment' &&
    !(
      Number.isSafeInteger(turns) &&
      (turns as number) >= 1 &&
      (turns as number) <= ScriptLeaseLimits.maxTurns
    )
  )
    throw submissionInput(
      `retainTurns 需要 1 到 ${ScriptLeaseLimits.maxTurns} 的整数、'segment' 或 'task'`
    )
}

/** 一次脚本提交（文本协议解出来的，或宿主直接交来的），按 `ScriptSubmission` 逐项核对：至少有 observe 或 execute。 */
export function checkScriptSubmission(value: unknown): asserts value is ScriptSubmission {
  if (!isPlainObject(value)) throw submissionInput('提交必须是对象')
  checkFields(value, ['observe', 'execute'], '提交')
  if (isUndefined(value.observe) && isUndefined(value.execute))
    throw submissionInput('至少要有 observe 或 execute')
  if (!isUndefined(value.observe)) checkProgram(value.observe, 'observe')
  if (!isUndefined(value.execute)) checkProgram(value.execute, 'execute')
}
