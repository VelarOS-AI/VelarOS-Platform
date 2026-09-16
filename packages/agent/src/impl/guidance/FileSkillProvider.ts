import type { AgentSkillProvider } from '../../contract/requires.js'
import type { AgentRoleId } from '../../types/agent.js'
import type { AgentSkillDefinition } from '../../types/guidance.js'
import { createSkillDefinition } from '../../utils/guidance/agent-skill-provider'
import { resolveFileSkillScopes } from '../../utils/guidance/file-skill-provider'
import { AgentTuning } from '../../utils/tuning'

import type { SkillFileStoreApi } from './SkillFileStore'

/**
 * 文件式技能供应方：storage/skills 下的 markdown 文件即已安装技能。
 * 对所有角色可见；getVersion 跟随文件指纹，repository 缓存自动失效。
 * frontmatter 支持 spaces/priority/argument-hint——与内置 catalog 平权的触发维度。
 */
class FileSkillProvider implements AgentSkillProvider {
  readonly id: string
  readonly kind: AgentSkillProvider['kind']
  readonly label: string

  constructor(
    private readonly store: SkillFileStoreApi,
    private readonly roleIds: readonly AgentRoleId[],
    options: {
      readonly id?: string
      readonly kind?: AgentSkillProvider['kind']
      readonly label?: string
    } = {}
  ) {
    this.id = options.id?.trim() || 'skill-files'
    this.kind = options.kind ?? 'global'
    this.label = options.label?.trim() || '技能文件'
  }

  public listSkills(): AgentSkillDefinition[] {
    return this.store.list().map((record) =>
      createSkillDefinition({
        ...record,
        label: record.name,
        provider: this,
        roleIds: [...this.roleIds],
        priority: record.priority ?? AgentTuning.prompt.userFileSkillPriority,
        capabilityScopes: resolveFileSkillScopes(record.spaces),
      })
    )
  }

  public getVersion(): string {
    return this.store.version()
  }

  public readSkillResource(skill: AgentSkillDefinition, resourcePath: string): Nullable<string> {
    return this.store.readSkillResource(skill.id, resourcePath)
  }
}

export { FileSkillProvider }

/** 建一个文件式技能供应方：从技能目录读 SKILL.md。 */
export function createFileSkillProvider(store: SkillFileStoreApi, roleIds: readonly AgentRoleId[], options: {
      readonly id?: string
      readonly kind?: AgentSkillProvider['kind']
      readonly label?: string
    } = {}): AgentSkillProvider {
  return new FileSkillProvider(store, roleIds, options)
}
