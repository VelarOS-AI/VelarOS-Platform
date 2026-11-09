import {
  isArray,
  isBoolean,
  isEmpty,
  isNotNull,
  isPresent,
  Log,
  optionalWhen,
  stringifyPretty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserUserScriptLimits } from '../../contract/constants'
import type {
  BrowserSiteContext,
  BrowserUserScriptDraft,
  BrowserUserScriptLastRun,
  BrowserUserScriptOverview,
  BrowserUserScriptPatch,
  BrowserUserScriptRecord,
} from '../../types/browser.js'
import type { BrowserUserScriptAccess, BrowserUserScriptStore } from '../../types/workspace.js'
import {
  browserUserScriptMatchesUrl,
  buildUserScriptOverview,
  createScriptId,
  normalizeCode,
  normalizeDescription,
  normalizeName,
  normalizePatterns,
  scriptPath,
  sortScripts,
  validateUserScriptPatch,
} from '../../utils/user-scripts'
import { requireScript, requireStoredScript } from '../../utils/user-scripts.js'

import { browserUserScriptIndexQueue } from './BrowserUserScriptIndexQueue'

const log = Log.tag('BrowserUserScriptManager')

/**
 * 站点用户脚本的存储：索引与代码都落在站点工作区里，负责增删改查、启停、排序与执行记录。
 *
 * 安全语义写在这里：agent 建的脚本一律先停用；执行面更新成功后是否保持停用由宿主策略决定，启用需宿主授权；
 * 所有校验与可靠旧内容读取都在写盘之前完成。已启用脚本更新执行面先持久停用，后续失败不恢复启用。
 *
 * 实例归运行时：无会话状态，一份就够；站点由每次调用传进来的上下文决定。
 */
export interface BrowserUserScriptManagerApi {
  /** 一条脚本在这个地址上该不该跑：`@match` 先过、`@exclude` 一票否决；与注入时用的是同一份判据。 */
  matchesUrl(script: BrowserUserScriptRecord, url: string): boolean
  /** 读这个站点的用户脚本总览：全局开关与每个脚本的状态。 */
  getOverview(context: BrowserSiteContext): Promise<BrowserUserScriptOverview>
  /** 读一个用户脚本的代码与元信息。 */
  readScript(
    context: BrowserSiteContext,
    id: string
  ): Promise<{
    overview: BrowserUserScriptOverview
    script: BrowserUserScriptRecord
    code: string
  }>
  /** 新建一个用户脚本；agent 建的一律先停用，要用户确认后才启用。 */
  createScript(
    context: BrowserSiteContext,
    draft: BrowserUserScriptDraft,
    defaults: { source: 'agent' | 'user' | 'user-import'; enabled: boolean }
  ): Promise<{ overview: BrowserUserScriptOverview; script: BrowserUserScriptRecord }>
  /**
   * 修改用户脚本：先校验和读取可靠旧内容；已启用脚本的执行面确有变化时先持久停用，
   * 再写代码与新索引。停用落盘失败就终止；之后的失败可能使脚本保持停用。
   * 原错误向外抛，代码回滚或安全索引恢复失败另留诊断，不将失败伪装成完整回滚。
   */
  updateScript(
    context: BrowserSiteContext,
    id: string,
    patch: BrowserUserScriptPatch,
    options: { disableAfterExecutionChange?: boolean }
  ): Promise<{
    overview: BrowserUserScriptOverview
    script: BrowserUserScriptRecord
    refreshRequired: boolean
  }>
  /** 启用或停用一个用户脚本。 */
  setScriptEnabled(
    context: BrowserSiteContext,
    id: string,
    enabled: boolean
  ): Promise<{
    overview: BrowserUserScriptOverview
    script: BrowserUserScriptRecord
    refreshRequired: boolean
  }>
  /** 打开或关掉这个站点的用户脚本总开关。 */
  setGlobalEnabled(
    context: BrowserSiteContext,
    enabled: boolean
  ): Promise<{ overview: BrowserUserScriptOverview; refreshRequired: boolean }>
  /** 调整一个用户脚本的注入顺序。 */
  moveScript(
    context: BrowserSiteContext,
    id: string,
    direction: 'up' | 'down'
  ): Promise<{ overview: BrowserUserScriptOverview; script: BrowserUserScriptRecord }>
  /** 删掉一个用户脚本，连同它的代码文件。 */
  deleteScript(
    context: BrowserSiteContext,
    id: string
  ): Promise<{
    overview: BrowserUserScriptOverview
    script: BrowserUserScriptRecord
    refreshRequired: boolean
  }>
  /** 按 URL 挑出这一页该注入的脚本，连同代码一起给出。 */
  listRunnable(url: string): Promise<Array<{ script: BrowserUserScriptRecord; code: string }>>
  /** 记一次脚本执行的结果，供总览里显示「上次跑得怎么样」。 */
  recordRun(id: string, run: BrowserUserScriptLastRun): Promise<void>
}

