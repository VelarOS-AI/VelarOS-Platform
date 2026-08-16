import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

import { isArray, isBlank, isEmpty,isString, stringifyPretty, trimmedStringOrEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { compareStableStrings } from '../agent/context/residency/determinism'

/** 单个技能文件的解析结果（frontmatter + 正文）。 */
interface SkillFileRecord {
  /** slug = 文件名（不含 .md），也是全链路引用的 skill id。 */
  id: string
  name: string
  description: string
  version: Nullable<string>
  filePath: string
  updatedAt: number
  enabled: boolean
  /** 去掉 frontmatter 的正文。 */
  markdown: string
  /** 可见能力作用域（frontmatter `spaces: [scope-a, scope-b]`）；空 = 通用。 */
  spaces: string[]
  /** 索引排序优先级（frontmatter `priority: 60`）；越小越靠前，空用 provider 默认。 */
  priority: Nullable<number>
  /** 调用提示（frontmatter `argument-hint`）：告诉模型/用户这个技能期望怎样的输入。 */
  argumentHint: Nullable<string>
  /** 每技能工具门控（frontmatter `allowed-tools: [a, b]`）；空 = 不限制。 */
  allowedTools: string[]
  /** 目录式技能（<id>/SKILL.md）的根目录；平铺单文件为 null。 */
  baseDir: Nullable<string>
  /** 目录式技能的捆绑资源相对路径（不含 SKILL.md/隐藏文件；有限深度与数量）。 */
  resourcePaths: string[]
}

interface SkillFrontmatter {
  data: Record<string, string>
  body: string
}

interface SkillFileStoreDependencies {
  /** 技能目录解析器由宿主递入；桌面和 headless 宿主可使用各自的数据根。 */
  skillsDir: () => string
}

const DisabledSkillStateFileName = '.disabled-skills.json'
/** 目录式技能的入口文件名（<id>/SKILL.md）；扫描、指纹、资源枚举、解析、删除共用这一个字面量。 */
const SkillDirEntryFileName = 'SKILL.md'

/**
 * 解析 markdown 头部的 `---` frontmatter。
 * 只支持 `key: value` 字符串标量——技能元数据（name/description/version）足够。
 */
function parseFrontmatter(raw: string): SkillFrontmatter {
  const normalized = raw.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { data: {}, body: normalized }

  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: normalized }

  const data: Record<string, string> = {}
  for (const line of normalized.slice(3, end).split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key && value) data[key] = value
  }

  const bodyStart = normalized.indexOf('\n', end + 4)
  return { data, body: bodyStart < 0 ? '' : normalized.slice(bodyStart + 1) }
}

function formatSkillDisplayMarkdown(raw: string): string {
  return parseFrontmatter(raw).body.trimStart()
}

/** 解析 frontmatter 列表标量：支持 `[a, b, c]` 与裸逗号分隔两种写法。 */
function parseFrontmatterList(value: LooseOptional<string>): string[] {
  const trimmed = value?.trim()
  if (!trimmed) return []
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  return inner
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry.length > 0)
}

/** 枚举目录式技能的捆绑资源相对路径（深度≤3、上限 50，跳过隐藏文件与 SKILL.md）。 */
function listSkillDirResources(baseDir: string): string[] {
  const resources: string[] = []
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 3 || resources.length >= 50) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // arch-guard:silent-catch-ok 目录不可读（权限/竞态删除）只应让**这一层**缺席，不该让整棵
      // 资源枚举失败——技能目录是用户可随手改动的普通目录，一个坏子目录不配否决整个技能。
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || resources.length >= 50) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel, depth + 1)
      } else if (entry.isFile() && rel !== SkillDirEntryFileName) {
        resources.push(rel)
      }
    }
  }
  walk(baseDir, '', 1)
  return resources.sort()
}

