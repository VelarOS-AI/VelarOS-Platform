/**
 * Ring 0 出核地板（宪章 §2 判据七）：`assertProviderRequestInvariants` + 请求指纹。
 *
 * 这是「出口地板」而非可替换管线的一环——无论哪个 ContextAssembler 拼出的请求，出核前
 * 都必须过这道校验。终局它随 kernel-host 批次迁入 `@velaros-ai/kernel`；此处先剥离成独立模块，
 * 与 Ring 1 六 stage 物理分家，行为逐字节不变。
 */
import type { ModelMessage } from 'ai'

import { isBlank, isEmpty, isFalse } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProviderRequestFingerprint } from '../../../kernel/provider-events'
import type { CompileProviderRequestInput } from '../ProviderRequestCompiler'
import { compareStableStrings } from '../residency/determinism'

import { shortHash } from './contentHash'
import { sortedStrings, sumPositive, type ToolReferenceScan } from './messageScan'
import { encodeProviderRequestAuditValue } from './serialization'

/** 校验相位标记：目前仅编译期一处出核，保留类型以备未来 seam 扩展。 */
export type AssertProviderRequestInvariantPhase = 'compile'

/** 解析本轮暴露的工具名：优先显式 availableToolNames，否则退回 toolSchemaChars 键集。 */
export function resolveAvailableToolNames(input: CompileProviderRequestInput): string[] {
  if (input.availableToolNames) return sortedStrings(input.availableToolNames)

  return sortedStrings(Object.keys(input.toolSchemaChars ?? {}))
}

/** 归一化 toolSchemaChars：trim 键、钳非负、去空键、按键名排序，稳定指纹的工具面哈希。 */
export function normalizeToolSchemaCharEntries(
  toolSchemaChars?: Record<string, number>
): Array<[string, number]> {
  return Object.entries(toolSchemaChars ?? {})
    .map(([toolName, chars]) => [toolName.trim(), Number.isFinite(chars) ? Math.max(0, chars) : 0] as [string, number])
    .filter(([toolName]) => !isBlank(toolName))
    .sort(([left], [right]) => compareStableStrings(left, right))
}

/**
 * 构建请求指纹。scan 由共享 scratch 提供（对最终 provider 消息只扫一次），避免地板与诊断
 * 各自重复全量扫描。
 */
export function buildProviderRequestFingerprint(
  input: CompileProviderRequestInput,
  messages: readonly ModelMessage[],
  scan: ToolReferenceScan
): ProviderRequestFingerprint {
  const availableToolNames = resolveAvailableToolNames(input)
  const availableToolNameSet = new Set(availableToolNames)
  const historyToolNames = sortedStrings(scan.toolNames)
  const missingHistoryToolNames = input.availableToolNames
    ? historyToolNames.filter((toolName) => !availableToolNameSet.has(toolName))
    : []
  const toolChoiceName = input.toolChoiceName?.trim() || null
  const toolChoiceVisible = toolChoiceName ? availableToolNameSet.has(toolChoiceName) : null
  const roleSequence = messages.map((message) => message.role)
  const toolSchemaCharEntries = normalizeToolSchemaCharEntries(input.toolSchemaChars)
  const toolSchemaHashEntries = Object.entries(input.toolSchemaHashes ?? {})
    .map(([toolName, hash]) => [toolName.trim(), hash.trim()] as const)
    .filter(([toolName, hash]) => !isBlank(toolName) && !isBlank(hash))
    .sort(([left], [right]) => compareStableStrings(left, right))
  const toolSchemaCharsTotal = sumPositive(toolSchemaCharEntries.map(([, chars]) => chars))
  const systemHash = shortHash(input.systemPrompt)
  const messageHash = shortHash(JSON.stringify(encodeProviderRequestAuditValue(messages)))
  const toolSurfaceHash = shortHash(
    JSON.stringify({
      availableToolNames,
      toolSchemaChars: toolSchemaCharEntries,
      toolSchemaHashes: toolSchemaHashEntries,
    })
  )
  const prefixHash = shortHash(
    JSON.stringify({
      systemPrompt: input.systemPrompt,
      toolSurface: {
        availableToolNames,
        toolSchemaChars: toolSchemaCharEntries,
        toolSchemaHashes: toolSchemaHashEntries,
      },
    })
  )
  const fingerprintSeed = JSON.stringify({
    prefixHash,
    messageHash,
    roles: roleSequence,
    availableToolNames,
    historyToolNames,
    missingHistoryToolNames,
    toolChoiceName,
    toolChoiceVisible,
    contextRefCount: scan.contextRefCount,
    historyToolCallIds: sortedStrings(scan.toolCallIds),
    historyToolResultIds: sortedStrings(scan.toolResultIds),
  })

  return {
    id: shortHash(fingerprintSeed),
    systemHash,
    toolSurfaceHash,
    prefixHash,
    messageHash,
    toolSchemaCharsTotal,
    messageCount: messages.length,
    roleSequence,
    availableToolNames,
    historyToolNames,
    missingHistoryToolNames,
    toolChoiceName,
    toolChoiceVisible,
    contextRefCount: scan.contextRefCount,
    historyToolCallIds: sortedStrings(scan.toolCallIds),
    historyToolResultIds: sortedStrings(scan.toolResultIds),
  }
}

/** 出核地板校验：不变量违反即抛错取消发送，绝不出核。 */
export function assertProviderRequestInvariants(
  input: CompileProviderRequestInput,
  requestFingerprint: ProviderRequestFingerprint,
  phase: AssertProviderRequestInvariantPhase
): void {
  const issues: string[] = []

  // 历史里出现过但本轮未暴露的工具是动态工具空间的正常状态：
  // 过去的 tool-call/tool-result 只是回放事实，不要求当前 provider tools 仍包含同名 schema。
  // 仍在 fingerprint 中记录 missingHistoryToolNames 供诊断，但不要阻断重新 page-in。

  if (requestFingerprint.toolChoiceName && isFalse(requestFingerprint.toolChoiceVisible)) {
    issues.push(`toolChoice points to hidden tool: ${requestFingerprint.toolChoiceName}`)
  }

  const explicitToolSurface =
    Boolean(input.availableToolNames) || !isEmpty(Object.keys(input.toolSchemaChars ?? {}))
  const recallProviderToolName =
    input.toolNameAliases?.['context:recall']?.trim() || 'context:recall'
  if (
    explicitToolSurface &&
    requestFingerprint.contextRefCount > 0 &&
    !requestFingerprint.availableToolNames.includes(recallProviderToolName)
  ) {
    issues.push('provider-visible context handles require resident context:recall tool')
  }

  if (isEmpty(issues)) return

  throw new AppError(
    'VALIDATION',
    `模型请求不变量校验失败，已取消发送请求：${issues.join('；')}`,
    undefined,
    {
      source: 'provider-request-invariants',
      phase,
      requestFingerprint,
      issues,
    }
  )
}
