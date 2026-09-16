import { isEmpty, toNullable } from '@velaros-ai/core'

import { AgentToolNames } from '../../contract/constants.js'
import type { UpdatePlanInput } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import {
  completePlanSteps,
  describePlanStepRefsForModel,
  findPlanArtifact,
  formatActivePlanContent,
  hasPlanStepCompletion,
  hasPlanUpdateChange,
  PlanArtifactId,
  projectCurrentPlanRead,
  readPlanLifecycle,
  resolveNextPlanLifecycle,
  toUserPlanSteps,
} from '../../utils/builtin/plans'

/**
 * 计划两个工具（`plan:update` / `plan:get`）的执行面。
 *
 * 计划挂在当前 execution 上：界面读的是宿主交互端口里的那份，落盘的是活动上下文里的 `active-plan` 条目，
 * 两边在每次更新里一起写。整个进程一份，自身不持有状态。
 */
export interface PlanOperationsApi {
  /**
   * 更新当前 execution 的可见计划。
   *
   * 传完整 `plan` 就按它重建；`complete_step` 可与 `plan` 同传（先重建再完成引用的步骤）。
   * 什么都不传就是一次读取：回带当前计划、可引用步骤、任务、推荐动作与执行建议，不报错。
   */
  update(input: UpdatePlanInput, ctx: KernelToolContext): Promise<unknown>
  /** 读当前 execution 的计划、任务、推荐动作与执行建议。与 `update` 的空调用同一条路。 */
  read(ctx: KernelToolContext): Promise<unknown>
}

class PlanOperations implements PlanOperationsApi {
  /** 计划存在这一类活动上下文条目里。 */
  private static readonly PlanArtifactKinds = ['plan'] as const
  /** 计划条目没有变更说明时的标题。 */
  private static readonly DefaultPlanTitle = '当前执行计划'

  public async update(input: UpdatePlanInput, ctx: KernelToolContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    const interaction = ctx.interaction
    const previousPlan = interaction.getCurrentPlan()
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: [...PlanOperations.PlanArtifactKinds],
    })
    const previousLifecycle = readPlanLifecycle(artifacts, previousPlan, interaction.executionId)

    // 空调用 = 读取:回带当前计划、任务、推荐动作与执行建议,不报错。
    if (!hasPlanUpdateChange(input))
      return { updated: false, ...projectCurrentPlanRead(ctx.interaction, previousPlan, previousLifecycle) }

    // 基线列表:传了完整 plan 就用它重建,否则沿用旧计划。
    // complete_step 与 plan 可组合:先重建、再针对重建后的列表完成引用步骤。
    const basePlan = input.plan?.length ? input.plan : toUserPlanSteps(previousPlan)
    const stepCompletion = hasPlanStepCompletion(input)
      ? completePlanSteps(basePlan, input.complete_step!)
      : null
    const effectivePlan = stepCompletion ? stepCompletion.plan : basePlan

    if (isEmpty(effectivePlan))
      // 只更新 lifecycle/explanation 却没有任何步骤且无旧计划:无步骤可维护,回带当前(no-op)。
      return { updated: false, ...projectCurrentPlanRead(ctx.interaction, previousPlan, previousLifecycle) }

    return this.commitPlan(input, ctx, {
      effectivePlan,
      previousPlan,
      previousLifecycle,
      hasStoredPlanArtifact: !!findPlanArtifact(artifacts, interaction.executionId),
      stepCompletion,
    })
  }

  public async read(ctx: KernelToolContext): Promise<unknown> {
    const currentPlan = ctx.interaction.getCurrentPlan()
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: [...PlanOperations.PlanArtifactKinds],
    })
    const lifecycle = readPlanLifecycle(artifacts, currentPlan, ctx.interaction.executionId)
    return projectCurrentPlanRead(ctx.interaction, currentPlan, lifecycle)
  }




  /** 写界面上的计划与落盘条目，并定出这次之后的生命周期。 */
  private async commitPlan(
    input: UpdatePlanInput,
    ctx: KernelToolContext,
    state: {
      effectivePlan: ReturnType<typeof toUserPlanSteps>
      previousPlan: ReturnType<KernelToolContext['interaction']['getCurrentPlan']>
      previousLifecycle: ReturnType<typeof readPlanLifecycle>
      hasStoredPlanArtifact: boolean
      stepCompletion: Nullable<ReturnType<typeof completePlanSteps>>
    }
  ): Promise<unknown> {
    const interaction = ctx.interaction
    // 执行模式表示用户选择的工作方式。维护内部计划只更新任务进度，
    // 若同时启用旧计划开关，下一轮会错误报告用户要求计划模式，
    // 导致已经授权的工作被再次要求确认。
    const updateWithPlan = {
      explanation: input.explanation,
      lifecycle: input.lifecycle,
      plan: state.effectivePlan,
    }
    const plan = interaction.updateCurrentPlan(updateWithPlan)
    const lifecycle = resolveNextPlanLifecycle(input, updateWithPlan, state)
    await ctx.activeContext.upsertActiveContextArtifact({
      id: PlanArtifactId,
      kind: 'plan',
      scope: 'session',
      status:
        lifecycle === 'archived'
          ? 'archived'
          : lifecycle === 'completed'
            ? 'completed'
            : 'active',
      resourceId: null,
      title: input.explanation?.trim() || PlanOperations.DefaultPlanTitle,
      content: formatActivePlanContent(toNullable(input.explanation), plan),
      metadata: {
        source: AgentToolNames.planUpdate,
        planLifecycle: lifecycle,
        executionId: interaction.executionId,
        planStepCount: plan.length,
      },
    })

    return {
      updated: true,
      isInitialPlan: isEmpty(state.previousPlan) && !state.hasStoredPlanArtifact,
      activeContextStatus: lifecycle,
      explanation: toNullable(input.explanation),
      plan,
      // 显式回带每步的可引用 ref(1-based 序号)+标题+状态:下次 complete_step 直接照 ref 传,
      // 不必自己数数组位置、更不要自造 id(步骤没有 id)。
      steps: describePlanStepRefsForModel(plan),
      completedStep: toNullable(state.stepCompletion?.completedStep),
      completedSteps: state.stepCompletion?.completedSteps ?? [],
      promotedStep: toNullable(state.stepCompletion?.promotedStep),
      allStepsResolved: toNullable(state.stepCompletion?.allStepsResolved),
    }
  }

}

/** 进程内唯一一份计划执行面；工具文件按它一行委托。 */
export const planOperations: PlanOperationsApi = new PlanOperations()
