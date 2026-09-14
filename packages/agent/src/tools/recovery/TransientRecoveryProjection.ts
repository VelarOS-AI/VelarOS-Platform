import type { ModelMessage } from 'ai'

import { isArray, isFalse, isPlainObject, isString, Log, optionalWhen } from '@velaros-ai/core'

import { isContextRefEnvelope } from '../../agent/context/contextRefEnvelope'

const RecoveryToolNames = new Set(['project:edit', 'project:file', 'project:change'])
const RecoveryKinds = new Set(['project-edit-candidates', 'project-edit-validation'])

function isRecovery(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && isString(value.kind) && RecoveryKinds.has(value.kind)
}

/** 只有项目修改失败回执携带受信任的恢复元数据，源码 JSON 不参与候选扫描。 */
function projectRecovery(value: unknown, archive: boolean, errorOutput: boolean, depth = 0): unknown {
  if (!isPlainObject(value) || depth > 8) return value
  if (isContextRefEnvelope(value) && isString(value.excerpt)) {
    try {
      const decoded = JSON.parse(value.excerpt)
      const projected = projectRecovery(decoded, archive, errorOutput, depth + 1)
      return projected === decoded ? value : { ...value, excerpt: JSON.stringify(projected) }
    } catch { Log.tag('ContextProjection').debug('跳过无法解析或序列化的记录，保持原文与召回入口')

      // 根据真实错误载体或摘要保留的错误头确认失败来源；
      // 无法解析的拼接内容不提供候选，只保留召回入口。
      const failureHeader = /^\s*\{\s*"error"\s*:/u.test(value.excerpt)
      if (errorOutput || failureHeader) {
        const { excerpt: _excerpt, ...envelope } = value
        return { ...envelope, excerptTruncated: true, reason: '工具失败摘录不完整；请召回该次工具回执查看完整详情。' }
      }
      return value
    }
  }
  if (!archive || (!errorOutput && !isString(value.error) && !isFalse(value.ok))) return value
  const receipt = (recovery: Record<string, unknown>) => ({ kind: recovery.kind, status: 'archived', note: '恢复详情已归档；需要时召回该次工具回执。' })
  const details = optionalWhen(isPlainObject, value.details)
  if (details && isRecovery(details.recovery)) return { ...value, details: { ...details, recovery: receipt(details.recovery) } }
  if (isRecovery(value.recovery)) return { ...value, recovery: receipt(value.recovery) }
  return value
}

function projectToolContent(content: unknown, archive: boolean): unknown {
  if (!isArray(content)) return content
  return content.map((part) => {
    if (!isPlainObject(part) || part.type !== 'tool-result' || !RecoveryToolNames.has(String(part.toolName)) || !isPlainObject(part.output)) return part
    const output = part.output
    const errorOutput = output.type === 'error-text' || output.type === 'error-json'
    if ((output.type === 'text' || output.type === 'error-text') && isString(output.value)) {
      try {
        const value = JSON.parse(output.value)
        const projected = projectRecovery(value, archive, errorOutput)
        return projected === value ? part : { ...part, output: { ...output, value: JSON.stringify(projected) } }
      } catch { Log.tag('ContextProjection').debug('跳过无法解析或序列化的记录，保持原文与召回入口')
 return part }
    }
    if (output.type !== 'json' && output.type !== 'error-json') return part
    const projected = projectRecovery(output.value, archive, errorOutput)
    return projected === output.value ? part : { ...part, output: { ...output, value: projected } }
  })
}

/**
 * The next model decision sees each failure's candidates once. Following an assistant/user boundary,
 * only its short receipt remains in provider history; the stored output is untouched and recallable.
 */
export function projectTransientRecoveryHistory(messages: readonly ModelMessage[]): ModelMessage[] {
  let latestDecision = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' || messages[index].role === 'user') {
      latestDecision = index
      break
    }
  }
  return messages.map((message, index) => message.role === 'tool'
    ? { ...message, content: projectToolContent(message.content, index < latestDecision) as typeof message.content }
    : message)
}
