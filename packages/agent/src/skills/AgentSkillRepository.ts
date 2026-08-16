import type {
  AgentRoleId,
  AgentSkillDescriptor,
  CapabilityScopeId,
  ChatPromptFeatureId,
} from '@velaros-ai/agent/protocol'
import { isEmpty,isFalse, isPresent, toNullable } from '@velaros-ai/core'

import { compareStableStrings } from '../agent/context/residency/determinism'

import type { AgentSkillDefinition, AgentSkillProvider } from './AgentSkillProvider'

/**
 * 智能体技能仓库：聚合内置与文件式技能，按角色生成可注入的文档段。
 *
 * 技能合并规则：
 *  - 多个供应方注册同一技能时，后注册者覆盖先注册者，重载顺序按供应方数组。
 *  - 可见性（Claude Code 同款）：descriptor 对角色始终可见、全文可随时 tooling:read 按需读取；
 *    但普通 skill 命中后只注入 skill:<id> 链接，正文不直接进入系统提示。
 *  - 输出按优先级升序加标识字母序排序，保证提示结构稳定，利于缓存。
 *
 * 每次按角色列出技能或读取技能文档时都会重载，
 * 这是 trade-off：用户在运行时调整技能配置可以即时生效，代价是 hot path 上有少量重复构建。
 *
 * ## 可见性漏斗与那条逃生口（改一处必须改两处）
 * `getDefinitionsForRole` 是唯一的过滤漏斗：角色 → 启用 → 作用域 → 资源根 → prompt feature。
 * 其上有一条**显式选中的逃生口**（`getDefinitionForRoleIgnoringSpace`）：用户亲手选的技能跳过
 * 作用域过滤（作用域收敛的是"泛化索引"，不是权限；enabled 与资源根精筛仍然生效）。
 * 这条逃生口在**注入侧**（`getSkillMarkdownForRole`）与**读取侧**（`readSkillForRole`）各接了一次，
 * 两处必须同形——只补注入侧会让提示词里写着"必须先读 skill:x"而 tooling:read 回 404，
 * 选中意图断在半路且没有任何报错；只补读取侧则是选了却不提示，用户完全无感。
 *
 * ## 注入方式由 skillKind 决定，不是由来源决定
 * `role` 类技能注入全文常驻，`capability` 类一律只注入 `skill:<id>` 指针、正文按需 tooling:read。
 * 把某个来源整体升格成全文注入等于把它的 token 成本变成每轮固定开销。
 *
 * ## 全文常驻档需要宿主显式授权
 * `skillKind: 'role'` 只是声明；能不能真的全文常驻，看它的供应方 id 是否在
 * `trustedRoleSkillProviderIds` 里——**缺省空集，即任何供应方都不许**。授权必须在真正读取
 * `skillKind` 的执行门生效，不能只在某个宿主适配器预处理；否则另一条供应方装配线可能让
 * 第三方文本获得每回合全文常驻的提示词位置。
 */
class AgentSkillRepository {
  private readonly skillsById = new Map<string, AgentSkillDefinition>()
  private readonly roleSkillIds = new Map<AgentRoleId, Set<string>>()
  /**
   * 上次 reload 时各 provider 的版本快照。Provider 不提供 getVersion() 视为
   * “永远变化”，repository 会退回每次都 reload 的旧行为。
   */
  private lastProviderVersions: Nullable<Array<LooseOptional<string>>> = null

  /** 允许产出全文常驻（`skillKind: 'role'`）技能的供应方 id；缺省空集 = 谁都不许。 */
  private readonly trustedRoleSkillProviderIds: ReadonlySet<string>

  constructor(
    private readonly providers: AgentSkillProvider[],
    options: { trustedRoleSkillProviderIds?: readonly string[] } = {}
  ) {
    this.trustedRoleSkillProviderIds = new Set(options.trustedRoleSkillProviderIds ?? [])
    this.reload()
  }

  public reload(): void {
    this.skillsById.clear()
    this.roleSkillIds.clear()

    for (const provider of this.providers) {
      for (const skill of provider.listSkills()) {
        this.register(skill)
      }
    }

    this.lastProviderVersions = this.snapshotProviderVersions()
  }