class BrowserUserScriptManager implements BrowserUserScriptManagerApi {
  public matchesUrl(script: BrowserUserScriptRecord, url: string): boolean {
    return browserUserScriptMatchesUrl(script, url)
  }

  private static readonly BrowserUserScriptIndexPath = 'scripts/index.json'
  private static readonly BrowserUserScriptStoreVersion = 1 as const

  constructor(private readonly access: BrowserUserScriptAccess) {}

  public async getOverview(context: BrowserSiteContext): Promise<BrowserUserScriptOverview> {
    return browserUserScriptIndexQueue.run(async () =>
      buildUserScriptOverview(context, await this.loadStore())
    )
  }

  public async readScript(
    context: BrowserSiteContext,
    id: string
  ): Promise<{
    overview: BrowserUserScriptOverview
    script: BrowserUserScriptRecord
    code: string
  }> {
    return browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      const script = requireScript(store, id)
      return {
        overview: buildUserScriptOverview(context, store),
        script,
        code: await this.readCode(script),
      }
    })
  }

  public async createScript(
    context: BrowserSiteContext,
    draft: BrowserUserScriptDraft,
    defaults: { source: 'agent' | 'user' | 'user-import'; enabled: boolean }
  ) {
    return browserUserScriptIndexQueue.run(async () => {
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
          store.scripts.reduce((maximum, candidate) => Math.max(maximum, candidate.position), -1) +
          1,
        match,
        excludeMatch: optionalWhen(
          !!draft.excludeMatch,
          normalizePatterns(draft.excludeMatch, 'excludeMatch')
        ),
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
      return { overview: buildUserScriptOverview(context, store), script }
    })
  }

  /** 见公开接口：预停用是安全写入，不与原启用状态一起回滚。 */
  public async updateScript(
    context: BrowserSiteContext,
    id: string,
    patch: BrowserUserScriptPatch,
    options: { disableAfterExecutionChange?: boolean } = {}
  ) {
    return browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      const script = requireScript(store, id)
      const validated = validateUserScriptPatch(patch)
      const scopeChanged =
        (isNotNull(validated.match) &&
          JSON.stringify(validated.match) !== JSON.stringify(script.match)) ||
        (isNotNull(validated.excludeMatch) &&
          JSON.stringify(validated.excludeMatch) !== JSON.stringify(script.excludeMatch ?? [])) ||
        (isPresent(patch.runAt) && patch.runAt !== script.runAt) ||
        (isPresent(patch.world) && patch.world !== script.world)
      const previousCode =
        isNotNull(validated.code) || (script.enabled && scopeChanged)
          ? await this.readCode(script)
          : null
      const codeChanged = isNotNull(validated.code) && validated.code !== previousCode
      const executionChanged = codeChanged || scopeChanged
      const previousScript = { ...script }
      const predisabled = script.enabled && executionChanged
      if (predisabled) {
        script.enabled = false
        await this.saveStore(store)
      }
      let codeWriteStarted = false
      try {
        if (codeChanged && isNotNull(validated.code)) {
          codeWriteStarted = true
          await this.access.writeFile(script.relativePath, validated.code, { overwrite: true })
        }
        if (isNotNull(validated.name)) script.name = validated.name
        if (isNotNull(validated.description)) script.description = validated.description.value
        if (isNotNull(validated.match)) script.match = validated.match
        if (isNotNull(validated.excludeMatch)) script.excludeMatch = validated.excludeMatch
        if (isPresent(patch.runAt)) script.runAt = patch.runAt
        if (isPresent(patch.world)) script.world = patch.world
        if (executionChanged) {
          script.revision += 1
          script.lastRun = undefined
        }
        script.enabled =
          previousScript.enabled && !(executionChanged && options.disableAfterExecutionChange)
        if (isNotNull(validated.version)) script.version = validated.version
        script.updatedAt = Date.now()
        await this.saveStore(store)
      } catch (error) {
        Object.assign(script, previousScript)
        if (predisabled) {
          script.enabled = false
          try {
            await this.saveStore(store)
          } catch (safeIndexError) {
            log.error('用户脚本更新失败后未能确认停用索引，须人工核对', {
              scriptId: script.id,
              error: String(safeIndexError),
            })
          }
        }
        if (codeWriteStarted) await this.restoreCodeAfterFailedUpdate(script, previousCode)
        throw error
      }

      return {
        overview: buildUserScriptOverview(context, store),
        script,
        refreshRequired: executionChanged,
      }
    })
  }

  public async setScriptEnabled(context: BrowserSiteContext, id: string, enabled: boolean) {
    return browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      const script = requireScript(store, id)
      script.enabled = enabled
      script.updatedAt = Date.now()
      await this.saveStore(store)
      return { overview: buildUserScriptOverview(context, store), script, refreshRequired: true }
    })
  }

  public async setGlobalEnabled(context: BrowserSiteContext, enabled: boolean) {
    return browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      store.globalEnabled = enabled
      await this.saveStore(store)
      return { overview: buildUserScriptOverview(context, store), refreshRequired: true }
    })
  }

  public async moveScript(context: BrowserSiteContext, id: string, direction: 'up' | 'down') {
    return browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      const ordered = sortScripts(store.scripts)
      const script = requireScript(store, id)
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
      return { overview: buildUserScriptOverview(context, store), script }
    })
  }

  public async deleteScript(context: BrowserSiteContext, id: string) {
    return browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      const script = requireScript(store, id)
      await this.access.deleteFile(script.relativePath)
      store.scripts = store.scripts.filter((candidate) => candidate.id !== script.id)
      await this.saveStore(store)
      return { overview: buildUserScriptOverview(context, store), script, refreshRequired: true }
    })
  }

  public async listRunnable(
    url: string
  ): Promise<Array<{ script: BrowserUserScriptRecord; code: string }>> {
    return browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      if (!store.globalEnabled) return []
      const matching = sortScripts(store.scripts).filter(
        (script) => script.enabled && browserUserScriptMatchesUrl(script, url)
      )
      return Promise.all(
        matching.map(async (script) => ({
          script,
          code: await this.readCode(script),
        }))
      )
    })
  }

  public async recordRun(id: string, run: BrowserUserScriptLastRun): Promise<void> {
    await browserUserScriptIndexQueue.run(async () => {
      const store = await this.loadStore()
      const script = requireScript(store, id)
      script.lastRun = run
      await this.saveStore(store)
    })
  }

  /** 更新失败后尝试恢复旧代码；回滚失败保留诊断，不掩盖原错误或恢复启用。 */
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

  private async readCode(script: BrowserUserScriptRecord): Promise<string> {
    const result = await this.access.readFile(
      script.relativePath,
      1,
      undefined,
      BrowserUserScriptLimits.codeBytes + 1
    )
    if (
      result.truncated ||
      Buffer.byteLength(result.content, 'utf8') > BrowserUserScriptLimits.codeBytes
    ) {
      throw new AppError('VALIDATION', '用户脚本文件超过 1 MB，已拒绝执行。', undefined, {
        scriptId: script.id,
      })
    }
    return result.content
  }

  private async loadStore(): Promise<BrowserUserScriptStore> {
    try {
      const result = await this.access.readFile(
        BrowserUserScriptManager.BrowserUserScriptIndexPath,
        1,
        undefined,
        2_000_000
      )
      const parsed = JSON.parse(result.content) as {
        version?: number
        globalEnabled?: boolean
        scripts?: unknown
      }
      if (
        parsed.version !== BrowserUserScriptManager.BrowserUserScriptStoreVersion ||
        !isArray(parsed.scripts)
      ) {
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
      return {
        version: BrowserUserScriptManager.BrowserUserScriptStoreVersion,
        globalEnabled: true,
        scripts: [],
      }
    }
  }

  private async saveStore(store: BrowserUserScriptStore): Promise<void> {
    await this.access.writeFile(
      BrowserUserScriptManager.BrowserUserScriptIndexPath,
      `${stringifyPretty(store)}\n`,
      {
        overwrite: true,
      }
    )
  }
}

/** 按一个站点工作区的读写口建用户脚本仓库；索引文件与匹配规则只有这一份。 */
function createBrowserUserScriptStore(
  access: BrowserUserScriptAccess
): BrowserUserScriptManagerApi {
  return new BrowserUserScriptManager(access)
}

export { BrowserUserScriptManager, createBrowserUserScriptStore }
export type { BrowserUserScriptAccess } from '../../types/workspace.js'
