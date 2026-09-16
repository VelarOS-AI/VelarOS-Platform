import { isEmpty } from '@velaros-ai/core'

import type { ExecutionIdFactory } from '../../contract/requires.js'
import type { AgentRoleId, ExecutionTaskPlanStep, ExecutionTaskRecord, ToolExecutionPlanUpdate } from '../../types/agent'
import type { PlanChangePayload } from '../../types/records.js'
import { normalizePlanTitle, slugifyPlanStepTitle, toExecutionPlanStepStatus } from '../../utils/records/plan-steps'

import type { ExecRoutingApi } from './ExecRouting'
import { MonotonicExecutionIdFactory } from './MonotonicExecutionIdFactory'

/**
 * 执行计划的算法面：只负责算出「新的计划长什么样」和「跟上一版差在哪」，不碰账本，也不发事件，
 * 调用方（`ExecutionRecords`）拿到结果再决定怎么落。
 *
 * 两类计划来源要区别对待：角色 turn 带进来的 workflow 默认计划（scaffold）可以被合并，
 * 模型经 `plan:update` 亲手写的步骤打 `origin: 'manual'`，永远不许被 scaffold 覆盖回去。
 * 实现是 `ExecPlanLedger`（对外别名 `ExecutionPlanLedgerHelper`），无状态，步骤 id 由注入的 `ExecutionIdFactory` 兜底生成。
 */
export interface ExecPlanLedgerApi {
  /** 把 workflow 默认计划合进现有计划：任一边为空就用另一边；现有计划里只要有 `manual` 步骤就整份保留（只刷状态），否则按 nextPlan 的顺序重建，同 id 步骤沿用旧的 status / taskId / updatedAt，避免换角色把已完成、已委派的步骤打回原形。 */
  mergeExecutionPlan(currentPlan: ExecutionTaskPlanStep[], nextPlan: ExecutionTaskPlanStep[]): ExecutionTaskPlanStep[]
  /** 把模型或界面提交的一份计划翻成步骤数组：步骤 id 依次取「显式 id → 同标题旧步骤的 id → 标题转的 slug → 工厂生成」，同一份里保证不重号；没填的角色、目标、类型等字段按旧步骤、再按 `defaults` 兜底；结果全部打 `origin: 'manual'`。 */
  buildManualExecutionPlan(currentPlan: ExecutionTaskPlanStep[], input: ToolExecutionPlanUpdate, defaults: {
    /** 这批步骤统一的 `updatedAt` 时间戳（毫秒）；由调用方传，保证同一次改动的时间一致。 */
    now: number
    /** 步骤没指定角色时归给谁，通常是当前这一轮的角色。 */
    roleId: AgentRoleId
    /** 步骤没指定类型时算哪种，通常由 `resolveManualPlanStepKind` 按任务的 workflowType 得出。 */
    kind: ExecutionTaskPlanStep['kind']
  }): ExecutionTaskPlanStep[]
  /** 比两版计划，算出 `plan-updated` 事件要的 diff：新增、删除的步骤 id，以及状态变过的步骤（带改前改后的 status）。只比 id 和 status，不比标题改动。 */
  buildPlanChangePayload(previousPlan: ExecutionTaskPlanStep[], nextPlan: ExecutionTaskPlanStep[]): PlanChangePayload
  /** 按任务的 workflowType 给手写步骤定一个默认类型：architecture-task=synthesize，coding-task=implement，system-task=prepare，其余（含 chat）=respond。 */
  resolveManualPlanStepKind(task: ExecutionTaskRecord): ExecutionTaskPlanStep['kind']
}

class ExecPlanLedger implements ExecPlanLedgerApi {
  constructor(
    private readonly routingCoordinator: ExecRoutingApi,
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
      currentPlan.map((step) => [normalizePlanTitle(step.title), step])
    )
    const usedIds = new Set<string>()

    return input.plan.map((item) => {
      const title = item.step.trim()
      const existingStep = item.id
        ? currentById.get(item.id.trim()) ?? currentByTitle.get(normalizePlanTitle(title))
        : currentByTitle.get(normalizePlanTitle(title))
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
        status: toExecutionPlanStepStatus(item.status),
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
    explicitId: Optional<string>,
    title: string,
    existingStep: Optional<ExecutionTaskPlanStep>,
    usedIds: Set<string>,
  ): string {
    const candidates = [
      explicitId,
      existingStep?.id,
      slugifyPlanStepTitle(title),
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
}

export { ExecPlanLedger }
export { ExecPlanLedger as ExecutionPlanLedgerHelper }

/** 建一份执行计划账本。 */
export function createExecutionPlanLedger(routingCoordinator: ExecRoutingApi, idFactory: ExecutionIdFactory = new MonotonicExecutionIdFactory()): ExecPlanLedgerApi {
  return new ExecPlanLedger(routingCoordinator, idFactory)
}