  /** 角色可见的技能 descriptor（不含全文）；不按选中过滤，模型据此按需 tooling:read。 */
  public listSkillsForRole(
    roleId: AgentRoleId,
    selectedSkillIds: string[] = [],
    capabilityScope?: CapabilityScopeId,
    resourceId?: LooseOptional<string>,
    promptFeatures: readonly ChatPromptFeatureId[] = []
  ): AgentSkillDescriptor[] {
    this.reloadIfNeeded()
    const selected = new Set(selectedSkillIds.map((id) => id.trim()).filter(Boolean))
    const featureSet = new Set(promptFeatures)
    return this.getDefinitionsForRole(
      roleId,
      capabilityScope,
      resourceId,
      selected,
      featureSet
    ).map((skill) => this.toDescriptor(skill))
  }

  /** 注入系统提示的技能段：角色身份技能注入全文，普通 skill 命中后只注入读取链接。 */
  public getSkillMarkdownForRole(
    roleId: AgentRoleId,
    selectedSkillIds: string[] = [],
    promptFeatures: readonly ChatPromptFeatureId[] = [],
    capabilityScope?: CapabilityScopeId,
    resourceId?: LooseOptional<string>
  ): string {
    this.reloadIfNeeded()
    const selected = new Set(selectedSkillIds.map((id) => id.trim()).filter(Boolean))
    const featureSet = new Set(promptFeatures)
    const fullMarkdown: string[] = []
    const linkedSkills: AgentSkillDefinition[] = []

    const definitionsInSpace = this.getDefinitionsForRole(
      roleId,
      capabilityScope,
      resourceId,
      selected,
      featureSet
    )
    for (const skill of definitionsInSpace) {
      if (this.shouldInjectFullMarkdown(skill)) {
        fullMarkdown.push(skill.markdown.trim())
        continue
      }

      if (selected.has(skill.id) || this.hasAutoInjectPromptFeature(skill, featureSet)) {
        linkedSkills.push(skill)
      }
    }

    // 显式选中优先于空间过滤:capabilityScopes 只收敛"泛化索引",不否决用户亲手选的技能。
    // 否则跨空间选中会被静默吞掉(既不注入也不提示),用户/调用方完全无感。
    const idsInSpace = new Set(definitionsInSpace.map((skill) => skill.id))
    for (const skillId of selected) {
      if (idsInSpace.has(skillId)) continue
      const skill = this.getDefinitionForRoleIgnoringSpace(roleId, skillId, resourceId)
      if (skill && !this.shouldInjectFullMarkdown(skill)) linkedSkills.push(skill)
    }

    return [...fullMarkdown, this.formatLinkedSkillPrompt(linkedSkills, selected)]
      .filter(Boolean)
      .join('\n\n')
  }

  /** 按需读取单个技能全文（tooling:read skill:<id>）；角色可见即可读，不要求选中。 */
  public readSkillForRole(
    roleId: AgentRoleId,
    skillId: string,
    selectedSkillIds: string[] = [],
    capabilityScope?: CapabilityScopeId,
    resourceId?: LooseOptional<string>,
    promptFeatures: readonly ChatPromptFeatureId[] = []
  ): Nullable<AgentSkillDefinition> {
    this.reloadIfNeeded()
    const normalizedId = skillId.trim()
    if (!normalizedId) return null

    const selected = new Set(selectedSkillIds.map((id) => id.trim()).filter(Boolean))
    const featureSet = new Set(promptFeatures)
    const skill = this.getDefinitionsForRole(
      roleId,
      capabilityScope,
      resourceId,
      selected,
      featureSet
    ).find((candidate) => candidate.id === normalizedId)
    if (skill) return { ...skill }

    // 与注入侧同一契约:显式选中的技能即使不在当前空间的泛化索引里也允许读取,
    // 否则"命中 Skill"段让模型去读、读取却 404,选中意图断在半路。
    if (!selected.has(normalizedId)) return null
    const selectedSkill = this.getDefinitionForRoleIgnoringSpace(
      roleId,
      normalizedId,
      resourceId
    )
    return selectedSkill ? { ...selectedSkill } : null
  }

