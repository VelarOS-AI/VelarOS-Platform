import { cp, lstat, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'

import { satisfies } from 'semver'

import { isObject, isString, stringifyPretty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { scriptContractCompiler } from '@velaros-ai/script'

import type { SkillManifest, SkillReceipt } from '../types/skills.js'
import { parseSkillManifest, skillInstructionsManifest } from '../utils/manifest.js'
import { containedSkillPath, readSkillText, skillInventory } from '../utils/package-io.js'

/** 安装文件和内容收据的唯一读取者，所有路径均限制在所属包内。 */
export interface SkillPackageFilesApi {
  /** 将来源的发布文件复制到新目录，隔离现有依赖和版本库。 */
  copy(source: string, destination: string, signal?: AbortSignal): Promise<void>
  /** 读取标准清单或适配纯说明目录，并核验资源入口与 Node 版本。 */
  manifest(directory: string, nodeVersion: string): Promise<SkillManifest>
  /** 为安装后的全部文件生成内容散列。 */
  receipt(directory: string, manifest: SkillManifest): Promise<SkillReceipt>
  /** 当前内容必须逐项匹配安装收据。 */
  verify(directory: string, receipt: SkillReceipt): Promise<void>
  /** 按 Node 的依赖目录查找公开包并核对安装范围。 */
  packagePath(directory: string, name: string): Promise<{ directory: string; version: string }>
}

/** 暂存、校验和散列处理共享同一条真实路径边界。 */
export class SkillPackageFiles implements SkillPackageFilesApi {
  public async copy(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const root = await realpath(source)
    if (!(await lstat(root)).isDirectory()) throw new AppError('VALIDATION', 'Skill 来源必须是目录')
    const target = resolve(destination)
    if (target === root || target.startsWith(root + sep))
      throw new AppError('VALIDATION', 'Skill 暂存目录不能位于来源目录内')
    await skillInventory(root, true, signal)
    await cp(root, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      filter: (path) => {
        signal?.throwIfAborted()
        return !relative(root, path)
          .split(sep)
          .some((part) => ['node_modules', '.git'].includes(part))
      },
    })
  }

  public async manifest(directory: string, nodeVersion: string): Promise<SkillManifest> {
    let value: unknown
    try {
      value = JSON.parse(await readSkillText(join(directory, 'package.json')))
    } catch (error) {
      if (!isObject(error) || !('code' in error) || error.code !== 'ENOENT') throw error
      value = skillInstructionsManifest(await readSkillText(join(directory, 'SKILL.md')))
      await writeFile(join(directory, 'package.json'), stringifyPretty(value), {
        mode: 0o600,
        flag: 'wx',
      })
    }
    const manifest = parseSkillManifest(value)
    if (manifest.node && !satisfies(nodeVersion, manifest.node))
      throw new AppError(
        'UNAVAILABLE',
        `${manifest.name} 需要 Node ${manifest.node}，当前为 ${nodeVersion}`
      )
    const files = [
      manifest.contribution.instructions,
      ...manifest.contribution.capabilities.flatMap((item) => [item.entry, item.contract]),
    ].filter(isString)
    for (const file of files) {
      const path = await containedSkillPath(directory, join(directory, file))
      if (!(await lstat(path)).isFile())
        throw new AppError('VALIDATION', `Skill 资源必须是文件：${file}`)
    }
    for (const capability of manifest.contribution.capabilities)
      scriptContractCompiler.compile(
        await readSkillText(join(directory, capability.contract)),
        capability.module
      )
    return manifest
  }

  public async receipt(directory: string, manifest: SkillManifest): Promise<SkillReceipt> {
    return { manifest, files: await skillInventory(directory) }
  }

  public async verify(directory: string, receipt: SkillReceipt): Promise<void> {
    const actual = await this.receipt(directory, receipt.manifest)
    if (JSON.stringify(actual.files) !== JSON.stringify(receipt.files))
      throw new AppError('CONFLICT', `Skill 文件与安装收据不符：${receipt.manifest.name}`)
  }

  public async packagePath(
    directory: string,
    name: string
  ): Promise<{ directory: string; version: string }> {
    const own = JSON.parse(await readSkillText(join(directory, 'package.json')))
    const paths =
      own.name === name
        ? [directory]
        : (createRequire(join(directory, 'package.json')).resolve.paths(name) ?? []).map((path) =>
            join(path, name)
          )
    for (const path of paths) {
      let content: string
      try {
        content = await readSkillText(join(path, 'package.json'))
      } catch (error) {
        if (isObject(error) && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      const pkg = JSON.parse(content)
      if (pkg.name !== name || !isString(pkg.version))
        throw new AppError('VALIDATION', `依赖身份无效：${name}`)
      return { directory: await containedSkillPath(directory, path), version: pkg.version }
    }
    throw new AppError('NOT_FOUND', `Skill 缺少依赖：${name}`)
  }
}
