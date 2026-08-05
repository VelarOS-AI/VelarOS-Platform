import type {
  ActiveContextArchiveFilter,
  ActiveContextArtifact,
  ActiveContextGovernanceOptions,
  ActiveContextGovernanceReport,
  ActiveContextListOptions,
  ActiveContextUpsertInput,
} from '@velaros-ai/agent/protocol'

/**
 * 工具访问**活跃上下文制品（Active Context artifacts）**的 API。
 *
 * **命名消歧（同名两物）**：本面的 `activeContext` 指 artifacts——由用户/模型显式登记、需要每轮
 * 完整注入的长效制品（需求、约束、待办清单等），生命周期只有 upsert / archive / 治理建议三个
 * 动词，权威存储在宿主的 `ActiveContextStore`。它**不是上下文治理（context governance）那一面**：
 * 治理讲的是驻留账本 / epoch / 准入 / 投影（`agent/context/residency/**`），管"历史正文这一轮
 * 怎么投影出去"，没有 artifacts 概念；本面反过来不参与任何预算或折叠决策，只保证"这几条东西
 * 一直在场"。`assessActiveContextGovernance` 里的 "governance" 同理是 artifacts 自己的整理建议，
 * 与治理器无关。真正改名牵动协议类型 + 存储 + IPC + 工具名，暂不在清理批范围内，因此这里只做
 * 注释消歧：**看到 `activeContext` 先确认是哪一面**。
 */
export interface ToolActiveContextApi {
  /** 列出仍需每轮完整注入的活跃上下文。 */
  listActiveContextArtifacts: (
    options?: ActiveContextListOptions
  ) => Promise<ActiveContextArtifact[]>
  /** 新增或更新活跃上下文。 */
  upsertActiveContextArtifact: (input: ActiveContextUpsertInput) => Promise<ActiveContextArtifact>
  /** 归档已完成、废弃或被用户意图切换取代的活跃上下文。 */
  archiveActiveContextArtifacts: (
    filter: ActiveContextArchiveFilter
  ) => Promise<ActiveContextArtifact[]>
  /** 生成治理建议；不会自动归档或删除任何活跃上下文。 */
  assessActiveContextGovernance: (
    options?: ActiveContextGovernanceOptions
  ) => Promise<ActiveContextGovernanceReport>
}