  /** 由技能来源 provider 读取已枚举资源，调用方不直接接触文件系统。 */
  public readSkillResource(skill: AgentSkillDefinition, resourcePath: string): Nullable<string> {
    const normalized = resourcePath.trim()
    if (!normalized || !skill.resourcePaths?.includes(normalized)) return null
    const provider = this.providers.find((candidate) => candidate.id === skill.sourceId)
    return toNullable(provider?.readSkillResource?.(skill, normalized))
  }

  /**
   * 只在任一供应方版本发生变化时重载。
   *
   * 这是热路径优化：之前每次读取技能都会无条件重载，
   * 对需要序列化配置的供应方是不必要的开销。供应方没实现版本接口时保留旧的“总是重载”行为。
   */
  private reloadIfNeeded(): void {
    if (!this.lastProviderVersions) {
      this.reload()
      return
    }
    const current = this.snapshotProviderVersions()
    if (current.length !== this.lastProviderVersions.length) {
      this.reload()
      return
    }
    for (let i = 0; i < current.length; i += 1) {
      // 任一 provider 没实现 getVersion 时（null），强制 reload；
      // 这样新增 provider 的接入方默认是“即时生效”的保守语义。
      if (!isPresent(current[i]) || current[i] !== this.lastProviderVersions[i]) {
        this.reload()
        return
      }
    }
  }

  private snapshotProviderVersions(): Array<Nullable<string>> {
    return this.providers.map((provider) => toNullable(provider.getVersion?.()))
  }

  private register(skill: AgentSkillDefinition): void {
    const normalizedSkill = {
      ...skill,
      markdown: skill.markdown.trim(),
    }
    const existing = this.skillsById.get(normalizedSkill.id)

    if (existing) {
      for (const roleId of existing.roleIds) {
        this.roleSkillIds.get(roleId)?.delete(existing.id)
      }
    }

    this.skillsById.set(normalizedSkill.id, normalizedSkill)
    for (const roleId of normalizedSkill.roleIds) {
      const skillIds = this.roleSkillIds.get(roleId) ?? new Set<string>()
      skillIds.add(normalizedSkill.id)
      this.roleSkillIds.set(roleId, skillIds)
    }
  }

  private getDefinitionsForRole(
    roleId: AgentRoleId,
    capabilityScope?: CapabilityScopeId,
    resourceId?: LooseOptional<string>,
    selectedSkillIds: ReadonlySet<string> = new Set(),
    promptFeatures: ReadonlySet<ChatPromptFeatureId> = new Set()
  ): AgentSkillDefinition[] {
    return [...(this.roleSkillIds.get(roleId) ?? [])]
      .map((skillId) => this.skillsById.get(skillId))
      .filter((skill): skill is AgentSkillDefinition => !!skill)
      .filter((skill) => !isFalse(skill.enabled))
      .filter((skill) => this.isSkillVisibleInScope(skill, capabilityScope))
      .filter((skill) => this.isSkillVisibleForResource(skill, resourceId))
      .filter((skill) =>
        this.isSkillVisibleForPromptFeatures(skill, selectedSkillIds, promptFeatures)
      )
      .sort((left, right) => left.priority - right.priority || compareStableStrings(left.id, right.id))
  }

  /**
   * 带 autoInjectPromptFeatures 的 Skill 是已启用插件的操作手册：插件未启用时不进入
   * 当前 Skills 索引。插件是否存在、如何申请由宿主注入的 plugin prompt 段说明。
   */
  private isSkillVisibleForPromptFeatures(
    skill: AgentSkillDefinition,
    selectedSkillIds: ReadonlySet<string>,
    promptFeatures: ReadonlySet<ChatPromptFeatureId>
  ): boolean {
    const requiredFeatures = skill.autoInjectPromptFeatures ?? []
    if (isEmpty(requiredFeatures) || selectedSkillIds.has(skill.id)) return true
    return requiredFeatures.some((feature) => promptFeatures.has(feature))
  }

