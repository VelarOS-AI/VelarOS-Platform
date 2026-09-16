/** 站点用户脚本的纯计算：id 校验、按 id 取记录、匹配判定。 */
import { randomUUID } from 'node:crypto'

import { isArray, isBoolean, isEmpty, isFiniteNumber, isNonBlankString, isNotNull, isPlainObject, isPresent, isString, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserUserScriptLimits } from '../contract/constants'
import type { BrowserUserScriptLastRun, BrowserUserScriptPatch } from '../types/browser.js'
import type { BrowserUserScriptRecord } from '../types/browser.js'
import type { BrowserUserScriptValidatedPatch } from '../types/workspace.js'
import type { BrowserUserScriptStore } from '../types/workspace.js'



/** 按 id 取一条用户脚本；没有就报找不到。 */
export function requireScript(store: BrowserUserScriptStore, id: string): BrowserUserScriptRecord {
  const normalized = assertScriptId(id)
  const script = store.scripts.find((candidate) => candidate.id === normalized)
  if (!script) throw new AppError('NOT_FOUND', '找不到用户脚本。', undefined, { id: normalized })
  return script
}

/** 校验用户脚本 id 的形状；不合法直接报错，不让它落进索引。 */
export function assertScriptId(id: string): string {
  const normalized = id.trim()
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/.test(normalized)) {
    throw new AppError('VALIDATION', '用户脚本 id 无效。')
  }
  return normalized
}

/** 用户脚本按顺序号排一遍。 */
export function sortScripts(scripts: BrowserUserScriptRecord[]): BrowserUserScriptRecord[] {
  return [...scripts].sort(
    (left, right) => left.position - right.position || left.createdAt - right.createdAt
  )
}

/** 脚本名归一：去首尾空白；空名报错。 */
export function normalizeName(name: string): string {
  const normalized = name.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 120) {
    throw new AppError('VALIDATION', '脚本名称必须为 1 到 120 个字符。')
  }
  return normalized
}

/** 脚本说明归一：空的当缺席。 */
export function normalizeDescription(description: LooseOptional<string>): LooseOptional<string> {
  const normalized = description?.trim()
  if (!normalized) return undefined
  if (normalized.length > 500) throw new AppError('VALIDATION', '脚本描述不能超过 500 个字符。')
  return normalized
}

/** match / excludeMatch 规则归一：去空、去重，并逐条校验。 */
export function normalizePatterns(patterns: LooseOptional<string[]>, field: string): string[] {
  if (!patterns) return []
  if (patterns.length > BrowserUserScriptLimits.matchRules) {
    throw new AppError('VALIDATION', `${field} 最多允许 ${BrowserUserScriptLimits.matchRules} 条规则。`)
  }
  const normalized = [...new Set(patterns.map((item) => item.trim()).filter(Boolean))]
  normalized.forEach((pattern) => validateUrlPattern(pattern, field))
  return normalized
}

/** 校验一条 URL 匹配规则；只认 http/https，不合法就报错。 */
export function validateUrlPattern(pattern: string, field: string): void {
  if (pattern.length > 500) throw new AppError('VALIDATION', `${field} 规则过长。`)
  if (pattern === '<all_urls>') return
  if (!pattern.includes('://')) {
    throw new AppError('VALIDATION', `${field} 必须是浏览器 match pattern。`, undefined, { pattern })
  }
  const [scheme, rest] = pattern.split('://', 2)
  if (!['http', 'https', '*'].includes(scheme ?? '') || !rest?.includes('/')) {
    throw new AppError('VALIDATION', `${field} 只支持 http/https 浏览器 match pattern。`, undefined, {
      pattern,
    })
  }
  const host = rest.slice(0, rest.indexOf('/'))
  if (!host || (host.includes('*') && host !== '*' && !host.startsWith('*.'))) {
    throw new AppError('VALIDATION', `${field} 的 host 通配符无效。`, undefined, { pattern })
  }
}

/** 脚本代码归一：统一换行、结尾补一个换行。 */
export function normalizeCode(code: string): string {
  if (!code.trim()) throw new AppError('VALIDATION', '脚本内容不能为空。')
  if (Buffer.byteLength(code, 'utf8') > BrowserUserScriptLimits.codeBytes) {
    throw new AppError('VALIDATION', '单个用户脚本不能超过 1 MB。')
  }
  return code.endsWith('\n') ? code : `${code}\n`
}

