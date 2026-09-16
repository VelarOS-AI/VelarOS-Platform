import { randomUUID } from 'node:crypto'

import { isArray, isBoolean, isEmpty, isFiniteNumber, isNonBlankString, isNotNull, isPlainObject,isPresent, isString, Log, optionalWhen, stringifyPretty,toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserUserScriptLimits } from '../../contract/constants'
import type { BrowserSiteContext, BrowserUserScriptDraft, BrowserUserScriptLastRun, BrowserUserScriptOverview, BrowserUserScriptPatch, BrowserUserScriptRecord } from '../../types/browser.js'
import type { BrowserUserScriptAccess, BrowserUserScriptStore, BrowserUserScriptValidatedPatch } from '../../types/workspace.js'

const log = Log.tag('BrowserUserScriptManager')

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
  if (patterns.length > BrowserUserScriptLimits.matchRules) {
    throw new AppError('VALIDATION', `${field} 最多允许 ${BrowserUserScriptLimits.matchRules} 条规则。`)
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
  if (Buffer.byteLength(code, 'utf8') > BrowserUserScriptLimits.codeBytes) {
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

function requireStoredScript(value: unknown): BrowserUserScriptRecord {
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
function validateUserScriptPatch(patch: BrowserUserScriptPatch): BrowserUserScriptValidatedPatch {
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

/**
 * 站点用户脚本的存储：索引与代码都落在站点工作区里，负责增删改查、启停、排序与执行记录。
 *
 * 安全语义写在这里：agent 建的脚本一律先停用；改代码或改执行范围之后自动停用，必须用户重新确认才能再启用；
 * 所有校验都在写盘之前做完，校验失败不留半截（代码换了、索引没换）。
 *
 * 实例归运行时：无会话状态，一份就够；站点由每次调用传进来的上下文决定。
 */
export interface BrowserUserScriptManagerApi {
  /** 读这个站点的用户脚本总览：全局开关与每个脚本的状态。 */
  getOverview(context: BrowserSiteContext): Promise<BrowserUserScriptOverview>
  /** 读一个用户脚本的代码与元信息。 */
  readScript(context: BrowserSiteContext, id: string): Promise<{
    overview: BrowserUserScriptOverview
    script: BrowserUserScriptRecord
    code: string
  }>
  /** 新建一个用户脚本；agent 建的一律先停用，要用户确认后才启用。 */
  createScript(context: BrowserSiteContext, draft: BrowserUserScriptDraft, defaults: { source: 'agent' | 'user' | 'user-import'; enabled: boolean }): Promise<{ overview: BrowserUserScriptOverview; script: BrowserUserScriptRecord; }>
  /**
   * 修改用户脚本：**先把全部字段校验成最终值，再写代码，最后写索引**。
   *
   * 老写法把 `patch.code` 第一个写盘，之后才校验 name / match / excludeMatch：校验失败抛错时
   * 索引里的 revision、enabled 一个没动，磁盘上的代码却已经换成新的——已启用的脚本下次注入
   * 就跑这份没经用户确认的代码，绕开了「改代码或执行范围后自动停用、重新确认才能启用」。
   * 现在校验失败时盘上什么都没动；索引写失败时把代码回滚回去，不留半截状态。
   */
  updateScript(context: BrowserSiteContext, id: string, patch: BrowserUserScriptPatch, options: { disableAfterExecutionChange?: boolean }): Promise<{ overview: BrowserUserScriptOverview; script: BrowserUserScriptRecord; refreshRequired: boolean; }>
  /** 启用或停用一个用户脚本。 */
  setScriptEnabled(context: BrowserSiteContext, id: string, enabled: boolean): Promise<{ overview: BrowserUserScriptOverview; script: BrowserUserScriptRecord; refreshRequired: boolean; }>
  /** 打开或关掉这个站点的用户脚本总开关。 */
  setGlobalEnabled(context: BrowserSiteContext, enabled: boolean): Promise<{ overview: BrowserUserScriptOverview; refreshRequired: boolean; }>
  /** 调整一个用户脚本的注入顺序。 */
  moveScript(context: BrowserSiteContext, id: string, direction: 'up' | 'down'): Promise<{ overview: BrowserUserScriptOverview; script: BrowserUserScriptRecord; }>
  /** 删掉一个用户脚本，连同它的代码文件。 */
  deleteScript(context: BrowserSiteContext, id: string): Promise<{ overview: BrowserUserScriptOverview; script: BrowserUserScriptRecord; refreshRequired: boolean; }>
  /** 按 URL 挑出这一页该注入的脚本，连同代码一起给出。 */
  listRunnable(url: string): Promise<Array<{ script: BrowserUserScriptRecord; code: string }>>
  /** 记一次脚本执行的结果，供总览里显示「上次跑得怎么样」。 */
  recordRun(id: string, run: BrowserUserScriptLastRun): Promise<void>
}

class BrowserUserScriptManager implements BrowserUserScriptManagerApi {
  private static readonly BrowserUserScriptIndexPath = 'scripts/index.json'
  private static readonly BrowserUserScriptStoreVersion = 1 as const

  /**
   * 索引的读改写回串行化队列。
   *
   * 索引是「整份读出 → 改一个字段 → 整份写回」，界面与工具又各自 new 一个 manager
   * （宿主按请求建实例），锁只能挂在类上：两次修改交错时后写的那份会把先写的改动整份盖掉。
   * 变更都是小文件读写、跑得极快，全站点共用一条队列足够，也不会把任何长操作圈进来。
   */
  private static indexMutations: Promise<unknown> = Promise.resolve()

  /** 把一次「读索引 → 改 → 写回」放进队列，前一次结算后才开始。 */
  private static runIndexMutation<T>(mutate: () => Promise<T>): Promise<T> {
    const next = BrowserUserScriptManager.indexMutations.then(mutate, mutate)
    BrowserUserScriptManager.indexMutations = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

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
    return BrowserUserScriptManager.runIndexMutation(async () => {
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
      try {
        await this.saveStore(store)
      } catch (error) {
        // 索引没写成就把代码文件删掉：留在盘上的是一份没人认领的脚本。
        await this.deleteFileQuietly(script.relativePath)
        throw error
      }
      return { overview: await this.getOverview(context), script }
    })
  }

  /**
   * 修改用户脚本：**先把全部字段校验成最终值，再写代码，最后写索引**。
   *
   * 老写法把 `patch.code` 第一个写盘，之后才校验 name / match / excludeMatch：校验失败抛错时
   * 索引里的 revision、enabled 一个没动，磁盘上的代码却已经换成新的——已启用的脚本下次注入
   * 就跑这份没经用户确认的代码，绕开了「改代码或执行范围后自动停用、重新确认才能启用」。
   * 现在校验失败时盘上什么都没动；索引写失败时把代码回滚回去，不留半截状态。
   */
  public async updateScript(
    context: BrowserSiteContext,
    id: string,
    patch: BrowserUserScriptPatch,
    options: { disableAfterExecutionChange?: boolean } = {}
  ) {
    return BrowserUserScriptManager.runIndexMutation(async () => {
      const store = await this.loadStore()
      const script = this.requireScript(store, id)
      // ① 全部字段先校验成最终值：任何一条不合法都在这里抛错，此时盘上一个字节都没改。
      const validated = validateUserScriptPatch(patch)
      const previousCode = isNotNull(validated.code) ? await this.readCodeForRollback(script) : null

      // ② 代码文件。
      if (isNotNull(validated.code)) {
        await this.access.writeFile(script.relativePath, validated.code, { overwrite: true })
      }

      // ③ 索引：执行面（代码、match、excludeMatch、runAt、world）变了就换代并按宿主策略停用。
      const executionChanged = isNotNull(validated.code) || ['match', 'excludeMatch', 'runAt', 'world']
        .some((key) => Object.prototype.hasOwnProperty.call(patch, key))
      if (isNotNull(validated.name)) script.name = validated.name
      if (isNotNull(validated.description)) script.description = validated.description.value
      if (isNotNull(validated.match)) script.match = validated.match
      if (isNotNull(validated.excludeMatch)) script.excludeMatch = validated.excludeMatch
      if (isPresent(patch.runAt)) script.runAt = patch.runAt
      if (isPresent(patch.world)) script.world = patch.world
      if (executionChanged) {
        script.revision += 1
        // Agent 工具入口会要求修改执行面后重新显式启用；UI 编辑入口可保留当前状态。
        if (options.disableAfterExecutionChange) script.enabled = false
        script.lastRun = undefined
      }
      if (isNotNull(validated.version)) script.version = validated.version
      script.updatedAt = Date.now()

      try {
        await this.saveStore(store)
      } catch (error) {
        await this.restoreCodeAfterFailedUpdate(script, previousCode)
        throw error
      }

      return { overview: await this.getOverview(context), script, refreshRequired: executionChanged }
    })
  }

  public async setScriptEnabled(context: BrowserSiteContext, id: string, enabled: boolean) {
    return BrowserUserScriptManager.runIndexMutation(async () => {
      const store = await this.loadStore()
      const script = this.requireScript(store, id)
      script.enabled = enabled
      script.updatedAt = Date.now()
      await this.saveStore(store)
      return { overview: await this.getOverview(context), script, refreshRequired: true }
    })
  }

  public async setGlobalEnabled(context: BrowserSiteContext, enabled: boolean) {
    return BrowserUserScriptManager.runIndexMutation(async () => {
      const store = await this.loadStore()
      store.globalEnabled = enabled
      await this.saveStore(store)
      return { overview: await this.getOverview(context), refreshRequired: true }
    })
  }

  public async moveScript(
    context: BrowserSiteContext,
    id: string,
    direction: 'up' | 'down'
  ) {
    return BrowserUserScriptManager.runIndexMutation(async () => {
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
    })
  }

  public async deleteScript(context: BrowserSiteContext, id: string) {
    return BrowserUserScriptManager.runIndexMutation(async () => {
      const store = await this.loadStore()
      const script = this.requireScript(store, id)
      await this.access.deleteFile(script.relativePath)
      store.scripts = store.scripts.filter((candidate) => candidate.id !== script.id)
      await this.saveStore(store)
      return { overview: await this.getOverview(context), script, refreshRequired: true }
    })
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
    await BrowserUserScriptManager.runIndexMutation(async () => {
      const store = await this.loadStore()
      const script = this.requireScript(store, id)
      script.lastRun = run
      await this.saveStore(store)
    })
  }

  /** 读一份用于回滚的旧代码；读不到（文件缺失、超限）就返回 null，不因此挡下这次修改。 */
  private async readCodeForRollback(script: BrowserUserScriptRecord): Promise<Nullable<string>> {
    try {
      return await this.readCode(script)
    } catch (error) {
      log.debug('读取用户脚本旧代码失败，本次修改失败时无法回滚代码', {
        scriptId: script.id,
        error: String(error),
      })
      return null
    }
  }

  /** 索引写失败后的代码回滚：把改之前的代码写回去，别留「新代码 + 旧索引」的半截状态。 */
  private async restoreCodeAfterFailedUpdate(
    script: BrowserUserScriptRecord,
    previousCode: Nullable<string>
  ): Promise<void> {
    if (!isNotNull(previousCode)) return

    try {
      await this.access.writeFile(script.relativePath, previousCode, { overwrite: true })
    } catch (error) {
      log.error('用户脚本索引写入失败后回滚代码也失败，脚本代码可能已换成未确认的新版本', {
        scriptId: script.id,
        error: String(error),
      })
    }
  }

  /** 删除文件的静默版本：用于失败回滚，删不掉只记一笔，不掩盖真正的失败原因。 */
  private async deleteFileQuietly(relativePath: string): Promise<void> {
    try {
      await this.access.deleteFile(relativePath)
    } catch (error) {
      log.debug('回滚删除用户脚本文件失败', { relativePath, error: String(error) })
    }
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
      BrowserUserScriptLimits.codeBytes + 1
    )
    if (result.truncated || Buffer.byteLength(result.content, 'utf8') > BrowserUserScriptLimits.codeBytes) {
      throw new AppError('VALIDATION', '用户脚本文件超过 1 MB，已拒绝执行。', undefined, {
        scriptId: script.id,
      })
    }
    return result.content
  }

  private async loadStore(): Promise<BrowserUserScriptStore> {
    try {
      const result = await this.access.readFile(BrowserUserScriptManager.BrowserUserScriptIndexPath, 1, undefined, 2_000_000)
      const parsed = JSON.parse(result.content) as {
        version?: number
        globalEnabled?: boolean
        scripts?: unknown
      }
      if (parsed.version !== BrowserUserScriptManager.BrowserUserScriptStoreVersion || !isArray(parsed.scripts)) {
        throw new AppError('VALIDATION', '浏览器用户脚本索引版本无效。')
      }
      if (!isBoolean(parsed.globalEnabled)) {
        throw new AppError('VALIDATION', '浏览器用户脚本索引字段 globalEnabled 无效。')
      }
      const scripts = parsed.scripts.map(requireStoredScript)
      return {
        version: BrowserUserScriptManager.BrowserUserScriptStoreVersion,
        globalEnabled: parsed.globalEnabled,
        scripts: sortScripts(scripts),
      }
    } catch (error) {
      if (AppError.from(error).code !== 'NOT_FOUND') throw error
      return { version: BrowserUserScriptManager.BrowserUserScriptStoreVersion, globalEnabled: true, scripts: [] }
    }
  }

  private async saveStore(store: BrowserUserScriptStore): Promise<void> {
    await this.access.writeFile(BrowserUserScriptManager.BrowserUserScriptIndexPath, `${stringifyPretty(store)}\n`, {
      overwrite: true,
    })
  }
}

export { BrowserUserScriptManager }
export type { BrowserUserScriptAccess } from '../../types/workspace.js'
