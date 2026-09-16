import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { isArray } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { SkillMarketCatalog, SkillMarketEntry } from '../../types/agent.js'
import type { RemoteSkillEntry, SkillMarketAvailability } from '../../types/guidance.js'

import type { SkillFileStore } from './SkillFileStore'

interface SkillMarketClientDependencies {
  store: SkillFileStore
  /**
   * 宿主提供的市场根地址。未注入或返回空值时，市场保持禁用且网络请求不会发生。
   */
  marketBase?: () => string
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * 技能市场客户端对外的面：从宿主配的市场根拉 `skills-manifest.json`，和本地已安装技能对账，
 * 并把选中的技能下载、校验、写进 `SkillFileStore`。
 *
 * 宿主装配期建一个、长期持有；实例内只记各技能的安装进度（installing / failed）与变更订阅者，
 * 目录本身不缓存、每次现拉。宿主没配市场根时整个市场是禁用态，一次网络请求都不会发。
 * `install` 刻意不抛错：失败落进安装态并通知订阅者，调用方从订阅或目录里读结果。
 * 实现是 `SkillMarketClient`。
 */
export interface SkillMarketClientApi {
  /** 市场能不能用：宿主没配端点时返回不可用并带上 `endpoint-not-configured`，界面据此隐藏或禁用入口。 */
  getAvailability(): SkillMarketAvailability
  /** 订阅安装状态变化（installing / 成功清除 / failed），返回退订函数。回调抛错只记日志。 */
  subscribe(listener: () => void): () => void
  /**
   * 拉一份市场目录：远端 manifest 与本地已安装记录对账，逐条标上
   * `not-installed` / `installed` / `update-available`（本地有版本号且与远端不同即算可更新），
   * 正在安装或安装失败的条目再带上当前安装态。市场禁用或拉取失败时抛 `AppError`。
   */
  listCatalog(): Promise<SkillMarketCatalog>
  /**
   * 安装一条技能：拉 manifest 找到它 → 下载正文 → 声明了 sha256 就校验 → 写进本地技能仓库。
   * 全程刻意不抛：失败只把 `failed` 与原因记进安装态并通知订阅者，所以 `await` 正常返回
   * **不代表装上了**——要判成功看 `listCatalog()` 的 installState 或订阅推送。
   */
  install(id: string): Promise<void>
}

class SkillMarketClient implements SkillMarketClientApi {
  private readonly log = logRuntime.tag('SkillMarketClient')
  private readonly store: SkillFileStore
  private readonly marketBase?: () => string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly installStates = new Map<string, NonNullable<SkillMarketEntry['install']>>()
  private readonly listeners = new Set<() => void>()

  constructor(dependencies: SkillMarketClientDependencies) {
    this.store = dependencies.store
    this.marketBase = dependencies.marketBase
    this.fetchImpl = dependencies.fetchImpl ?? fetch
    this.now = dependencies.now ?? Date.now
  }

