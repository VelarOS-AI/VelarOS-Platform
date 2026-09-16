import { isArray, isBlank, isPlainObject,isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryEvidenceLimits } from '../contract/constants'
import type { MemoryEvidenceInput } from '../types/memory'

import {
  buildProjectMemoryScope,
  scopeTypeForScopeId,
  SYSTEM_MEMORY_SCOPE,
} from './scope'
import { MemoryTuning } from './tuning'


const SecretPatterns: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  // 裸 JWT（无 Bearer 前缀）：header.payload.signature 三段 base64url。
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  // Cookie / Set-Cookie 头（值必含 = ）。
  {
    pattern: /((?:set-)?cookie)\s*:\s*[^\s;,]*=[^\n]*/gi,
    replacement: '$1: [REDACTED]',
  },
  // 密钥类键值：键名可带引号、可含下划线复合前后缀（access_token / AWS_SECRET_ACCESS_KEY /
  // "password"）。旧规则用 \b 起头，被 JSON 引号键和下划线复合键整体绕过。这里键名 keyword
  // 允许出现在任意位置，值可带引号。
  {
    pattern: /(["']?[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|credential)[\w.-]*["']?\s*[:=]\s*)["']?[^\s,;"'}\])]{4,}/gi,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /\b[A-Fa-f0-9]{40,}\b/g,
    replacement: '[REDACTED_SECRET]',
  },
]

/** 记忆证据文本清洗（保留换行、剥空字节、CRLF→LF、裁剪至 maxChars）；memory 域专属，勿与 readStringScalar 混淆。 */
function normalizeEvidenceText(value: string, maxChars: number): string {
  return value.replaceAll('\0', '').replace(/\r\n/g, '\n').trim().slice(0, maxChars)
}

/**
 * 秘密打码 —— **全仓唯一实现**。
 *
 * 落盘的每一处都必须经这里：正文、标题、元数据由 `sanitizeMemoryEvidenceInput` 带过，
 * 文件后端写进 frontmatter 的摘要、来源、标签这些派生字段自己调（那些值同样来自聊天正文）。
 */
export function redactMemorySecrets(value: string): string {
  return SecretPatterns.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    value
  )
}

/** 清洗一个元数据值：字符串打码并截断，数组与对象按上限收，太深就整块截掉。 */
function sanitizeMetadataValue(value: unknown, depth: number = 0): unknown {
  if (depth > MemoryTuning.tree.metadataDepth) return '[TRUNCATED_METADATA]'
  if (isString(value)) return redactMemorySecrets(normalizeEvidenceText(value, MemoryTuning.tree.metadataStringChars))
  if (isArray(value)) return value.slice(0, MemoryTuning.tree.metadataArrayItems).map((item) => sanitizeMetadataValue(item, depth + 1))
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MemoryTuning.tree.metadataArrayItems)
      .map(([key, item]) => [key.slice(0, 120), sanitizeMetadataValue(item, depth + 1)])
  )
}

/** 一条证据进后端之前的清洗：正文与标题打码截断，元数据逐项清洗，作用域按两轴补齐。 */
export function sanitizeMemoryEvidenceInput(input: MemoryEvidenceInput): MemoryEvidenceInput {
  const content = redactMemorySecrets(normalizeEvidenceText(input.content, MemoryEvidenceLimits.contentChars))
  if (isBlank(content)) throw new AppError('VALIDATION', '记忆证据内容不能为空。')

  return {
    ...input,
    sourceId: input.sourceId?.trim(),
    sessionId: input.sessionId?.trim(),
    executionId: input.executionId?.trim(),
    workspaceRoot: input.workspaceRoot?.trim(),
    scopeId: input.scopeId?.trim(),
    title: redactMemorySecrets(normalizeEvidenceText(input.title ?? '', MemoryEvidenceLimits.titleChars)),
    content,
    metadata: sanitizeMetadataValue(input.metadata ?? {}) as Record<string, unknown>,
  }
}

/** 从一条证据的作用域两格推出它该落在哪个作用域：scopeId 在场即权威，否则按工作区根物化。 */
export function inferEvidenceScope(input: MemoryEvidenceInput): {
  scopeType: NonNullable<MemoryEvidenceInput['scopeType']>
  scopeId: string
} {
  // scopeId 一旦给定就由它确定性派生 scopeType，避免调用方把 site/system 误标成 global。
  if (input.scopeId?.trim()) return { scopeType: scopeTypeForScopeId(input.scopeId), scopeId: input.scopeId.trim() }
  if (input.workspaceRoot?.trim()) return { scopeType: 'workspace', scopeId: buildProjectMemoryScope(input.workspaceRoot) }
  // system 池是自成一类的作用域，不能贴 'global'（否则会走召回的 global 逃逸泄漏到一切会话）。
  if (input.sessionId?.trim() || input.executionId?.trim()) return { scopeType: 'system', scopeId: SYSTEM_MEMORY_SCOPE }
  return { scopeType: 'global', scopeId: 'global' }
}
