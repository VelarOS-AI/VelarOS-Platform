import type {
  ChatContextBudgetLaneDefinition,
  ChatContextBudgetLaneId,
  ChatContextPipelineProfileId,
  ChatContextPipelineRun,
  ChatContextPipelineStageId,
} from '@velaros-ai/core/types'

type ContextPipelineProfileId = ChatContextPipelineProfileId
type ContextPipelineStageId = ChatContextPipelineStageId
type ContextBudgetLaneId = ChatContextBudgetLaneId

interface ContextPipelineStageDefinition {
  id: ContextPipelineStageId
  required: boolean
  label: string
  description: string
}

type ContextBudgetLaneDefinition = ChatContextBudgetLaneDefinition

interface ContextPipelineDefinition {
  profile: ContextPipelineProfileId
  label: string
  description: string
  stages: ContextPipelineStageDefinition[]
  budgetLanes: ContextBudgetLaneDefinition[]
  notes: string[]
}

interface ContextPipelineProfileDefinition {
  id: ContextPipelineProfileId
  label: string
  description: string
  stageIds?: ContextPipelineStageId[]
  requiredStageOverrides?: Partial<Record<ContextPipelineStageId, boolean>>
  budgetLaneOverrides?: Partial<Record<ContextBudgetLaneId, Partial<ContextBudgetLaneDefinition>>>
  notes?: string[]
}

const DefaultContextPipelineStageDefinitions: ContextPipelineStageDefinition[] = [
  {
    id: 'usage-telemetry',
    required: true,
    label: '用量遥测',
    description: '解析 provider 用量、预检计数、本地估算和成本置信度。',
  },
  {
    id: 'task-boundary',
    required: true,
    label: '任务边界',
    description: '压缩等到整轮执行结束后再变更视图，避免打断在跑的模型任务。',
  },
  {
    id: 'intent-snapshot',
    required: true,
    label: '意图快照',
    description: '捕获最近的用户意图、当前计划、资源状态、错误与验证情况。',
  },
  {
    id: 'active-anchor',
    required: true,
    label: '活动锚点',
    description: '保护超出对话历史范围的长期计划、决定与需求。',
  },
  {
    id: 'work-route-evidence',
    required: true,
    label: '查改证据',
    description: '把"读再改"的证据保持新鲜，并与编辑动作隔离开。',
  },
  {
    id: 'pinned-evidence',
    required: true,
    label: '置顶证据',
    description: '当前执行中的文件读取、diff、命令结果与验证失败保留在上下文内。',
  },
  {
    id: 'sanitizer',
    required: true,
    label: '净化器',
    description: '把非核心的长输出搬到载荷存储，关键摘录留在上下文里。',
  },
  {
    id: 'intent-relevance-rank',
    required: true,
    label: '意图相关性打分',
    description: '按时间、路径重叠、与当前计划的关系、错误与工具噪声给历史打分。',
  },
  {
    id: 'retention-planner',
    required: true,
    label: '保留策略',
    description: '为每个区段选择保留完整、保留要点、摘要、只留引用或丢弃。',
  },
  {
    id: 'dynamic-discovery',
    required: false,
    label: '动态发现',
    description: '暴露检索句柄而不是主动重放大块旧上下文。',
  },
  {
    id: 'summary-assembler',
    required: true,
    label: '摘要组装',
    description: '围绕当前目标、决定、风险与文件组装短小的派生视图。',
  },
  {
    id: 'persist-view',
    required: true,
    label: '视图持久化',
    description: '存储会话级派生上下文视图，带回滚元数据与调试轨迹。',
  },
]

const DefaultContextBudgetLanes: ContextBudgetLaneDefinition[] = [
  { id: 'system-tools', priority: 100, minPercent: 8, maxPercent: 18 },
  { id: 'active-context', priority: 95, minPercent: 4, maxPercent: 10 },
  { id: 'pinned-evidence', priority: 90, minPercent: 8, maxPercent: 24 },
  { id: 'recent-turns', priority: 80, minPercent: 18, maxPercent: 34 },
  { id: 'summary', priority: 60, minPercent: 4, maxPercent: 12 },
  { id: 'retrieval-handles', priority: 45, minPercent: 2, maxPercent: 8 },
  { id: 'output-reserve', priority: 40, minPercent: 12, maxPercent: 24 },
]