/** 把一段文本转义成正则字面量里安全的形式。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 用 * 通配的简单匹配，判断一个值命中不命中 pattern。 */
export function globMatches(value: string, pattern: string): boolean {
  const expression = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`
  return new RegExp(expression).test(value)
}

/** 按脚本 id 拼出它在数据根下的文件路径。 */
export function scriptPath(id: string): string {
  return `scripts/${id}.js`
}

/** 按脚本名生成一个稳定可读的 id。 */
export function createScriptId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'script'
  return `${slug}-${randomUUID().slice(0, 8)}`
}

/** 从落盘的索引里读一个整数字段；形状不对就报错，不拿坏数据往下跑。 */
export function requireStoredInteger(value: unknown, field: string, minimum: number): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < minimum) {
    throw new AppError('VALIDATION', `浏览器用户脚本索引字段 ${field} 无效。`)
  }
  return value
}

/** 从落盘的索引里读一组匹配规则；形状不对就报错。 */
export function requireStoredPatterns(value: unknown, field: string, optional: boolean): LooseOptional<string[]> {
  if (!isPresent(value)) {
    if (optional) return undefined
    throw new AppError('VALIDATION', `浏览器用户脚本索引缺少字段 ${field}。`)
  }
  if (!isArray(value) || !value.every(isString)) {
    throw new AppError('VALIDATION', `浏览器用户脚本索引字段 ${field} 无效。`)
  }
  const patterns = normalizePatterns(value, field)
  if (!optional && isEmpty(patterns)) {
    throw new AppError('VALIDATION', `浏览器用户脚本索引字段 ${field} 不能为空。`)
  }
  return patterns
}

/** 从落盘的索引里读「上次运行」记录；形状不对就当没有。 */
export function requireStoredLastRun(value: unknown): LooseOptional<BrowserUserScriptLastRun> {
  if (!isPresent(value)) return undefined
  if (!isPlainObject(value)) {
    throw new AppError('VALIDATION', '浏览器用户脚本索引字段 lastRun 无效。')
  }
  const stored = value
  const status = stored.status
  if (status !== 'success' && status !== 'error' && status !== 'unsupported') {
    throw new AppError('VALIDATION', '浏览器用户脚本索引字段 lastRun.status 无效。')
  }
  if (!isString(stored.url) || !isString(stored.documentId)) {
    throw new AppError('VALIDATION', '浏览器用户脚本索引字段 lastRun 无效。')
  }
  if (isPresent(stored.error) && !isString(stored.error)) {
    throw new AppError('VALIDATION', '浏览器用户脚本索引字段 lastRun.error 无效。')
  }
  return {
    status,
    url: stored.url,
    documentId: stored.documentId,
    scriptRevision: requireStoredInteger(stored.scriptRevision, 'lastRun.scriptRevision', 1),
    startedAt: requireStoredInteger(stored.startedAt, 'lastRun.startedAt', 0),
    finishedAt: requireStoredInteger(stored.finishedAt, 'lastRun.finishedAt', 0),
    error: toOptional(stored.error),
  }
}

/** 从落盘的索引里读一条完整的脚本记录；形状不对就报错。 */
export function requireStoredScript(value: unknown): BrowserUserScriptRecord {
  if (!isPlainObject(value)) {
    throw new AppError('VALIDATION', '浏览器用户脚本索引包含无效记录。')
  }
  const stored = value
  const id = assertScriptId(isString(stored.id) ? stored.id : '')
  if (!isString(stored.name) || !isNonBlankString(stored.version)) {
    throw new AppError('VALIDATION', `浏览器用户脚本 ${id} 缺少名称或版本。`)
  }
  if (isPresent(stored.description) && !isString(stored.description)) {
    throw new AppError('VALIDATION', `浏览器用户脚本 ${id} 的 description 无效。`)
  }
  if (!isBoolean(stored.enabled)) {
    throw new AppError('VALIDATION', `浏览器用户脚本 ${id} 的 enabled 无效。`)
  }
  if (
    stored.source !== 'agent' &&
    stored.source !== 'user' &&
    stored.source !== 'user-import'
  ) {
    throw new AppError('VALIDATION', `浏览器用户脚本 ${id} 的 source 无效。`)
  }
  if (
    stored.runAt !== 'document-start' &&
    stored.runAt !== 'document-end' &&
    stored.runAt !== 'document-idle'
  ) {
    throw new AppError('VALIDATION', `浏览器用户脚本 ${id} 的 runAt 无效。`)
  }
  if (stored.world !== 'isolated' && stored.world !== 'main') {
    throw new AppError('VALIDATION', `浏览器用户脚本 ${id} 的 world 无效。`)
  }
  if (stored.relativePath !== scriptPath(id)) {
    throw new AppError('VALIDATION', `浏览器用户脚本 ${id} 的 relativePath 无效。`)
  }

  return {
    id,
    name: normalizeName(stored.name),
    description: normalizeDescription(stored.description as LooseOptional<string>),
    version: stored.version.trim(),
    revision: requireStoredInteger(stored.revision, 'revision', 1),
    position: requireStoredInteger(stored.position, 'position', 0),
    match: requireStoredPatterns(stored.match, 'match', false)!,
    excludeMatch: requireStoredPatterns(stored.excludeMatch, 'excludeMatch', true),
    runAt: stored.runAt,
    world: stored.world,
    enabled: stored.enabled,
    source: stored.source,
    // 索引路径即使通过校验也不直接复用，始终由脚本 ID 重建。
    relativePath: scriptPath(id),
    createdAt: requireStoredInteger(stored.createdAt, 'createdAt', 0),
    updatedAt: requireStoredInteger(stored.updatedAt, 'updatedAt', 0),
    lastRun: requireStoredLastRun(stored.lastRun),
  }
}

/**
 * 把 patch 里出现的字段一次性校验成最终值。
 *
 * 这一步不碰磁盘：任何一条不合法都在写任何文件之前抛错，用户脚本不会停在「代码已换、
 * 索引没动」的半截状态上。
 */
export function validateUserScriptPatch(patch: BrowserUserScriptPatch): BrowserUserScriptValidatedPatch {
  const match = isPresent(patch.match) ? normalizePatterns(patch.match, 'match') : null
  if (isNotNull(match) && isEmpty(match)) {
    throw new AppError('VALIDATION', '脚本至少需要一个 match 规则。')
  }

  return {
    code: isPresent(patch.code) ? normalizeCode(patch.code) : null,
    name: isPresent(patch.name) ? normalizeName(patch.name) : null,
    description: 'description' in patch ? { value: normalizeDescription(patch.description) } : null,
    match,
    excludeMatch: isPresent(patch.excludeMatch)
      ? normalizePatterns(patch.excludeMatch, 'excludeMatch')
      : null,
    version: isPresent(patch.version) ? patch.version.trim() || null : null,
  }
}
