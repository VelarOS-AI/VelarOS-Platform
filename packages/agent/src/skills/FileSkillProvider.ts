import type { AgentRoleId } from '@velaros-ai/agent/protocol'

import {
  type AgentSkillDefinition,
  type AgentSkillProvider,
  createSkillDefinition,
} from './AgentSkillProvider'
import type { SkillFileStore } from './SkillFileStore'

/**
 * 用户技能默认排序优先级：故意低于内置 catalog 的 100（priority 升序=靠前）。
 * 用户显式安装的技能承载明确意图，索引 12 条截断时应先于泛化内置技能展示。
 * frontmatter `priority:` 可覆盖。
 */
const UserFileSkillDefaultPriority = 60

function resolveFileSkillScopes(spaces: readonly string[]): string[] {
  return spaces
    .map((space) => space.trim().toLowerCase())
    .filter(Boolean)
}

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
    private readonly store: SkillFileStore,
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
        priority: record.priority ?? UserFileSkillDefaultPriority,
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