  /** 未配置端点时市场明确禁用；宿主可以据此隐藏或禁用市场入口。 */
  public getAvailability(): SkillMarketAvailability {
    return this.resolveMarketBase()
      ? { available: true }
      : { available: false, reason: 'endpoint-not-configured' }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 市场目录 = 远端 manifest × 本地安装状态（版本比较给出可更新标记）。 */
  public async listCatalog(): Promise<SkillMarketCatalog> {
    const remote = await this.fetchManifest()
    const installed = new Map(this.store.list().map((record) => [record.id, record]))

    return {
      generatedAt: this.now(),
      entries: remote.map((entry): SkillMarketEntry => {
        const local = installed.get(entry.id)
        const installState = !local
          ? 'not-installed'
          : local.version && local.version !== entry.version
            ? 'update-available'
            : 'installed'

        const result: SkillMarketEntry = {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          installState,
        }
        const install = this.installStates.get(entry.id)
        if (install) result.install = install
        return result
      }),
    }
  }

  /**
   * 安装单个技能：拉 manifest → 下载正文 →（有 sha256 就校验）→ 写入文件仓库。
   *
   * **刻意不抛**：失败落进 `installStates` 的 `failed` 相并 `notify()`，调用方从订阅里读结果。
   * 理由是安装是 UI 驱动的长动作，卡片要能显示 installing/failed 三态，而不是靠调用点 try/catch
   * 拼出同样的状态机。副作用是 `await install(id)` 正常返回**不代表装上了**——判断成功要看
   * `listCatalog()` 的 `installState` 或订阅推送，别把 resolve 当成功信号。
   */
  public async install(id: string): Promise<void> {
    this.installStates.set(id, { phase: 'installing' })
    this.notify()
    try {
      const entry = (await this.fetchManifest()).find((candidate) => candidate.id === id)
      if (!entry) {
        throw new AppError('VALIDATION', 'skill-market-entry-missing：市场清单里没有这个技能，它可能已经下架，或者本地清单是旧的，刷新后再装。')
      }

      const content = await this.readTextResource(new URL(entry.file, this.normalizedBase()))
      if (entry.sha256) {
        const actual = createHash('sha256').update(content, 'utf8').digest('hex')
        if (actual !== entry.sha256.trim().toLowerCase()) {
          throw new AppError('VALIDATION', 'skill-checksum-mismatch：下载到的技能正文与清单登记的 sha256 对不上，文件可能损坏或被改过，已放弃安装。')
        }
      }

      this.store.saveContent(content, { id: entry.id })
      this.installStates.delete(id)
      this.notify()
    } catch (error) {
      const reason = error instanceof AppError ? error.message : 'skill-install-failed：技能安装失败，原因未知。'
      this.log.warn('技能安装失败', { id, error })
      this.installStates.set(id, { phase: 'failed', error: reason })
      this.notify()
    }
  }

  private normalizedBase(): string {
    const base = this.resolveMarketBase()
    if (!base) {
      throw new AppError(
        'UNAVAILABLE',
        'skill-market-disabled：宿主没有配置技能市场地址，市场处于关闭状态，装不了远程技能。',
        undefined,
        { reason: 'endpoint-not-configured' }
      )
    }

    const normalized = base.endsWith('/') ? base : `${base}/`
    try {
      return new URL(normalized).toString()
    } catch (error) {
      throw new AppError(
        'VALIDATION',
        'skill-market-endpoint-invalid：宿主配置的技能市场地址不是合法 URL，解析失败。',
        error,
        { endpoint: base }
      )
    }
  }

  private resolveMarketBase(): string | undefined {
    return this.marketBase?.().trim() || undefined
  }

  private async fetchManifest(): Promise<RemoteSkillEntry[]> {
    const raw = await this.readTextResource(new URL('skills-manifest.json', this.normalizedBase()))
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AppError('VALIDATION', 'skill-manifest-invalid：skills-manifest.json 不是合法 JSON，解析失败。')
    }

    const skills = asRecord(parsed)?.skills
    if (!isArray(skills)) {
      throw new AppError('VALIDATION', 'skill-manifest-invalid：skills-manifest.json 里的 skills 不是数组，清单格式不对。')
    }

    return skills.flatMap((item): RemoteSkillEntry[] => {
      const record = asRecord(item)
      const id = readString(record, 'id')?.trim()
      const name = readString(record, 'name')?.trim()
      const file = readString(record, 'file')?.trim()
      if (!record || !id || !name || !file) return []
      return [
        {
          id,
          name,
          description: readString(record, 'description')?.trim() ?? '',
          version: readString(record, 'version')?.trim() || '0.0.0',
          file,
          sha256: readString(record, 'sha256')?.trim(),
        },
      ]
    })
  }

  private async readTextResource(url: URL): Promise<string> {
    if (url.protocol === 'file:') {
      try {
        return await readFile(fileURLToPath(url), 'utf8')
      } catch {
        throw new AppError('VALIDATION', 'skill-market-unavailable：本地技能市场文件读不出来，确认路径还在、且当前用户有读权限。')
      }
    }

    const response = await this.fetchImpl(url).catch(() => null)
    if (!response?.ok) {
      throw new AppError('VALIDATION', 'skill-market-unavailable：技能市场请求失败，网络不通或服务端返回了错误状态码。')
    }
    return response.text()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.log.warn('技能市场监听器异常', { error })
      }
    }
  }
}

export { SkillMarketClient, type SkillMarketClientDependencies }
