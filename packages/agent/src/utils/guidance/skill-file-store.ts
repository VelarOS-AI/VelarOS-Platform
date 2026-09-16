import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { AgentSkillFiles } from '../../contract/constants.js'
// SkillFileStore 用到的纯函数（不碰实例状态）。
/** 从名称派生文件 slug（中英文保留，其余折叠成 -）。 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** 枚举目录式技能的捆绑资源相对路径（深度≤3、上限 50，跳过隐藏文件与 SKILL.md）。 */
export function listSkillDirResources(baseDir: string): string[] {
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
      } else if (entry.isFile() && rel !== AgentSkillFiles.skillEntryFileName) {
        resources.push(rel)
      }
    }
  }
  walk(baseDir, '', 1)
  return resources.sort()
}