const DefaultProfileDefinitions: ContextPipelineProfileDefinition[] = [
  {
    id: 'pre-send-discovery',
    label: '发送前发现',
    description: '在调用模型前只构建必要的小型句柄集合。',
    stageIds: [
      'usage-telemetry',
      'intent-snapshot',
      'active-anchor',
      'work-route-evidence',
      'dynamic-discovery',
    ],
    requiredStageOverrides: {
      'dynamic-discovery': true,
    },
    budgetLaneOverrides: {
      'recent-turns': { minPercent: 10, maxPercent: 22 },
      'retrieval-handles': { minPercent: 6, maxPercent: 14 },
      summary: { minPercent: 2, maxPercent: 6 },
    },
    notes: ['发送前发现保持静态上下文短小，优先使用检索句柄。'],
  },
  {
    id: 'post-run-cleanup',
    label: '执行后清理',
    description: '在一次执行结束后对会话上下文做清理与版本化。',
    requiredStageOverrides: {
      'dynamic-discovery': true,
    },
    notes: ['执行后清理可以持久化新视图，因为模型任务已经结束。'],
  },
  {
    id: 'auto-conservative',
    label: '自动保守',
    description: '80% 自动护栏：先保护当前执行的证据，再裁剪历史。',
    budgetLaneOverrides: {
      'pinned-evidence': { minPercent: 12, maxPercent: 30 },
    },
    notes: ['自动压缩从大约 80% 开始触发，证据安全优先于历史广度。'],
  },
  {
    id: 'team-worker-minimal',
    label: '团队 worker 精简',
    description: '小型 worker 视图，靠句柄和活动锚点替代父级完整历史。',
    requiredStageOverrides: {
      'dynamic-discovery': true,
      'summary-assembler': false,
    },
    budgetLaneOverrides: {
      'active-context': { minPercent: 3, maxPercent: 8 },
      'recent-turns': { minPercent: 12, maxPercent: 24 },
      'retrieval-handles': { minPercent: 6, maxPercent: 16 },
    },
    notes: ['worker 视图应从窄起步，只在需要时再发现父级上下文。'],
  },
  {
    id: 'recovery-safe',
    label: '恢复安全',
    description: '为失败或恢复的会话准备的保守恢复 profile。',
    requiredStageOverrides: {
      'dynamic-discovery': true,
    },
    budgetLaneOverrides: {
      'pinned-evidence': { minPercent: 14, maxPercent: 32 },
      'recent-turns': { minPercent: 20, maxPercent: 36 },
    },
    notes: ['恢复视图偏向新鲜证据、验证失败信息与回滚元数据。'],
  },
]

class ContextPipelineFactory {
  private readonly stageRegistry = new Map<ContextPipelineStageId, ContextPipelineStageDefinition>()
  private readonly profileRegistry = new Map<
    ContextPipelineProfileId,
    ContextPipelineProfileDefinition
  >()

  constructor() {
    DefaultContextPipelineStageDefinitions.forEach((stage) => this.registerStage(stage))
    DefaultProfileDefinitions.forEach((profile) => this.registerProfile(profile))
  }

  public registerStage(stage: ContextPipelineStageDefinition): void {
    this.stageRegistry.set(stage.id, stage)
  }

  public registerProfile(profile: ContextPipelineProfileDefinition): void {
    this.profileRegistry.set(profile.id, profile)
  }

  public listProfiles(): ContextPipelineProfileDefinition[] {
    return [...this.profileRegistry.values()]
  }

  public create(profile: ContextPipelineProfileId): ContextPipelineDefinition {
    const definition = this.profileRegistry.get(profile)
    if (!definition) {
      throw new Error(`Unknown Context OS pipeline profile: ${profile}`)
    }

    return {
      profile,
      label: definition.label,
      description: definition.description,
      stages: this.createStages(definition),
      budgetLanes: this.createBudgetLanes(definition),
      notes: definition.notes ?? [],
    }
  }

  public createRun(
    profile: ContextPipelineProfileId,
    input: {
      completedStages?: ContextPipelineStageId[]
      skippedStages?: Partial<Record<ContextPipelineStageId, string>>
      notes?: string[]
    } = {}
  ): ChatContextPipelineRun {
    const definition = this.create(profile)
    const completedStages = new Set(input.completedStages ?? [])
    const skippedStages = input.skippedStages ?? {}

    return {
      profile,
      stages: definition.stages.map((stage) => {
        const skippedReason = skippedStages[stage.id]
        if (skippedReason) return {
            id: stage.id,
            required: stage.required,
            status: 'skipped',
            reason: skippedReason,
          }

        return {
          id: stage.id,
          required: stage.required,
          status: completedStages.has(stage.id) ? 'completed' : 'pending',
          reason: null,
        }
      }),
      budgetLanes: definition.budgetLanes,
      notes: [...definition.notes, ...(input.notes ?? [])],
    }
  }

  private createStages(
    profile: ContextPipelineProfileDefinition
  ): ContextPipelineStageDefinition[] {
    const stageIds = profile.stageIds ?? DefaultContextPipelineStageDefinitions.map((stage) => stage.id)
    return stageIds.map((id) => {
      const stage = this.stageRegistry.get(id)
      if (!stage) {
        throw new Error(`Unknown Context OS pipeline stage: ${id}`)
      }

      return {
        ...stage,
        required: profile.requiredStageOverrides?.[id] ?? stage.required,
      }
    })
  }

  private createBudgetLanes(
    profile: ContextPipelineProfileDefinition
  ): ContextBudgetLaneDefinition[] {
    return DefaultContextBudgetLanes.map((lane) => ({
      ...lane,
      ...(profile.budgetLaneOverrides?.[lane.id] ?? {}),
    })).sort((left, right) => right.priority - left.priority)
  }
}

const contextPipelineFactory = new ContextPipelineFactory()

export {
  ContextPipelineFactory,
  contextPipelineFactory,
}
export type {
  ContextBudgetLaneDefinition,
  ContextBudgetLaneId,
  ContextPipelineDefinition,
  ContextPipelineProfileDefinition,
  ContextPipelineProfileId,
  ContextPipelineStageDefinition,
  ContextPipelineStageId,
}
