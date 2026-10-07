import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppError } from '@velaros-ai/core/error'

import { BuiltinSkillNames } from '../contract/constants.js'
import type { SkillRecord } from '../types/skills.js'
import { skillInventory } from '../utils/package-io.js'

import { SkillPackageFiles } from './SkillPackageFiles.js'

/** 内置来源由宿主注入；每个注册处固定自己的目录与内容身份。 */
export interface BuiltinSkillsApi {
  /** 读取当前宿主发布的固定内置包集合。 */
  list(): Promise<readonly SkillRecord[]>
}

/** 内置 Skill 的清单和 npm 依赖照常解析，来源信任由宿主持有。 */
export class BuiltinSkills implements BuiltinSkillsApi {
  private records?: Promise<readonly SkillRecord[]>
  public constructor(
    private readonly directories: readonly string[],
    private readonly nodeVersion: string
  ) {}
  public list(): Promise<readonly SkillRecord[]> {
    return (this.records ??= this.read())
  }
  private async read(): Promise<readonly SkillRecord[]> {
    const files = new SkillPackageFiles()
    const records: SkillRecord[] = []
    for (const directory of this.directories) {
      const manifest = await files.manifest(directory, this.nodeVersion)
      const hash = createHash('sha256')
        .update(JSON.stringify({ manifest, files: await skillInventory(directory, true) }))
        .digest('hex')
      const generation = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      if (records.some((record) => record.manifest.name === manifest.name))
        throw new AppError('CONFLICT', `内置 Skill 身份重复：${manifest.name}`)
      records.push({
        manifest,
        generation,
        directory,
        installedAt: '1970-01-01T00:00:00.000Z',
        builtin: true,
      })
    }
    return records
  }
}

/** 发行包可提供独立的 Skill 资源根；开发环境沿正式包入口解析。 */
export function builtinSkillDirectories(directory?: string): readonly string[] {
  if (directory) return Object.keys(BuiltinSkillNames).map((name) => join(directory, name))
  return [
    fileURLToPath(new URL('../resources/browser', import.meta.url)),
    dirname(createRequire(import.meta.url).resolve('@velaros-ai/skill-jsts/package.json')),
  ]
}
