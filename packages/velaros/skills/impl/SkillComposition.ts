import { AppError } from '@velaros-ai/core/error'

import type { SkillRecord, SkillSelection } from '../types/skills.js'

/** 将工作区默认项与会话显式选择合并；显式版本始终由租约校验。 */
export interface SkillCompositionApi {
  /** 按稳定名称合并默认与显式选择，版本与权限交给租约核验。 */
  select(
    records: readonly SkillRecord[],
    selected: readonly SkillSelection[],
    defaults?: readonly string[]
  ): SkillSelection[]
}

/** 同一组成规则供宿主与聊天选择器使用。 */
class SkillComposition implements SkillCompositionApi {
  public select(
    records: readonly SkillRecord[],
    selected: readonly SkillSelection[],
    defaults: readonly string[] = []
  ): SkillSelection[] {
    if (new Set(selected.map((item) => item.name)).size !== selected.length)
      throw new AppError('CONFLICT', '会话 Skill 选择存在重复名称')
    const result = [...selected]
    for (const name of defaults) {
      if (result.some((item) => item.name === name)) continue
      const record = records.find((item) => item.manifest.name === name)
      if (!record) throw new AppError('UNAVAILABLE', `工作区需要的 Skill 不可用：${name}`)
      result.push({
        name,
        generation: record.generation,
        grants: [
          ...record.manifest.contribution.capabilities.map((item) => item.module),
          ...(record.manifest.contribution.hostCapabilities ?? []),
        ],
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** 工作区组合的无状态选择器。 */
export const skillComposition: SkillCompositionApi = new SkillComposition()
