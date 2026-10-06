import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { isEmpty, isObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'
import { createKeyedSerialQueue } from '@velaros-ai/core/utils/KeyedSerialQueue'
import type { NodeRuntimeEnvironment, NodeRuntimePackage } from '@velaros-ai/script'

import type { SkillEnvironmentLease } from '../contract/provides.js'
import type { SkillRegistryOptions } from '../contract/requires.js'
import type { SkillIndex, SkillInstallRequest, SkillRecord } from '../types/skills.js'
import {
  checkSkillGrants,
  freezeSkillData,
  parseSkillIndex,
  parseSkillLease,
  parseSkillReceipt,
} from '../utils/manifest.js'
import { skillInventory } from '../utils/package-io.js'

import { SkillPackageFiles } from './SkillPackageFiles.js'

/** Skill 安装、授权和不可变环境的唯一所有者。 */
export interface SkillRegistryApi {
  /** 读取当前持久索引，包括停用的 Skill。 */
  list(): Promise<readonly SkillRecord[]>
  /** 完成依赖准备与内容验证后原子发布新安装版本。 */
  install(request: SkillInstallRequest, signal: AbortSignal): Promise<SkillRecord>
  /** 原子调整启用状态和宿主能力授权。 */
  configure(
    name: string,
    configuration: { enabled: boolean; grants: readonly string[] }
  ): Promise<SkillRecord>
  /** 从后续环境移除 Skill，已有执行文件由租约保护。 */
  remove(name: string): Promise<void>
  /** 验证内容并固定当前启用的 Skill，返回会话持有的租约。 */
  acquire(names?: readonly string[]): Promise<SkillEnvironmentLease>
  /** 每次宿主调用重新检查当前安装代次、启用状态与授权。 */
  assertGranted(name: string, generation: string, module: string): Promise<void>
  /** 回收未安装且没有活跃租约使用的版本和环境。 */
  collect(): Promise<readonly string[]>
}

/** 每次修改从磁盘重读索引；下载发生在暂存目录，发布和切换由同一把锁保护。 */
class SkillRegistry implements SkillRegistryApi {
  private readonly files = new SkillPackageFiles()
  private readonly queue = createKeyedSerialQueue()
  private readonly root: string

  public constructor(private readonly options: SkillRegistryOptions) {
    if (!isAbsolute(options.directory)) throw new AppError('VALIDATION', 'Skill 存储需要绝对目录')
    this.root = resolve(options.directory)
  }

  public async list(): Promise<readonly SkillRecord[]> {
    return (await this.readIndex()).skills
  }

  public async install(request: SkillInstallRequest, signal: AbortSignal): Promise<SkillRecord> {
    signal.throwIfAborted()
    const generation = randomUUID()
    const staging = join(this.root, 'staging', generation)
    const final = join(this.root, 'packages', generation)
    let published = false
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      const directory = join(staging, 'package')
      await this.files.copy(request.directory, directory, signal)
      const manifest = await this.files.manifest(directory, this.options.nodeVersion)
      const grants = request.grants ?? []
      checkSkillGrants(manifest, grants)
      if (!isEmpty(Object.keys(manifest.dependencies)))
        await this.options.installer.install(
          directory,
          Boolean(request.allowDependencyScripts),
          signal
        )
      signal.throwIfAborted()
      if (
        JSON.stringify(await this.files.manifest(directory, this.options.nodeVersion)) !==
        JSON.stringify(manifest)
      )
        throw new AppError('CONFLICT', '安装过程修改了 Skill 贡献清单')
      for (const name of manifest.contribution.packages)
        await this.files.packagePath(directory, name)
      const receipt = await this.files.receipt(directory, manifest)
      signal.throwIfAborted()
      await writeFile(join(staging, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 })
      return await this.locked(async () => {
        signal.throwIfAborted()
        const index = await this.readIndex()
        const previous = index.skills.find((skill) => skill.manifest.name === manifest.name)
        const record: SkillRecord = {
          manifest,
          generation,
          directory: join(final, 'package'),
          enabled: request.enabled ?? previous?.enabled ?? true,
          grants: request.grants ?? [],
          installedAt: new Date().toISOString(),
        }
        const skills = [
          ...index.skills.filter((skill) => skill.manifest.name !== manifest.name),
          record,
        ]
        await mkdir(dirname(final), { recursive: true, mode: 0o700 })
        await rename(staging, final)
        try {
          await this.checkComposition(skills)
          await this.writeIndex({ version: 1, revision: index.revision + 1, skills })
          published = true
          return record
        } finally {
          if (!published) await rm(final, { recursive: true, force: true })
        }
      })
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true })
    }
  }

  public async configure(
    name: string,
    configuration: { enabled: boolean; grants: readonly string[] }
  ): Promise<SkillRecord> {
    return this.locked(async () => {
      const index = await this.readIndex()
      const current = index.skills.find((skill) => skill.manifest.name === name)
      if (!current) throw new AppError('NOT_FOUND', `Skill 未安装：${name}`)
      checkSkillGrants(current.manifest, configuration.grants)
      const record = {
        ...current,
        enabled: configuration.enabled,
        grants: [...configuration.grants],
      }
      const skills = index.skills.map((skill) => (skill.manifest.name === name ? record : skill))
      await this.checkComposition(skills)
      await this.writeIndex({ ...index, revision: index.revision + 1, skills })
      return record
    })
  }

  public async remove(name: string): Promise<void> {
    await this.locked(async () => {
      const index = await this.readIndex()
      if (!index.skills.some((skill) => skill.manifest.name === name))
        throw new AppError('NOT_FOUND', `Skill 未安装：${name}`)
      await this.writeIndex({
        ...index,
        revision: index.revision + 1,
        skills: index.skills.filter((skill) => skill.manifest.name !== name),
      })
    })
  }

  public async acquire(names?: readonly string[]): Promise<SkillEnvironmentLease> {
    return this.locked(async () => {
      const index = await this.readIndex()
      const skills = index.skills.filter(
        (skill) => skill.enabled && (!names || names.includes(skill.manifest.name))
      )
      if (names?.some((name) => !skills.some((skill) => skill.manifest.name === name)))
        throw new AppError('NOT_FOUND', '所选 Skill 未安装或未启用')
      for (const skill of skills) {
        const receipt = parseSkillReceipt(
          JSON.parse(await readFile(join(dirname(skill.directory), 'receipt.json'), 'utf8'))
        )
        if (JSON.stringify(receipt.manifest) !== JSON.stringify(skill.manifest))
          throw new AppError('CONFLICT', `Skill 清单与安装收据不符：${skill.manifest.name}`)
        await this.files.verify(skill.directory, receipt)
      }
      const exposed = await this.checkComposition(skills)
      const id = createHash('sha256')
        .update(
          JSON.stringify({
            packages: exposed,
            skills: skills.map((skill) => [skill.generation, skill.grants]),
          })
        )
        .digest('hex')
      const directory = join(this.root, 'environments', id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const packages: NodeRuntimePackage[] = []
      for (const pkg of exposed) {
        const target = join(directory, 'node_modules', pkg.name)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        try {
          await symlink(pkg.path, target, 'junction')
        } catch (error) {
          if (!isObject(error) || !('code' in error) || error.code !== 'EEXIST') throw error
          if ((await realpath(target)) !== (await realpath(pkg.path)))
            throw new AppError('CONFLICT', `Skill 环境包目标已被修改：${pkg.name}`)
        }
        packages.push({ name: pkg.name, version: pkg.version, directory, skill: pkg.skill })
      }
      const environment: NodeRuntimeEnvironment = {
        id,
        packages,
        skills: skills.map((skill) => ({
          name: skill.manifest.name,
          version: skill.manifest.version,
          description: skill.manifest.description,
          directory: skill.directory,
          instructions: skill.manifest.contribution.instructions,
          packages: skill.manifest.contribution.packages,
          capabilities: skill.grants,
        })),
      }
      await writeJsonFileAtomically(
        join(directory, 'package.json'),
        { name: 'velaros-agent-environment', private: true, type: 'module' },
        { mode: 0o600 }
      )
      await writeJsonFileAtomically(join(directory, 'environment.json'), environment, {
        mode: 0o600,
      })
      const leaseFile = join(this.root, 'leases', `${randomUUID()}.json`)
      await writeJsonFileAtomically(
        leaseFile,
        { pid: process.pid, environment: id, generations: skills.map((skill) => skill.generation) },
        { mode: 0o600 }
      )
      let released = false
      return {
        environment: freezeSkillData(environment),
        skills: freezeSkillData(skills),
        release: async () => {
          if (released) return
          await rm(leaseFile, { force: true })
          released = true
        },
      }
    })
  }

  public async assertGranted(name: string, generation: string, module: string): Promise<void> {
    const current = (await this.readIndex()).skills.find((skill) => skill.manifest.name === name)
    if (!current?.enabled || current.generation !== generation || !current.grants.includes(module))
      throw new AppError('PERMISSION', `Skill 能力授权已失效：${module}`)
  }

  public async collect(): Promise<readonly string[]> {
    return this.locked(async () => {
      const index = await this.readIndex()
      const used = new Set(index.skills.map((skill) => skill.generation))
      const environments = new Set<string>()
      const leaseDirectory = join(this.root, 'leases')
      await mkdir(leaseDirectory, { recursive: true, mode: 0o700 })
      for (const name of await readdir(leaseDirectory)) {
        const file = join(leaseDirectory, name)
        const lease = parseSkillLease(JSON.parse(await readFile(file, 'utf8')))
        try {
          process.kill(lease.pid, 0)
        } catch (error) {
          if (isObject(error) && 'code' in error) {
            if (error.code === 'ESRCH') {
              await rm(file)
              continue
            }
            if (error.code !== 'EPERM') throw error
          } else throw error
        }
        for (const generation of lease.generations) used.add(generation)
        environments.add(lease.environment)
      }
      const removed: string[] = []
      for (const [kind, keep] of [
        ['packages', used],
        ['environments', environments],
      ] as const) {
        const directory = join(this.root, kind)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        for (const name of await readdir(directory)) {
          if (keep.has(name)) continue
          await rm(join(directory, name), { recursive: true, force: true })
          removed.push(`${kind}/${name}`)
        }
      }
      return removed
    })
  }

  private async checkComposition(
    skills: readonly SkillRecord[]
  ): Promise<ReadonlyArray<{ name: string; version: string; path: string; skill?: string }>> {
    const packages = new Map<
      string,
      { name: string; version: string; path: string; skill?: string }
    >()
    const capabilities = new Set<string>()
    for (const pkg of this.options.packages ?? [])
      packages.set(pkg.name, {
        name: pkg.name,
        version: pkg.version,
        path: join(pkg.directory, 'node_modules', pkg.name),
      })
    for (const skill of skills.filter((skill) => skill.enabled)) {
      for (const module of skill.grants) {
        if (capabilities.has(module)) throw new AppError('CONFLICT', `Skill 能力名冲突：${module}`)
        capabilities.add(module)
      }
      for (const name of skill.manifest.contribution.packages) {
        const pkg = await this.files.packagePath(skill.directory, name)
        const previous = packages.get(name)
        if (previous) {
          if (
            previous.version !== pkg.version ||
            JSON.stringify(await skillInventory(previous.path)) !==
              JSON.stringify(await skillInventory(pkg.directory))
          )
            throw new AppError(
              'CONFLICT',
              `环境中的 ${name} 已由 ${previous.skill ?? '基础环境'} 提供；请选择独立环境或停用冲突 Skill`
            )
          continue
        }
        packages.set(name, {
          name,
          version: pkg.version,
          path: pkg.directory,
          skill: skill.manifest.name,
        })
      }
    }
    return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private async readIndex(): Promise<SkillIndex> {
    let content: string
    try {
      content = await readFile(join(this.root, 'index.json'), 'utf8')
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT')
        return { version: 1, revision: 0, skills: [] }
      throw error
    }
    const index = parseSkillIndex(JSON.parse(content))
    for (const skill of index.skills)
      if (skill.directory !== join(this.root, 'packages', skill.generation, 'package'))
        throw new AppError('PERMISSION', 'Skill 索引指向安装存储之外')
    return index
  }

  private async writeIndex(index: SkillIndex): Promise<void> {
    await writeJsonFileAtomically(join(this.root, 'index.json'), index, { mode: 0o600 })
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run('registry', async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if (!this.options.lock.acquire())
        throw new AppError('CONFLICT', '另一个进程正在修改 Skill 环境，请重试')
      try {
        return await operation()
      } finally {
        this.options.lock.release()
      }
    })
  }
}

/** 创建独立的 Skill 安装和环境装配服务。 */
export function createSkillRegistry(options: SkillRegistryOptions): SkillRegistryApi {
  return new SkillRegistry(options)
}
