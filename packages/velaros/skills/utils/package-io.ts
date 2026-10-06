import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { SkillLimits } from '../contract/constants.js'

/** 核对符号链接之后的真实文件仍属于安装根。 */
export async function containedSkillPath(root: string, path: string): Promise<string> {
  const result = await realpath(path)
  const from = relative(await realpath(root), result)
  if (from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from))
    throw new AppError('PERMISSION', `Skill 资源越过安装目录：${path}`)
  return result
}

/** 清单和声明采用有限大小的普通文件，避免设备文件及超大输入。 */
export async function readSkillText(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile()) throw new AppError('VALIDATION', 'Skill 清单必须是普通文件')
  if (info.size > SkillLimits.manifestBytes) throw new AppError('LIMIT', 'Skill 清单超过大小上限')
  return readFile(path, 'utf8')
}

/** 为安装文件生成确定顺序的内容清单，来源检查跳过现有依赖。 */
export async function skillInventory(
  directory: string,
  source = false,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const root = await realpath(directory)
  const files: Record<string, string> = Object.create(null)
  let total = 0
  let count = 0
  const visit = async (path: string): Promise<void> => {
    signal?.throwIfAborted()
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.name === '.git' || (source && entry.name === 'node_modules')) continue
      const file = join(path, entry.name)
      const name = relative(root, file).split(sep).join('/')
      if (++count > SkillLimits.files) throw new AppError('LIMIT', 'Skill 文件数量超过安装上限')
      if (entry.isSymbolicLink()) {
        await containedSkillPath(root, file)
        files[name] = `link:${await readlink(file)}`
      } else if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        const info = await lstat(file)
        total += info.size
        if (info.size > SkillLimits.fileBytes || total > SkillLimits.totalBytes)
          throw new AppError('LIMIT', 'Skill 文件大小超过安装上限')
        files[name] = createHash('sha256')
          .update(await readFile(file))
          .digest('hex')
      } else throw new AppError('VALIDATION', `Skill 包不接受特殊文件：${name}`)
    }
  }
  await visit(root)
  return files
}
