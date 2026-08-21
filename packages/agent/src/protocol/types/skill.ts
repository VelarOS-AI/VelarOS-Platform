import type { AgentRoleId } from './system'
import type { CapabilityScopeId } from './tool'

export type AgentSkillSourceKind = 'builtin' | 'global' | 'project' | 'plugin'
export type AgentSkillSystemKind = 'system-bound' | 'optional-enhancement'

export interface AgentSkillDescriptor {
  id: string
  label: string
  description?: string
  sourceKind: AgentSkillSourceKind
  sourceId: string
  roleIds: AgentRoleId[]
  priority: number
  /** 是否展示在普通用户可见列表中。 */
  userVisible: boolean
  /** 调用提示（frontmatter `argument-hint`）：说明该技能期望怎样的输入/参数，索引段随描述展示。 */
  argumentHint?: string
  /** 每技能工具门控（frontmatter `allowed-tools`）：显式选中该技能的轮次，工具面收缩到声明集+交互必备。 */
  allowedTools?: readonly string[]
}

/** 文件式技能的对外摘要（设置页/聊天 / 列表用，不含正文）。 */
export interface SkillSummary {
  id: string
  name: string
  description: string
  version: Nullable<string>
  updatedAt: number
  sourceKind?: AgentSkillSourceKind
  systemKind?: AgentSkillSystemKind
  userVisible?: boolean
  enabled?: boolean
  toggleable?: boolean
  deletable?: boolean
  revealable?: boolean
  /** 必填且非空；通用 Skill 也必须显式列出宿主支持的全部空间。 */
  capabilityScopes: CapabilityScopeId[]
}

export interface SkillListRequest {
  includeHidden?: boolean
  includeDisabled?: boolean
}

export interface SkillSetEnabledRequest {
  id: string
  enabled: boolean
}

/** 技能市场条目（远端 manifest + 本地安装状态合成）。 */
export interface SkillMarketEntry {
  id: string
  name: string
  description: string
  version: string
  installState: 'not-installed' | 'installed' | 'update-available'
  install?: {
    phase: 'installing' | 'failed'
    error?: string
  }
}

export interface SkillMarketCatalog {
  generatedAt: number
  entries: SkillMarketEntry[]
}
