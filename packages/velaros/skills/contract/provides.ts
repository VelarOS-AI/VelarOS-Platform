import type { NodeRuntimeEnvironment } from '@velaros-ai/script'

import type { SkillActivation } from '../types/skills.js'

export type { SkillCapabilityModulesApi } from '../impl/SkillCapabilityModules.js'
export type { SkillRegistryApi } from '../impl/SkillRegistry.js'
export type { SkillSessionApi } from '../impl/SkillSession.js'
export type { SkillsOperationsApi } from '../impl/SkillsOperations.js'

/** 会话持有的环境租约，释放前安装文件和依赖保持可用。 */
export interface SkillEnvironmentLease {
  /** 已固定标准包解析和发现卡片的环境。 */
  readonly environment: NodeRuntimeEnvironment
  /** 本次环境选择的安装记录与能力授权。 */
  readonly skills: readonly SkillActivation[]
  /** 执行与所有子进程收束后幂等释放租约。 */
  release(): Promise<void>
}

export type { SkillCompositionApi } from '../impl/SkillComposition.js'