  /**
   * 显式选中的技能查找:跳过空间过滤(enabled/项目根精筛仍生效)。
   * capabilityScopes 的定位是收敛"泛化索引",不是权限;用户亲手选中的技能在任何空间都应可注入/可读。
   */
  private getDefinitionForRoleIgnoringSpace(
    roleId: AgentRoleId,
    skillId: string,
    resourceId?: LooseOptional<string>
  ): Nullable<AgentSkillDefinition> {
    if (!this.roleSkillIds.get(roleId)?.has(skillId)) return null
    const skill = this.skillsById.get(skillId)
    if (!skill || isFalse(skill.enabled)) return null
    if (!this.isSkillVisibleForResource(skill, resourceId)) return null
    return skill
  }

  /** 项目级技能根级精筛：只在会话活跃根等于其来源项目根时可见（多项目互不泄漏）。 */
  private isSkillVisibleForResource(
    skill: AgentSkillDefinition,
    resourceId?: LooseOptional<string>
  ): boolean {
    if (!skill.sourceResourceId) return true
    if (!resourceId?.trim()) return false
    return resourceId.trim() === skill.sourceResourceId.trim()
  }

  private isSkillVisibleInScope(
    skill: AgentSkillDefinition,
    capabilityScope?: CapabilityScopeId
  ): boolean {
    const allowedSpaces = skill.capabilityScopes ?? []
    if (isEmpty(allowedSpaces)) return true
    if (!capabilityScope) return true
    return allowedSpaces.includes(capabilityScope)
  }

  private hasAutoInjectPromptFeature(
    skill: AgentSkillDefinition,
    promptFeatures: ReadonlySet<ChatPromptFeatureId>
  ): boolean {
    return !!skill.autoInjectPromptFeatures?.some((feature) => promptFeatures.has(feature))
  }

  private shouldInjectFullMarkdown(skill: AgentSkillDefinition): boolean {
    // 只有**受信任供应方**产出的角色身份技能注入全文常驻；能力技能一律走 skill:<id> 指针，
    // 正文按需 tooling:read。声明 role 但来源未盖章 = 按 capability 处理（静默降级，
    // 不抛错：一条技能的档位声明错了不该让整个技能库不可用）。
    return skill.skillKind === 'role' && this.trustedRoleSkillProviderIds.has(skill.sourceId)
  }

  private formatLinkedSkillPrompt(
    skills: readonly AgentSkillDefinition[],
    selected: ReadonlySet<string> = new Set()
  ): string {
    if (isEmpty(skills)) return ''

    const formatLine = (skill: AgentSkillDefinition): string => {
      const description = skill.description?.replace(/\s+/gu, ' ').trim()
      return description
        ? `- skill:${skill.id}：${skill.label}。${description}`
        : `- skill:${skill.id}：${skill.label}`
    }
    const selectedSkills = skills.filter((skill) => selected.has(skill.id))
    const matchedSkills = skills.filter((skill) => !selected.has(skill.id))

    const lines = ['# 命中 Skill']
    if (!isEmpty(selectedSkills)) {
      // 用户显式选中 ≠ 泛化命中：选中即指令，回答前必须先读并遵循——措辞太软会被模型自主裁量跳过。
      lines.push(
        '',
        '用户为本次请求**显式选择**了以下 Skill。开始实质回答前必须先用 tooling:read 读取其正文并严格遵循（读取已免确认）：',
        ...selectedSkills.map(formatLine)
      )
    }
    if (!isEmpty(matchedSkills)) {
      lines.push(
        '',
        '以下 Skill 与当前请求匹配，正文不直接注入；需要时调用 tooling:read 读取：',
        ...matchedSkills.map(formatLine)
      )
    }

    lines.push('', '读取格式：tooling:read({ ids: ["skill:<id>"], detail: "full" })')
    return lines.join('\n')
  }

  private toDescriptor(skill: AgentSkillDefinition): AgentSkillDescriptor {
    const {
      markdown: _markdown,
      skillKind: _skillKind,
      autoInjectPromptFeatures: _autoInjectPromptFeatures,
      enabled: _enabled,
      capabilityScopes: _capabilityScopes,
      ...descriptor
    } = skill
    return descriptor
  }
}

export { AgentSkillRepository }
