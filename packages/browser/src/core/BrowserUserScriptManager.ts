import { randomUUID } from 'node:crypto'

import { isArray, isBoolean, isEmpty, isFiniteNumber, isNonBlankString, isObject, isPresent, isString, optionalWhen, stringifyPretty,toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserSiteContext, BrowserUserScriptDraft, BrowserUserScriptLastRun, BrowserUserScriptOverview, BrowserUserScriptPatch, BrowserUserScriptRecord, WorkspaceReadFileResult, WorkspaceWriteFileOptions, WorkspaceWriteFileResult } from './types.js'

const BrowserUserScriptIndexPath = 'scripts/index.json'
const BrowserUserScriptStoreVersion = 1 as const
const MaxUserScriptBytes = 1_000_000
const MaxPatternCount = 64

interface BrowserUserScriptAccess {
  readFile: (
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number
  ) => Promise<WorkspaceReadFileResult>
  writeFile: (
    path: string,
    content: string,
    options?: WorkspaceWriteFileOptions
  ) => Promise<WorkspaceWriteFileResult>
  deleteFile: (path: string) => Promise<{ path: string; deleted: boolean }>
}

interface BrowserUserScriptStore {
  version: typeof BrowserUserScriptStoreVersion
  globalEnabled: boolean
  scripts: BrowserUserScriptRecord[]
}

function sortScripts(scripts: BrowserUserScriptRecord[]): BrowserUserScriptRecord[] {
  return [...scripts].sort(
    (left, right) => left.position - right.position || left.createdAt - right.createdAt
  )
}

function normalizeName(name: string): string {
  const normalized = name.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 120) {
    throw new AppError('VALIDATION', '脚本名称必须为 1 到 120 个字符。')
  }
  return normalized
}

function normalizeDescription(description: LooseOptional<string>): LooseOptional<string> {
  const normalized = description?.trim()
  if (!normalized) return undefined
  if (normalized.length > 500) throw new AppError('VALIDATION', '脚本描述不能超过 500 个字符。')
  return normalized
}

function normalizePatterns(patterns: LooseOptional<string[]>, field: string): string[] {
  if (!patterns) return []
  if (patterns.length > MaxPatternCount) {
    throw new AppError('VALIDATION', `${field} 最多允许 ${MaxPatternCount} 条规则。`)
  }
  const normalized = [...new Set(patterns.map((item) => item.trim()).filter(Boolean))]
  normalized.forEach((pattern) => validateUrlPattern(pattern, field))
  return normalized
}

