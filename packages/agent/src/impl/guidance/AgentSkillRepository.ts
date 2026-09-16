import { isFalse, isPresent, toNullable } from '@velaros-ai/core'

import type { AgentSkillProvider } from '../../contract/requires.js'
import type { ChatPromptFeatureId } from '../../types/agent'
import type { AgentRoleId, AgentSkillDescriptor,CapabilityScopeId } from '../../types/agent.js'
import type { AgentSkillDefinition } from '../../types/guidance.js'
import { formatLinkedSkillPrompt, toSkillDescriptor } from '../../utils/guidance/skill-index-prompt'
import { hasAutoInjectPromptFeature, isSkillVisibleForPromptFeatures, isSkillVisibleForResource, isSkillVisibleInScope } from '../../utils/guidance/skill-visibility'
import { compareStableStrings } from '../../utils/residency/determinism'

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

/**
 * 技能仓库对外的面：把内置 catalog、文件式技能等各路供应方聚成一张按角色可查的表，
 * 对外只给「这个角色现在能看见哪些技能」「这一轮往提示词里注什么」「按 id 读全文」三件事。
 *
 * 一份仓库归一条装配线持有，状态（技能表、角色索引、各供应方版本快照）全在实例内存里；
 * 每次对外查询前先比对供应方版本，变了才重载，供应方没实现 `getVersion` 就退回每次都重载。
 * 同 id 技能后注册者覆盖先注册者，顺序即供应方数组顺序。实现是 `AgentSkillRepository`。
 */
export interface AgentSkillRepositoryApi {
  /** 丢掉现有技能表，按供应方数组顺序全量重建，并记下这一次的各供应方版本快照。装配完或想强制刷新时调。 */
  reload(): void
  /**
   * 列出某角色此刻可见的技能 descriptor（不含全文），按 priority 升序、同优先级按 id 码元序排。
   * 走完整可见性漏斗（启用 → 空间作用域 → 资源根 → prompt feature），但不按选中过滤：
   * 模型据这张索引决定要不要 tooling:read 正文。
   */
  listSkillsForRole(
    roleId: AgentRoleId,
    selectedSkillIds?: string[],
    capabilityScope?: CapabilityScopeId,
    resourceId?: LooseOptional<string>,
    promptFeatures?: readonly ChatPromptFeatureId[]
  ): AgentSkillDescriptor[]
  /**
   * 生成这一轮要注入 system prompt 的技能段：受信任供应方的角色身份技能注入全文常驻，
   * 其余命中的只挂 `skill:<id>` 链接，正文按需 tooling:read。
   * 用户显式选中的技能即使不在当前空间的索引里也会被补挂进来（作用域收敛的是索引不是权限）。
   * 一条都没命中时返回空串。
   */
  getSkillMarkdownForRole(
    roleId: AgentRoleId,
    selectedSkillIds?: string[],
    promptFeatures?: readonly ChatPromptFeatureId[],
    capabilityScope?: CapabilityScopeId,
    resourceId?: LooseOptional<string>
  ): string
  /**
   * 按 id 读一条技能的完整定义，供 `tooling:read skill:<id>` 落地。角色可见即可读，不要求选中；
   * 显式选中的技能另有一条跳过空间过滤的逃生口——必须与注入侧同形，否则提示词让模型去读却读回 404。
   * id 空白、角色看不见、被禁用或资源根不匹配时返回 null。返回的是浅拷贝，调用方改它不影响仓库。
   */
  readSkillForRole(
    roleId: AgentRoleId,
    skillId: string,
    selectedSkillIds?: string[],
    capabilityScope?: CapabilityScopeId,
    resourceId?: LooseOptional<string>,
    promptFeatures?: readonly ChatPromptFeatureId[]
  ): Nullable<AgentSkillDefinition>
  /**
   * 读技能随附的资源文件，由它的来源供应方去落盘取，调用方不直接碰文件系统。
   * 只认这条技能 `resourcePaths` 里已经枚举过的路径，其余一律返回 null——防止拼路径越界读。
   */
  readSkillResource(skill: AgentSkillDefinition, resourcePath: string): Nullable<string>
}

class AgentSkillRepository implements AgentSkillRepositoryApi {
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
    ).map((skill) => toSkillDescriptor(skill))
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

      if (selected.has(skill.id) || hasAutoInjectPromptFeature(skill, featureSet)) {
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

    return [...fullMarkdown, formatLinkedSkillPrompt(linkedSkills, selected)]
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
      .filter((skill) => isSkillVisibleInScope(skill, capabilityScope))
      .filter((skill) => isSkillVisibleForResource(skill, resourceId))
      .filter((skill) =>
        isSkillVisibleForPromptFeatures(skill, selectedSkillIds, promptFeatures)
      )
      .sort((left, right) => left.priority - right.priority || compareStableStrings(left.id, right.id))
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
    if (!isSkillVisibleForResource(skill, resourceId)) return null
    return skill
  }

  private shouldInjectFullMarkdown(skill: AgentSkillDefinition): boolean {
    // 只有**受信任供应方**产出的角色身份技能注入全文常驻；能力技能一律走 skill:<id> 指针，
    // 正文按需 tooling:read。声明 role 但来源未盖章 = 按 capability 处理（静默降级，
    // 不抛错：一条技能的档位声明错了不该让整个技能库不可用）。
    return skill.skillKind === 'role' && this.trustedRoleSkillProviderIds.has(skill.sourceId)
  }
}

export { AgentSkillRepository }