/** 从名称派生文件 slug（中英文保留，其余折叠成 -）。 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * 文件式技能仓库：技能目录下的 markdown 即已安装技能。
 *
 * Claude Code 同款语义——**文件在即已安装，删除即卸载**；用户手动往目录里放文件同样生效。
 * 这条语义决定了本类没有"注册表"：磁盘就是唯一真相，任何"内存里记一份已安装清单"的改法
 * 都会与用户手改文件打架。
 *
 * ## 两种形态（每个入口都必须同时认）
 *  - 平铺 `<id>.md`：单文件技能，id = 文件名去扩展名；
 *  - 目录式 `<id>/SKILL.md` + 同目录捆绑资源：id = 目录名，资源走渐进披露第三层按需读。
 * 读/删/导出一律经 `resolveExistingPath` 解析，**不要各写一份路径拼接**——只认平铺的那种写法
 * 会让功能对目录式技能单方面失效且不报错（Q2c 修的就是这个：删除静默 no-op、导出报"不存在"）。
 *
 * ## 缓存与失效契约
 * `list()` 每次扫目录（目录小、同步 fs 足够），按 `path + mtime` 缓存解析结果。
 * `version()` 是给上层 `AgentSkillRepository` 判缓存失效的**内容指纹**，必须覆盖一切能改变
 * 技能集合的东西：文件增删、mtime/size 变化、目录式技能的**捆绑资源**变化、以及启停状态文件。
 * 漏掉任何一项的症状是"改了技能但要重启才生效"，且只在改那一类东西时才出现。
 * 启停状态刻意存成独立的状态文件而不是写进 frontmatter：停用是本机偏好，不该改用户的技能正文
 * （也就不会在用户用版本控制管理技能目录时制造无谓 diff）。
 *
 * ## 两条安全线
 *  - **id 一律过 `normalizeSkillId`（= `basename`）**：id 来自 IPC/模型，不收敛就能拼出
 *    `../../` 越出技能目录。所有落到路径拼接的 id 都必须先过它。
 *  - **写盘走临时文件 + rename**：`saveContent` 先写 `<path>.tmp-<ts>` 再原子改名，避免并发扫描
 *    读到半写文件（临时后缀不以 `.md` 结尾，因此也不会被 `scanFiles` 捡走）。
 *
 * ## 失败方向
 * 解析/扫描/资源读取的异常一律**降级成"这一项缺席"并留日志**，不向上抛：技能目录是用户可以
 * 随手编辑的普通目录，一个坏文件或一个不可读子目录不配让整条技能链路瘫痪。
 */
class SkillFileStore {
  private readonly log = logRuntime.tag('SkillFileStore')
  private readonly skillsDir: () => string
  private readonly parseCache = new Map<string, { mtimeMs: number; record: SkillFileRecord }>()
  private readonly listeners = new Set<() => void>()

