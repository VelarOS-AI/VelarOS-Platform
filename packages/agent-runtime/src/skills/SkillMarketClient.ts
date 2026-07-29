import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import type { SkillMarketCatalog, SkillMarketEntry } from '@velaros-ai/core/types'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { SkillFileStore } from './SkillFileStore'

/**
 * 远端 manifest 条目：
 * `{ skills: [{ id, name, description, version, file, sha256? }] }`
 * 由 scripts/build/packageSkillMarket.mjs 生成，托管在 market base 下。
 */
interface RemoteSkillEntry {
  id: string
  name: string
  description: string
  version: string
  file: string
  sha256?: string
}

interface SkillMarketClientDependencies {
  store: SkillFileStore
  /**
   * 宿主提供的市场根地址。未注入或返回空值时，市场保持禁用且网络请求不会发生。
   */
  marketBase?: () => string
  fetchImpl?: typeof fetch
  now?: () => number
}

type SkillMarketAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reason: 'endpoint-not-configured' }>

/**
 * 技能市场客户端：拉 skills-manifest.json，合成本地安装状态；
 * install(id) 下载单个 md（可选 sha256 校验）后写入 SkillFileStore。
 */
class SkillMarketClient {
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

  public async install(id: string): Promise<void> {
    this.installStates.set(id, { phase: 'installing' })
    this.notify()
    try {
      const entry = (await this.fetchManifest()).find((candidate) => candidate.id === id)
      if (!entry) {
        throw new AppError('VALIDATION', 'skill-market-entry-missing')
      }

      const content = await this.readTextResource(new URL(entry.file, this.normalizedBase()))
      if (entry.sha256) {
        const actual = createHash('sha256').update(content, 'utf8').digest('hex')
        if (actual !== entry.sha256.trim().toLowerCase()) {
          throw new AppError('VALIDATION', 'skill-checksum-mismatch')
        }
      }

      this.store.saveContent(content, { id: entry.id })
      this.installStates.delete(id)
      this.notify()
    } catch (error) {
      const reason = error instanceof AppError ? error.message : 'skill-install-failed'
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
        'skill-market-disabled',
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
        'skill-market-endpoint-invalid',
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
      throw new AppError('VALIDATION', 'skill-manifest-invalid')
    }

    const skills = asRecord(parsed)?.skills
    if (!Array.isArray(skills)) {
      throw new AppError('VALIDATION', 'skill-manifest-invalid')
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
        throw new AppError('VALIDATION', 'skill-market-unavailable')
      }
    }

    const response = await this.fetchImpl(url).catch(() => null)
    if (!response?.ok) {
      throw new AppError('VALIDATION', 'skill-market-unavailable')
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

export {
  type SkillMarketAvailability,
  SkillMarketClient,
  type SkillMarketClientDependencies,
}
