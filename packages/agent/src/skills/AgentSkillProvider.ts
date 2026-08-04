import type {
  AgentRoleId,
  AgentSkillDescriptor,
  AgentSkillSourceKind,
  CapabilityScopeId,
  ChatPromptFeatureId,
} from '@velaros-ai/agent/protocol'

/**
 * 技能类型——行为知识三层模型里 Tier2 的两个子类，决定注入方式：
 *  - role：角色身份技能。当前角色命中即注入全文常驻（Tier2 常驻档）。只应由受信任的内置角色供应方产出。
 *  - capability：能力技能。descriptor 常驻、正文按需 tooling:read；命中 feature/选中后只注入 skill:<id> 指针。
 */
type AgentSkillKind = 'role' | 'capability'

/**
 * 智能体技能定义。
 * - 继承技能描述，增加完整文档内容，用于 tooling:read 按需读取。
 * - kind='role' 由内置角色供应方注册，命中角色即注入全文；
 *   kind='capability' 命中后只注入 skill:<id> 链接，正文按需读取。
 */
interface AgentSkillDefinition extends AgentSkillDescriptor {
  markdown: string
  /** 目录式技能（<id>/SKILL.md）的根目录；平铺单文件技能为空。 */
  baseDir?: string
  /** 目录式技能的捆绑资源相对路径清单（渐进披露第三层，tooling:read skill:<id>/<路径> 按需读取）。 */
  resourcePaths?: readonly string[]
  /** 项目级技能的来源项目根：仅当会话活跃根等于它时可见（根级精筛）。 */
  sourceResourceId?: string
  /** 用户可暂停技能；禁用后不参与列表、自动命中或 tooling:read。 */
  enabled: boolean
  /** 技能类型：决定注入方式（role=全文常驻，capability=指针+按需）。与 sourceKind（来源）区分。 */
  skillKind: AgentSkillKind
  /**
   * 哪些 Prompt Feature 开启时命中该技能。
   *
   * 用于用户显式开启的高成本能力；命中后只注入 skill:<id> 链接。
   */
  autoInjectPromptFeatures?: readonly ChatPromptFeatureId[]
  /**
   * 技能可见/可触发的能力作用域。
   *
   * 空数组表示通用；指定范围时，列表、tooling:read 和自动注入都只在对应作用域生效。
   */
  capabilityScopes?: readonly CapabilityScopeId[]
}

/**
 * 智能体技能提供方接口。
 *
 * 实现方负责按当前运行状态生成可用的技能列表；上层 AgentSkillRepository
 * 会按角色聚合并按 priority + id 稳定排序，多个 provider 同 id 时后者覆盖。
 *
 * `listSkills` 收敛为 `readonly AgentSkillDefinition[]`：
 *  - 上层会做缓存（基于 `getVersion()` 失效），迭代器会破坏缓存语义；
 *  - 实现方原本返回 Array 也兼容，纯遍历调用方无需改动。
 */
interface AgentSkillProvider {
  readonly id: string
  readonly kind: AgentSkillSourceKind
  readonly label: string
  listSkills(): readonly AgentSkillDefinition[]
  /** 读取已枚举的目录式技能资源；实现方必须再次校验相对路径是否属于该技能。 */
  readSkillResource?(skill: AgentSkillDefinition, resourcePath: string): Nullable<string>
  /**
   * 可选的版本号，repository 会用它判断是否需要重新加载技能集合。
   *
   * 返回 string 时必须随技能内容变化而变化（例如 hash 或 AgentSystemRuntimeConfig 引用），
   * 不实现则视为“总是变化”，repository 退回到每次都 reload 的旧行为。
   */
  getVersion?(): string
}

function createSkillDefinition(args: {
  id: string
  label: string
  description?: string
  provider: Pick<AgentSkillProvider, 'id' | 'kind'>
  roleIds: AgentRoleId[]
  priority?: number
  markdown: string
  /** 技能类型；省略默认 capability（指针 + 按需读取）。role 只应由内置角色供应方显式声明。 */
  skillKind?: AgentSkillKind
  autoInjectPromptFeatures?: readonly ChatPromptFeatureId[]
  capabilityScopes?: readonly CapabilityScopeId[]
  enabled?: boolean
  userVisible?: boolean
  argumentHint?: LooseOptional<string>
  baseDir?: LooseOptional<string>
  resourcePaths?: readonly string[]
  sourceResourceId?: LooseOptional<string>
  allowedTools?: readonly string[]
}): AgentSkillDefinition {
  return {
    id: args.id,
    label: args.label,
    description: args.description,
    sourceKind: args.provider.kind,
    sourceId: args.provider.id,
    roleIds: args.roleIds,
    priority: args.priority ?? 100,
    userVisible: args.userVisible ?? true,
    ...(args.argumentHint?.trim() ? { argumentHint: args.argumentHint.trim() } : {}),
    ...(args.baseDir?.trim() ? { baseDir: args.baseDir.trim() } : {}),
    ...(args.resourcePaths?.length ? { resourcePaths: [...args.resourcePaths] } : {}),
    ...(args.sourceResourceId?.trim() ? { sourceResourceId: args.sourceResourceId.trim() } : {}),
    ...(args.allowedTools?.length ? { allowedTools: [...args.allowedTools] } : {}),
    enabled: args.enabled ?? true,
    markdown: args.markdown.trim(),
    skillKind: args.skillKind ?? 'capability',
    autoInjectPromptFeatures: args.autoInjectPromptFeatures
      ? [...args.autoInjectPromptFeatures]
      : [],
    capabilityScopes: args.capabilityScopes ? [...args.capabilityScopes] : [],
  }
}

export { createSkillDefinition }
export type { AgentSkillDefinition, AgentSkillKind, AgentSkillProvider }