  constructor(dependencies: SkillFileStoreDependencies) {
    this.skillsDir = dependencies.skillsDir
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public list(): SkillFileRecord[] {
    const records: SkillFileRecord[] = []
    for (const filePath of this.scanFiles()) {
      const record = this.parseFile(filePath)
      if (record) records.push(record)
    }
    return records.sort((left, right) => compareStableStrings(left.id, right.id))
  }

  /** 内容版本指纹：任何文件的增删或 mtime/大小变化都会改变。 */
  public version(): string {
    const fileVersion = this.scanFiles()
      .map((filePath) => {
        const stats = statSync(filePath, { throwIfNoEntry: false })
        // 目录式技能连同资源文件一起进指纹（资源增删改也应触发重载）。
        const resourceVersion =
          basename(filePath) === SkillDirEntryFileName
            ? listSkillDirResources(dirname(filePath))
                .map((rel) => {
                  const resourceStats = statSync(join(dirname(filePath), rel), {
                    throwIfNoEntry: false,
                  })
                  return `${rel}:${resourceStats?.mtimeMs ?? 0}`
                })
                .join(',')
            : ''
        return `${filePath}:${stats?.mtimeMs ?? 0}:${stats?.size ?? 0}:${resourceVersion}`
      })
      .join('|')
    const disabledStats = statSync(this.disabledStatePath(), { throwIfNoEntry: false })
    return [
      fileVersion,
      `disabled:${disabledStats?.mtimeMs ?? 0}:${disabledStats?.size ?? 0}`,
    ].join('|')
  }

  public isSkillEnabled(id: string): boolean {
    const normalizedId = this.normalizeSkillId(id)
    if (!normalizedId) return true
    return !this.readDisabledSkillIds().has(normalizedId)
  }

  public setSkillEnabled(id: string, enabled: boolean): void {
    const normalizedId = this.normalizeSkillId(id)
    if (!normalizedId) {
      throw new AppError('VALIDATION', '缺少技能 id。')
    }

    const disabledSkillIds = this.readDisabledSkillIds()
    const changed = enabled
      ? disabledSkillIds.delete(normalizedId)
      : !disabledSkillIds.has(normalizedId)
    if (!enabled) disabledSkillIds.add(normalizedId)
    if (!changed) return

    this.writeDisabledSkillIds(disabledSkillIds)
    this.parseCache.clear()
    this.notify()
  }

  /** 读取单个技能的原始文件内容（含 frontmatter），导出用。 */
  public readRaw(id: string): string {
    const filePath = this.resolveExistingPath(id)
    if (!filePath) {
      throw new AppError('VALIDATION', `技能不存在：${id}`)
    }
    return readFileSync(filePath, 'utf8')
  }

  public get(id: string): Nullable<SkillFileRecord> {
    const filePath = this.resolveExistingPath(id)
    return filePath ? this.parseFile(filePath) : null
  }

  /**
   * 从原始内容安装/覆盖技能。
   * frontmatter 必须有 name；id 未指定时从 name 派生 slug。
   */
  public saveContent(content: string, options: { id?: string } = {}): SkillFileRecord {
    const { data, body } = parseFrontmatter(content)
    const name = data.name?.trim()
    if (!name) {
      throw new AppError('VALIDATION', 'skill-frontmatter-name-missing')
    }
    if (isBlank(body)) {
      throw new AppError('VALIDATION', 'skill-body-empty')
    }

    const id = options.id?.trim() || slugify(name)
    if (!id) {
      throw new AppError('VALIDATION', 'skill-id-invalid')
    }

    const filePath = this.filePathOf(id)
    // 临时文件 + rename，避免半写状态被并发扫描读到。
    const stagingPath = `${filePath}.tmp-${Date.now()}`
    writeFileSync(stagingPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
    renameSync(stagingPath, filePath)
    this.notify()

    const record = this.parseFile(filePath)
    if (!record) {
      throw new AppError('INTERNAL', `技能写入后解析失败:${id}`)
    }
    return record
  }

  /** 导入本地 md 文件（复制进 skills 目录）。 */
  public importFile(sourcePath: string): SkillFileRecord {
    if (extname(sourcePath).toLowerCase() !== '.md') {
      throw new AppError('VALIDATION', 'skill-import-md-only')
    }

    let content: string
    try {
      content = readFileSync(sourcePath, 'utf8')
    } catch {
      throw new AppError('VALIDATION', 'skill-import-unreadable')
    }
    return this.saveContent(content)
  }

  /**
   * 卸载技能 = 删除其磁盘存在（"文件在即已安装"的对偶）。
   *
   * 目录式技能必须连目录一起删：捆绑资源属于这个技能，只删 SKILL.md 会留下一个半截目录，
   * 下次扫描把它当"无 SKILL.md 的普通目录"跳过——表现是列表里没了、磁盘上还在、再装同 id 时
   * 撞上旧资源。此前这里只认平铺路径，目录式技能删除是静默 no-op（列表刷新后原样还在）。
   */
  public remove(id: string): void {
    const filePath = this.resolveExistingPath(id)
    if (!filePath) return

    if (basename(filePath) === SkillDirEntryFileName) {
      rmSync(dirname(filePath), { force: true, recursive: true })
    } else {
      rmSync(filePath, { force: true })
    }
    this.parseCache.delete(filePath)
    const disabledSkillIds = this.readDisabledSkillIds()
    if (disabledSkillIds.delete(this.normalizeSkillId(id))) {
      this.writeDisabledSkillIds(disabledSkillIds)
    }
    this.notify()
  }

  /**
   * 一次性迁移：把旧配置式 skill 条目落成文件。
   * 用 marker 文件防止重复导入；已存在同名文件时跳过（用户文件优先）。
   */
  public migrateLegacyEntries(
    entries: ReadonlyArray<{ label?: unknown; description?: unknown; markdown?: unknown }>
  ): number {
    const markerPath = join(this.dir(), '.migrated-config-skills')
    if (existsSync(markerPath)) return 0

    let migrated = 0
    for (const entry of entries) {
      const label = trimmedStringOrEmpty(entry.label)
      const markdown = trimmedStringOrEmpty(entry.markdown)
      if (isBlank(label) || isBlank(markdown)) continue

      const id = slugify(label)
      if (!id || existsSync(this.filePathOf(id))) continue

      const description = trimmedStringOrEmpty(entry.description)
      const frontmatter = [
        '---',
        `name: ${label}`,
        ...(description ? [`description: ${description}`] : []),
        '---',
        '',
      ].join('\n')
      try {
        this.saveContent(`${frontmatter}${markdown}\n`, { id })
        migrated += 1
      } catch (error) {
        this.log.warn('迁移旧配置技能失败，跳过', { label, error })
      }
    }

    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8')
    if (migrated > 0) this.log.info('已迁移旧配置技能为文件', { migrated })
    return migrated
  }

  private dir(): string {
    const dir = this.skillsDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  private filePathOf(id: string): string {
    // 只允许纯 slug，防目录穿越。
    const safe = this.normalizeSkillId(id)
    return join(this.dir(), `${safe}.md`)
  }

  /**
   * id → 磁盘上真实存在的技能入口文件；两种形态都要认（平铺 `<id>.md` / 目录式 `<id>/SKILL.md`），
   * 平铺优先（与 scanFiles 的枚举序一致，同 id 双形态时读到同一份）。不存在返回 null。
   *
   * 读/删/导出必须共用这一个解析器：各写一份的代价是"某个入口只认平铺"，症状是功能对目录式技能
   * 单方面失效且不报错。
   */
  private resolveExistingPath(id: string): Nullable<string> {
    const flatPath = this.filePathOf(id)
    if (existsSync(flatPath)) return flatPath

    const dirStylePath = join(this.dir(), this.normalizeSkillId(id), SkillDirEntryFileName)
    return existsSync(dirStylePath) ? dirStylePath : null
  }

  private disabledStatePath(): string {
    return join(this.dir(), DisabledSkillStateFileName)
  }

  private normalizeSkillId(id: string): string {
    return basename(id.trim())
  }

  private readDisabledSkillIds(): Set<string> {
    const statePath = this.disabledStatePath()
    if (!existsSync(statePath)) return new Set()

    try {
      const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!isArray(parsed)) return new Set()
      return new Set(
        parsed
          .filter((entry): entry is string => isString(entry) && !isBlank(entry.trim()))
          .map((entry) => this.normalizeSkillId(entry))
          .filter((entry) => !isBlank(entry))
      )
    } catch (error) {
      this.log.warn('读取技能禁用状态失败，忽略该状态文件', { error })
      return new Set()
    }
  }

  private writeDisabledSkillIds(disabledSkillIds: ReadonlySet<string>): void {
    writeFileSync(
      this.disabledStatePath(),
      `${stringifyPretty([...disabledSkillIds].sort())}\n`,
      'utf8'
    )
  }

  private scanFiles(): string[] {
    try {
      const root = this.dir()
      const files: string[] = []
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(join(root, entry.name))
          continue
        }
        // 目录式技能：<id>/SKILL.md + 捆绑资源（Claude Code 同款渐进披露第三层）。
        if (entry.isDirectory()) {
          const skillFilePath = join(root, entry.name, SkillDirEntryFileName)
          if (existsSync(skillFilePath)) files.push(skillFilePath)
        }
      }
      return files
    } catch (error) {
      this.log.warn('扫描技能目录失败', { error })
      return []
    }
  }

