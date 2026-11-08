import { isArray, isBoolean, isNumber, isPlainObject, isString, Log } from '@velaros-ai/core'
import type { InvocationRecord } from '@velaros-ai/kernel'
import { ModelRequestAuditLimits } from '@velaros-ai/model/contracts'

import type { ActInvocationSummary, ActRequestSummary } from '../types/trace.js'

/** 从权威回执生成宿主展示，不解析被裁剪的 JSON，也不推断未结算效果。 */
export function summarizeInvocation(
  record: InvocationRecord,
  maxChars: number,
  fullContent = false
): ActInvocationSummary {
  const input = JSON.stringify(record.prepared.input) ?? ''
  const output = record.receipt
    ? (JSON.stringify(record.receipt.error ?? record.receipt.value) ?? '')
    : ''
  const inputLimit = fullContent ? input.length : Math.min(2000, Math.floor(maxChars / 2))
  const inputText = input.slice(0, inputLimit)
  const outputText = output.slice(
    0,
    fullContent ? output.length : Math.min(6000, maxChars - inputText.length)
  )
  const projectChange = projectChangeSummary(
    record,
    Math.max(0, maxChars - inputText.length - outputText.length)
  )
  return {
    projectChange,
    moduleId: record.prepared.binding.moduleId,
    operation: record.prepared.operation,
    status: record.receipt?.outcome ?? 'pending',
    effect: record.receipt?.effect ?? 'unknown',
    input: inputText,
    output: outputText,
    inputTruncated: inputText.length < input.length,
    outputTruncated: outputText.length < output.length,
  }
}

/** 只接受领域诊断，不解析程序输出或被裁剪的展示文本。 */
function projectChangeSummary(
  record: InvocationRecord,
  patchBudget: number
): ActInvocationSummary['projectChange'] {
  const diagnostic = record.receipt?.diagnostic
  if (
    record.prepared.binding.moduleId !== 'velaros:project' ||
    !['commit', 'edit', 'patch', 'undo'].includes(record.prepared.operation) ||
    record.receipt?.effect !== 'committed' ||
    diagnostic?.code !== 'PROJECT_TRANSACTION_COMMITTED' ||
    diagnostic.truncated
  )
    return undefined
  try {
    const fact: unknown = JSON.parse(diagnostic.message)
    if (
      !isPlainObject(fact) ||
      !isString(fact.root) ||
      !fact.root ||
      !isString(fact.transactionId) ||
      !fact.transactionId ||
      (fact.lifecycle !== 'applied' && fact.lifecycle !== 'rolled_back') ||
      !isArray(fact.changedFiles) ||
      !fact.changedFiles.every(isString) ||
      !isNumber(fact.omittedFiles) ||
      !Number.isSafeInteger(fact.omittedFiles) ||
      fact.omittedFiles < 0
    )
      return undefined
    const value = record.receipt.value
    const fileStats = isPlainObject(fact.fileStats) ? fact.fileStats : {}
    if (isPlainObject(value) && (value.changed === false || value.alreadyUndone)) return undefined
    const diff =
      fact.lifecycle === 'applied' &&
      isPlainObject(value) &&
      isString(value.diff) &&
      value.diff.length <= Math.min(65536, patchBudget)
        ? value.diff
        : ''
    return {
      root: fact.root,
      transactionId: fact.transactionId,
      lifecycle: fact.lifecycle,
      changedFiles: fact.changedFiles,
      fileStats: Object.fromEntries(
        fact.changedFiles.flatMap((path) => {
          const stats = fileStats[path]
          return isPlainObject(stats) &&
            Number.isSafeInteger(stats.additions) &&
            isNumber(stats.additions) &&
            stats.additions >= 0 &&
            Number.isSafeInteger(stats.deletions) &&
            isNumber(stats.deletions) &&
            stats.deletions >= 0
            ? [[path, { additions: stats.additions, deletions: stats.deletions }]]
            : []
        })
      ),
      omittedFiles: fact.omittedFiles,
      diff,
      patchOmitted: !diff || (isPlainObject(value) && value.diffTruncated === true),
    }
  } catch {
    Log.tag('ActRuntime').debug('项目事务诊断不是有效 JSON，省略更改卡片并保留原回执')
    return undefined
  }
}

/** 子任务结果笔记里最后接纳的一段回答；笔记形状不对或没有回答时为空。 */
export function childAnswerText(note: unknown): string {
  if (!isPlainObject(note) || !isArray(note.events)) return ''
  const accepted: unknown = note.events.findLast(
    (event) => isPlainObject(event) && event.type === 'accepted' && isString(event.text)
  )
  return isPlainObject(accepted) && isString(accepted.text) ? accepted.text : ''
}

/** 只展示当前有界审计合同；不反向还原历史请求正文。 */
export function summarizeModelRequest(audit: unknown): Nullable<ActRequestSummary> {
  if (!isPlainObject(audit) || !isPlainObject(audit.requestAudit)) return null
  const request = audit.requestAudit
  if (
    request.schemaVersion !== 3 ||
    !isString(request.model) ||
    request.model.length > ModelRequestAuditLimits.modelChars ||
    !isBoolean(request.modelTruncated) ||
    !isNumber(request.inputTokens) ||
    !Number.isSafeInteger(request.inputTokens) ||
    request.inputTokens < 0 ||
    (request.precision !== 'exact' && request.precision !== 'estimate') ||
    !isString(request.basis) ||
    request.basis.length > ModelRequestAuditLimits.basisChars ||
    !isBoolean(request.basisTruncated) ||
    !isNumber(request.outputTokens) ||
    !Number.isSafeInteger(request.outputTokens) ||
    request.outputTokens < 1 ||
    !isNumber(request.messageCount) ||
    !Number.isSafeInteger(request.messageCount) ||
    request.messageCount < 0 ||
    !isNumber(request.toolCount) ||
    !Number.isSafeInteger(request.toolCount) ||
    request.toolCount < 0 ||
    !isPlainObject(request.requestFingerprint) ||
    !isString(request.requestFingerprint.id) ||
    !/^[0-9a-f]{16}$/u.test(request.requestFingerprint.id)
  )
    return null
  return {
    model: request.model,
    modelTruncated: request.modelTruncated,
    fingerprint: request.requestFingerprint.id,
    inputTokens: request.inputTokens,
    precision: request.precision,
    basis: request.basis,
    basisTruncated: request.basisTruncated,
    outputTokens: request.outputTokens,
    messageCount: request.messageCount,
    toolCount: request.toolCount,
  }
}
