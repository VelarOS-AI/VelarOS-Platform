import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { isObject, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'

import type {
  EnvironmentGeneration,
  EnvironmentIndex,
  EnvironmentPackage,
} from '../types/environment.js'
import {
  environmentDependencies,
  environmentPackageName,
  parseEnvironmentIndex,
} from '../utils/environment.js'

/** 环境文件的安装事实核验与原子指针存储。 */
export interface EnvironmentFilesApi {
  /** 读取已发布的索引，首次返回空环境。 */
  readIndex(): Promise<EnvironmentIndex>
  /** 原子替换当前指针和有界历史。 */
  writeIndex(index: EnvironmentIndex): Promise<void>
  /** 在独占新目录复制清单与锁文件，保留既有依赖的精确版本。 */
  prepare(id: string, current?: EnvironmentGeneration): Promise<string>
  /** 将指定直接依赖从候选清单移除。 */
  remove(directory: string, names: readonly string[]): Promise<void>
  /** 核对清单、锁文件、安装目录并生成持久收据。 */
  inspect(id: string): Promise<EnvironmentGeneration>
  /** 核对仍在使用的不可变安装内容。 */
  verify(generation: EnvironmentGeneration): Promise<void>
}

/** 所有路径均从宿主根目录派生，安装时保留最终目录避免原生构建路径失效。 */
export class EnvironmentFiles implements EnvironmentFilesApi {
  public constructor(private readonly root: string) {}

  public async readIndex(): Promise<EnvironmentIndex> {
    try {
      const index = parseEnvironmentIndex(
        JSON.parse(await readFile(join(this.root, 'current.json'), 'utf8'))
      )
      for (const entry of index.entries) {
        for (const pkg of entry.generation.packages) {
          environmentPackageName(pkg.name)
          if (pkg.directory !== join(this.root, 'revisions', entry.generation.id))
            throw new AppError('VALIDATION', '环境索引目录越界')
        }
      }
      return index
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT')
        return { format: 1, revision: 0, entries: [] }
      throw error
    }
  }

  public async writeIndex(index: EnvironmentIndex): Promise<void> {
    await writeJsonFileAtomically(join(this.root, 'current.json'), index, { mode: 0o600 })
  }

  public async prepare(id: string, current?: EnvironmentGeneration): Promise<string> {
    const directory = join(this.root, 'revisions', id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (current) {
      const previous = join(this.root, 'revisions', current.id)
      await copyFile(join(previous, 'package.json'), join(directory, 'package.json'))
      await copyFile(join(previous, 'package-lock.json'), join(directory, 'package-lock.json'))
      const digest = createHash('sha256')
        .update(await readFile(join(directory, 'package.json')))
        .update(await readFile(join(directory, 'package-lock.json')))
        .digest('hex')
      if (digest !== current.digest)
        throw new AppError('CONFLICT', '环境清单或锁文件已变化，请回滚到完整的历史版本')
    } else {
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'velaros-agent-environment',
          private: true,
          type: 'module',
          dependencies: {},
        }),
        { mode: 0o600 }
      )
    }
    return directory
  }

  public async remove(directory: string, names: readonly string[]): Promise<void> {
    const manifest = await this.manifest(join(directory, 'package.json'))
    const dependencies = environmentDependencies(manifest)
    for (const name of names) {
      if (!Object.hasOwn(dependencies, name))
        throw new AppError('NOT_FOUND', `环境中未安装 ${name}`)
      delete dependencies[name]
    }
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ ...manifest, dependencies }),
      { mode: 0o600 }
    )
  }

  public async inspect(id: string): Promise<EnvironmentGeneration> {
    const directory = join(this.root, 'revisions', id)
    const realDirectory = await realpath(directory)
    const manifest = await this.manifest(join(directory, 'package.json'))
    const lock = await this.manifest(join(directory, 'package-lock.json'))
    const dependencies = environmentDependencies(manifest)
    if (!isPlainObject(lock.packages) || !isPlainObject(lock.packages['']))
      throw new AppError('VALIDATION', 'npm 没有生成完整锁文件')
    const lockedRoot = environmentDependencies(lock.packages[''])
    if (
      JSON.stringify(Object.entries(dependencies).sort()) !==
      JSON.stringify(Object.entries(lockedRoot).sort())
    )
      throw new AppError('CONFLICT', '环境清单与锁文件不一致')
    const packages: EnvironmentPackage[] = []
    for (const name of Object.keys(dependencies).sort()) {
      environmentPackageName(name)
      const packageRoot = await realpath(join(directory, 'node_modules', name))
      const path = relative(realDirectory, packageRoot)
      if (!path || path === '..' || path.startsWith(`..${sep}`))
        throw new AppError('PERMISSION', `依赖目录越界：${name}`)
      const packageJson = join(packageRoot, 'package.json')
      const pkg = await this.manifest(packageJson)
      const locked = lock.packages[`node_modules/${name}`]
      if (
        !isString(pkg.name) ||
        !isString(pkg.version) ||
        !isPlainObject(locked) ||
        pkg.version !== locked.version ||
        !isString(locked.integrity)
      )
        throw new AppError('CONFLICT', `安装包与锁文件不一致：${name}`)
      const commands = isString(pkg.bin)
        ? [name.split('/').at(-1)!]
        : isPlainObject(pkg.bin)
          ? Object.keys(pkg.bin).sort()
          : []
      const readme = (await readdir(packageRoot, { withFileTypes: true }))
        .filter(
          (entry) => entry.isFile() && /^readme(?:\.(?:md|markdown|txt|rst))?$/iu.test(entry.name)
        )
        .map((entry) => entry.name)
        .sort()[0]
      packages.push({
        name,
        package: pkg.name,
        version: pkg.version,
        directory,
        packageJson,
        readme: readme ? join(packageRoot, readme) : undefined,
        commands,
      })
    }
    const digest = createHash('sha256')
      .update(await readFile(join(directory, 'package.json')))
      .update(await readFile(join(directory, 'package-lock.json')))
      .digest('hex')
    return { id, packages, digest }
  }

  public async verify(generation: EnvironmentGeneration): Promise<void> {
    const actual = await this.inspect(generation.id)
    if (
      actual.digest !== generation.digest ||
      JSON.stringify(actual.packages) !== JSON.stringify(generation.packages)
    )
      throw new AppError('CONFLICT', '已发布的 npm 环境发生变化，请重新安装或回滚')
  }

  private async manifest(path: string): Promise<Record<string, unknown>> {
    const scope = relative(await realpath(this.root), await realpath(path))
    if (scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope))
      throw new AppError('PERMISSION', 'npm 清单路径越界')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isPlainObject(value)) throw new AppError('VALIDATION', 'npm 清单需要 JSON 对象')
    return value
  }
}