  /** 读取目录式技能的捆绑资源；路径必须命中该技能已枚举的资源清单（天然防目录穿越）。 */
  public readSkillResource(id: string, resourcePath: string): Nullable<string> {
    const record = this.get(id)
    if (!record?.baseDir) return null
    const normalized = resourcePath.trim()
    if (!record.resourcePaths.includes(normalized)) return null
    try {
      return readFileSync(join(record.baseDir, normalized), 'utf8')
    } catch (error) {
      this.log.warn('读取技能资源失败', { id, resourcePath: normalized, error })
      return null
    }
  }

  private parseFile(filePath: string): Nullable<SkillFileRecord> {
    const stats = statSync(filePath, { throwIfNoEntry: false })
    if (!stats) return null

    const cached = this.parseCache.get(filePath)
    if (cached && cached.mtimeMs === stats.mtimeMs) return cached.record

    try {
      const { data, body } = parseFrontmatter(readFileSync(filePath, 'utf8'))
      const isDirStyle = basename(filePath) === SkillDirEntryFileName
      const baseDir = isDirStyle ? dirname(filePath) : null
      const id = isDirStyle ? basename(dirname(filePath)) : basename(filePath, '.md')
      const parsedPriority = Number.parseInt(data.priority ?? '', 10)
      const record: SkillFileRecord = {
        id,
        name: data.name?.trim() || id,
        description: data.description?.trim() ?? '',
        version: data.version?.trim() || null,
        filePath,
        updatedAt: Math.round(stats.mtimeMs),
        enabled: this.isSkillEnabled(id),
        markdown: body.trim(),
        spaces: parseFrontmatterList(data.spaces),
        priority: Number.isFinite(parsedPriority) ? parsedPriority : null,
        argumentHint: data['argument-hint']?.trim() || null,
        allowedTools: parseFrontmatterList(data['allowed-tools']),
        baseDir,
        resourcePaths: baseDir ? listSkillDirResources(baseDir) : [],
      }
      if (isEmpty(record.markdown)) return null

      this.parseCache.set(filePath, { mtimeMs: stats.mtimeMs, record })
      return record
    } catch (error) {
      this.log.warn('解析技能文件失败，忽略该文件', { filePath, error })
      return null
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.log.warn('技能变更监听器异常', { error })
      }
    }
  }
}

export { formatSkillDisplayMarkdown, listSkillDirResources, parseFrontmatter, parseFrontmatterList, type SkillFileRecord, SkillFileStore }
export type { SkillFileStoreDependencies }
