import { isEmpty } from '@velaros-ai/core'
import type {
  AgentRoleId,
  ExecutionTaskPlanStep,
  ExecutionTaskPlanStepStatus,
  ExecutionTaskRecord,
  ToolExecutionPlanItemStatus,
  ToolExecutionPlanUpdate,
} from '@velaros-ai/core/types'

import {
  type ExecutionIdFactory,
  MonotonicExecutionIdFactory,
} from './ExecutionIdFactory'
import type { ExecRouting } from './routing'

type PlanChangePayload = Record<string, unknown> & {
  stepCount: number
  addedStepIds: string[]
  removedStepIds: string[]
  statusChangedSteps: Array<{
    id: string
    title: string
    previousStatus: ExecutionTaskPlanStepStatus
    status: ExecutionTaskPlanStepStatus
  }>
}

/**
 * 执行计划账本辅助器。
 *
 * 处理两类计划演化：
 * 1. 角色 turn 上下文带来的“workflow 默认计划”，需要保留已有步骤的状态进行合并。
 * 2. 工具/UI 主动提交的“手动计划”，需要把新增/重写步骤归到当前角色并保留可识别的 id。
 *
 * 还负责生成 plan-updated 事件需要的 diff payload（新增/删除/状态变化的步骤集合）。
 */
class ExecPlanLedger {
  constructor(
    private readonly routingCoordinator: ExecRouting,
    private readonly idFactory: ExecutionIdFactory = new MonotonicExecutionIdFactory(),
  ) {}

  /**
   * 合并 workflow 默认计划与现有计划。
   *
   * 现有步骤的状态优先：避免角色切换重置已完成/委派步骤；新增步骤按 nextPlan 出现顺序补入。
   */
  public mergeExecutionPlan(
    currentPlan: ExecutionTaskPlanStep[],
    nextPlan: ExecutionTaskPlanStep[],
  ): ExecutionTaskPlanStep[] {
    if (isEmpty(currentPlan)) return nextPlan

    if (isEmpty(nextPlan)) return currentPlan

    // 模型已经用 plan:update 亲手写了计划:scaffold 默认计划只是角色占位,不得再把它覆盖回去。
    // (历史 bug:每个 turn 的 updateRole 都会用单步 operator-execute 冲掉模型的多步计划,
    //  导致 complete_step 永远匹配不到步骤、计划模式陷入死循环。)
    if (currentPlan.some((step) => step.origin === 'manual')) return this.routingCoordinator.refreshExecutionPlan(currentPlan)

    const currentById = new Map(currentPlan.map((step) => [step.id, step]))
    return this.routingCoordinator.refreshExecutionPlan(nextPlan.map((step) => {
      const existing = currentById.get(step.id)
      return existing
        ? {
          ...step,
          status: existing.status,
          taskId: existing.taskId,
          updatedAt: existing.updatedAt,
        }
        : step
    }))
  }

  public buildManualExecutionPlan(
    currentPlan: ExecutionTaskPlanStep[],
    input: ToolExecutionPlanUpdate,
    defaults: {
      now: number
      roleId: AgentRoleId
      kind: ExecutionTaskPlanStep['kind']
    },
  ): ExecutionTaskPlanStep[] {
    const currentById = new Map(currentPlan.map((step) => [step.id, step]))
    const currentByTitle = new Map(
      currentPlan.map((step) => [this.normalizePlanTitle(step.title), step])
    )
    const usedIds = new Set<string>()

    return input.plan.map((item) => {
      const title = item.step.trim()
      const existingStep = item.id
        ? currentById.get(item.id.trim()) ?? currentByTitle.get(this.normalizePlanTitle(title))
        : currentByTitle.get(this.normalizePlanTitle(title))
      const id = this.resolveManualPlanStepId(item.id, title, existingStep, usedIds)

      return {
        id,
        title,
        roleId: item.roleId ?? existingStep?.roleId ?? defaults.roleId,
        objective: item.objective?.trim() || existingStep?.objective || title,
        kind: item.kind ?? existingStep?.kind ?? defaults.kind,
        mode: item.mode ?? existingStep?.mode ?? 'self',
        required: item.required ?? existingStep?.required ?? true,
        dependsOn: item.dependsOn ?? existingStep?.dependsOn ?? [],
        actionable:!!existingStep?.actionable,
        status: this.toExecutionPlanStepStatus(item.status),
        taskId: null,
        updatedAt: defaults.now,
        // 模型经 plan:update 亲手写的步骤:标记 manual,让 mergeExecutionPlan 不被 scaffold 覆盖。
        origin: 'manual' as const,
      }
    })
  }

  public buildPlanChangePayload(
    previousPlan: ExecutionTaskPlanStep[],
    nextPlan: ExecutionTaskPlanStep[],
  ): PlanChangePayload {
    const previousById = new Map(previousPlan.map((step) => [step.id, step]))
    const nextById = new Map(nextPlan.map((step) => [step.id, step]))
    const addedStepIds = nextPlan
      .filter((step) => !previousById.has(step.id))
      .map((step) => step.id)
    const removedStepIds = previousPlan
      .filter((step) => !nextById.has(step.id))
      .map((step) => step.id)
    const statusChangedSteps = nextPlan
      .map((step) => {
        const previousStep = previousById.get(step.id)
        return previousStep && previousStep.status !== step.status
          ? {
            id: step.id,
            title: step.title,
            previousStatus: previousStep.status,
            status: step.status,
          }
          : null
      })
      .filter((step): step is PlanChangePayload['statusChangedSteps'][number] => !!step)

    return {
      stepCount: nextPlan.length,
      addedStepIds,
      removedStepIds,
      statusChangedSteps,
    }
  }

  public resolveManualPlanStepKind(task: ExecutionTaskRecord): ExecutionTaskPlanStep['kind'] {
    switch (task.workflowType) {
      case 'architecture-task':
        return 'synthesize'
      case 'coding-task':
        return 'implement'
      case 'system-task':
        return 'prepare'
      case 'chat':
      default:
        return 'respond'
    }
  }

  private resolveManualPlanStepId(
    explicitId: string | undefined,
    title: string,
    existingStep: ExecutionTaskPlanStep | undefined,
    usedIds: Set<string>,
  ): string {
    const candidates = [
      explicitId,
      existingStep?.id,
      this.slugifyPlanStepTitle(title),
    ]

    for (const candidate of candidates) {
      const normalized = candidate?.trim()
      if (normalized && !usedIds.has(normalized)) {
        usedIds.add(normalized)
        return normalized
      }
    }

    const generatedId = this.idFactory.createPlanStepId()
    usedIds.add(generatedId)
    return generatedId
  }

  private slugifyPlanStepTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
  }

  private normalizePlanTitle(title: string): string {
    return title.trim().replace(/\s+/g, ' ').toLowerCase()
  }

  private toExecutionPlanStepStatus(
    status: ToolExecutionPlanItemStatus,
  ): ExecutionTaskPlanStep['status'] {
    return status === 'in_progress' ? 'running' : status
  }
}

export { ExecPlanLedger }
export type { PlanChangePayload }
export { ExecPlanLedger as ExecutionPlanLedgerHelper }