function validateUrlPattern(pattern: string, field: string): void {
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

function normalizeCode(code: string): string {
  if (!code.trim()) throw new AppError('VALIDATION', '脚本内容不能为空。')
  if (Buffer.byteLength(code, 'utf8') > MaxUserScriptBytes) {
    throw new AppError('VALIDATION', '单个用户脚本不能超过 1 MB。')
  }
  return code.endsWith('\n') ? code : `${code}\n`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globMatches(value: string, pattern: string): boolean {
  const expression = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`
  return new RegExp(expression).test(value)
}

/** Chrome 风格 match pattern 的有界子集：http/https、* scheme、* / *.host。 */
export function browserUserScriptPatternMatches(url: string, pattern: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (pattern === '<all_urls>') return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  const separator = pattern.indexOf('://')
  if (separator < 0) return globMatches(url, pattern)
  const scheme = pattern.slice(0, separator)
  const remainder = pattern.slice(separator + 3)
  const slash = remainder.indexOf('/')
  if (slash < 0) return false
  const hostPattern = remainder.slice(0, slash).toLowerCase()
  const pathPattern = remainder.slice(slash)
  const protocol = parsed.protocol.slice(0, -1)
  if (scheme !== '*' && scheme !== protocol) return false
  if (scheme === '*' && protocol !== 'http' && protocol !== 'https') return false
  const host = parsed.hostname.toLowerCase()
  const hostMatches =
    hostPattern === '*' ||
    hostPattern === host ||
    (hostPattern.startsWith('*.') &&
      (host === hostPattern.slice(2) || host.endsWith(`.${hostPattern.slice(2)}`)))
  if (!hostMatches) return false
  return globMatches(`${parsed.pathname}${parsed.search}${parsed.hash}`, pathPattern)
}

export function browserUserScriptMatchesUrl(script: BrowserUserScriptRecord, url: string): boolean {
  if (!script.match.some((pattern) => browserUserScriptPatternMatches(url, pattern))) return false
  return !(script.excludeMatch ?? []).some((pattern) =>
    browserUserScriptPatternMatches(url, pattern)
  )
}

function scriptPath(id: string): string {
  return `scripts/${id}.js`
}

function assertScriptId(id: string): string {
  const normalized = id.trim()
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/.test(normalized)) {
    throw new AppError('VALIDATION', '用户脚本 id 无效。')
  }
  return normalized
}

function createScriptId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'script'
  return `${slug}-${randomUUID().slice(0, 8)}`
}

function requireStoredInteger(value: unknown, field: string, minimum: number): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < minimum) {
    throw new AppError('VALIDATION', `浏览器用户脚本索引字段 ${field} 无效。`)
  }
  return value
}

function requireStoredPatterns(value: unknown, field: string, optional: boolean): LooseOptional<string[]> {
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

function requireStoredLastRun(value: unknown): LooseOptional<BrowserUserScriptLastRun> {
  if (!isPresent(value)) return undefined
  if (!isObject(value)) {
    throw new AppError('VALIDATION', '浏览器用户脚本索引字段 lastRun 无效。')
  }
  const stored = value as Record<string, unknown>
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

function requireStoredScript(value: unknown): BrowserUserScriptRecord {
  if (!isObject(value)) {
    throw new AppError('VALIDATION', '浏览器用户脚本索引包含无效记录。')
  }
  const stored = value as Record<string, unknown>
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

class BrowserUserScriptManager {
  constructor(private readonly access: BrowserUserScriptAccess) {}

  public async getOverview(context: BrowserSiteContext): Promise<BrowserUserScriptOverview> {
    const store = await this.loadStore()
    return {
      browserContext: context,
      globalEnabled: store.globalEnabled,
      scripts: sortScripts(store.scripts),
      matchedScriptIds: sortScripts(store.scripts)
        .filter((script) => browserUserScriptMatchesUrl(script, context.url))
        .map((script) => script.id),
    }
  }

  public async readScript(context: BrowserSiteContext, id: string): Promise<{
    overview: BrowserUserScriptOverview
    script: BrowserUserScriptRecord
    code: string
  }> {
    const store = await this.loadStore()
    const script = this.requireScript(store, id)
    const code = await this.readCode(script)
    return {
      overview: {
        browserContext: context,
        globalEnabled: store.globalEnabled,
        scripts: sortScripts(store.scripts),
        matchedScriptIds: sortScripts(store.scripts)
          .filter((candidate) => browserUserScriptMatchesUrl(candidate, context.url))
          .map((candidate) => candidate.id),
      },
      script,
      code,
    }
  }

  public async createScript(
    context: BrowserSiteContext,
    draft: BrowserUserScriptDraft,
    defaults: { source: 'agent' | 'user' | 'user-import'; enabled: boolean }
  ) {
    const store = await this.loadStore()
    const now = Date.now()
    const name = normalizeName(draft.name)
    const id = createScriptId(name)
    const code = normalizeCode(draft.code)
    const match = normalizePatterns(draft.match, 'match')
    if (isEmpty(match)) throw new AppError('VALIDATION', '脚本至少需要一个 match 规则。')
    const script: BrowserUserScriptRecord = {
      id,
      name,
      description: normalizeDescription(draft.description),
      version: draft.version?.trim() || '1.0.0',
      revision: 1,
      position:
        store.scripts.reduce((maximum, candidate) => Math.max(maximum, candidate.position), -1) + 1,
      match,
      excludeMatch: optionalWhen(!!draft.excludeMatch, normalizePatterns(draft.excludeMatch, 'excludeMatch')),
      runAt: draft.runAt ?? 'document-end',
      world: draft.world ?? 'isolated',
      enabled: defaults.enabled,
      source: defaults.source,
      relativePath: scriptPath(id),
      createdAt: now,
      updatedAt: now,
    }
    await this.access.writeFile(script.relativePath, code, { overwrite: false })
    store.scripts.push(script)
    await this.saveStore(store)
    return { overview: await this.getOverview(context), script }
  }

  public async updateScript(
    context: BrowserSiteContext,
    id: string,
    patch: BrowserUserScriptPatch,
    options: { disableAfterExecutionChange?: boolean } = {}
  ) {
    const store = await this.loadStore()
    const script = this.requireScript(store, id)
    const codeChanged = isPresent(patch.code)
    if (codeChanged) await this.access.writeFile(script.relativePath, normalizeCode(patch.code!), { overwrite: true })
    if (isPresent(patch.name)) script.name = normalizeName(patch.name)
    if ('description' in patch) script.description = normalizeDescription(patch.description)
    if (isPresent(patch.match)) {
      const match = normalizePatterns(patch.match, 'match')
      if (isEmpty(match)) throw new AppError('VALIDATION', '脚本至少需要一个 match 规则。')
      script.match = match
    }
    if (isPresent(patch.excludeMatch)) script.excludeMatch = normalizePatterns(patch.excludeMatch, 'excludeMatch')
    if (isPresent(patch.runAt)) script.runAt = patch.runAt
    if (isPresent(patch.world)) script.world = patch.world
    const executionChanged = codeChanged || ['match', 'excludeMatch', 'runAt', 'world']
      .some((key) => Object.prototype.hasOwnProperty.call(patch, key))
    if (executionChanged) {
      script.revision += 1
      // Agent 工具入口会要求修改执行面后重新显式启用；UI 编辑入口可保留当前状态。
      if (options.disableAfterExecutionChange) script.enabled = false
      script.lastRun = undefined
    }
    if (isPresent(patch.version)) script.version = patch.version.trim() || script.version
    script.updatedAt = Date.now()
    await this.saveStore(store)
    return { overview: await this.getOverview(context), script, refreshRequired: executionChanged }
  }

  public async setScriptEnabled(context: BrowserSiteContext, id: string, enabled: boolean) {
    const store = await this.loadStore()
    const script = this.requireScript(store, id)
    script.enabled = enabled
    script.updatedAt = Date.now()
    await this.saveStore(store)
    return { overview: await this.getOverview(context), script, refreshRequired: true }
  }

  public async setGlobalEnabled(context: BrowserSiteContext, enabled: boolean) {
    const store = await this.loadStore()
    store.globalEnabled = enabled
    await this.saveStore(store)
    return { overview: await this.getOverview(context), refreshRequired: true }
  }

  public async moveScript(
    context: BrowserSiteContext,
    id: string,
    direction: 'up' | 'down'
  ) {
    const store = await this.loadStore()
    const ordered = sortScripts(store.scripts)
    const script = this.requireScript(store, id)
    const currentIndex = ordered.findIndex((candidate) => candidate.id === script.id)
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (targetIndex >= 0 && targetIndex < ordered.length) {
      const target = ordered[targetIndex]!
      ordered[targetIndex] = script
      ordered[currentIndex] = target
      ordered.forEach((candidate, index) => {
        candidate.position = index
      })
      script.updatedAt = Date.now()
      store.scripts = ordered
      await this.saveStore(store)
    }
    return { overview: await this.getOverview(context), script }
  }

  public async deleteScript(context: BrowserSiteContext, id: string) {
    const store = await this.loadStore()
    const script = this.requireScript(store, id)
    await this.access.deleteFile(script.relativePath)
    store.scripts = store.scripts.filter((candidate) => candidate.id !== script.id)
    await this.saveStore(store)
    return { overview: await this.getOverview(context), script, refreshRequired: true }
  }

  public async listRunnable(url: string): Promise<Array<{ script: BrowserUserScriptRecord; code: string }>> {
    const store = await this.loadStore()
    if (!store.globalEnabled) return []
    const matching = sortScripts(store.scripts).filter(
      (script) => script.enabled && browserUserScriptMatchesUrl(script, url)
    )
    const results = await Promise.all(matching.map(async (script) => ({
      script,
      code: await this.readCode(script),
    })))
    return results
  }

  public async recordRun(id: string, run: BrowserUserScriptLastRun): Promise<void> {
    const store = await this.loadStore()
    const script = this.requireScript(store, id)
    script.lastRun = run
    await this.saveStore(store)
  }

  private requireScript(store: BrowserUserScriptStore, id: string): BrowserUserScriptRecord {
    const normalized = assertScriptId(id)
    const script = store.scripts.find((candidate) => candidate.id === normalized)
    if (!script) throw new AppError('NOT_FOUND', '找不到用户脚本。', undefined, { id: normalized })
    return script
  }

  private async readCode(script: BrowserUserScriptRecord): Promise<string> {
    const result = await this.access.readFile(
      script.relativePath,
      1,
      undefined,
      MaxUserScriptBytes + 1
    )
    if (result.truncated || Buffer.byteLength(result.content, 'utf8') > MaxUserScriptBytes) {
      throw new AppError('VALIDATION', '用户脚本文件超过 1 MB，已拒绝执行。', undefined, {
        scriptId: script.id,
      })
    }
    return result.content
  }

  private async loadStore(): Promise<BrowserUserScriptStore> {
    try {
      const result = await this.access.readFile(BrowserUserScriptIndexPath, 1, undefined, 2_000_000)
      const parsed = JSON.parse(result.content) as {
        version?: number
        globalEnabled?: boolean
        scripts?: unknown
      }
      if (parsed.version !== BrowserUserScriptStoreVersion || !isArray(parsed.scripts)) {
        throw new AppError('VALIDATION', '浏览器用户脚本索引版本无效。')
      }
      if (!isBoolean(parsed.globalEnabled)) {
        throw new AppError('VALIDATION', '浏览器用户脚本索引字段 globalEnabled 无效。')
      }
      const scripts = parsed.scripts.map(requireStoredScript)
      return {
        version: BrowserUserScriptStoreVersion,
        globalEnabled: parsed.globalEnabled,
        scripts: sortScripts(scripts),
      }
    } catch (error) {
      if (AppError.from(error).code !== 'NOT_FOUND') throw error
      return { version: BrowserUserScriptStoreVersion, globalEnabled: true, scripts: [] }
    }
  }

  private async saveStore(store: BrowserUserScriptStore): Promise<void> {
    await this.access.writeFile(BrowserUserScriptIndexPath, `${stringifyPretty(store)}\n`, {
      overwrite: true,
    })
  }
}

export {
  type BrowserUserScriptAccess,
  BrowserUserScriptIndexPath,
  BrowserUserScriptManager,
  BrowserUserScriptStoreVersion,
}
