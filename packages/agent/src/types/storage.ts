export type JsonObject = Record<string, unknown>

/** 当前会话可见历史的线性边界。 */
export interface SessionLineageContext {
  sessionId: string
  activeBranchId?: LooseOptional<string>
  visibleBranchIds?: string[]
  activeCheckpointId?: LooseOptional<string>
  cutoffTimestamp?: LooseOptional<number>
}

/**
 * 线性主线分支缺席时的规范兜底 id（timeline key 单源，P3-11）。
 *
 * 真实落盘数据的 `activeBranchId` 恒为 `main-<createdAt>`（见 renderer chatSessionFactories），`activeTimelineKey`
 * 恒为 `branch:main-<createdAt>`；本兜底只在 `activeBranchId` **缺席**时生效——取值 `main` **与落盘前缀兼容**，
 * 且与 renderer 持久化层的既有回落一致。曾三处分歧（renderer `'main'` / StateStore `'active'` / 镜像 `'active'`）
 * 收敛到本常量；镜像/读装配器/StateStore 一律派生，避免缺席时算出与 writer 不一致的 timeline key（查不到 active
 * timeline → 空镜像）。
 */
export const DEFAULT_ACTIVE_BRANCH_ID = 'main'

/** 线性主线 timeline key（`branch:` 前缀单源，P3-11）。 */
export function branchTimelineKey(branchId: string): string {
  return `branch:${branchId}`
}
