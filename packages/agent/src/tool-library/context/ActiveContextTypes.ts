import type {
  ActiveContextArchiveFilter,
  ActiveContextArtifact,
  ActiveContextGovernanceOptions,
  ActiveContextGovernanceReport,
  ActiveContextListOptions,
  ActiveContextUpsertInput,
} from '@velaros-ai/core/types'

/** 工具访问活跃上下文的 API。 */
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
