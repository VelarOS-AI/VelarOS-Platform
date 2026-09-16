import { isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { GoalConstraint, GoalStep, GoalUpdateRequest } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { describeGoalStepRefsForModel } from '../../utils/builtin/goal-schemas'
import { applyGoalUpdate, buildGoalUpsertInput, completeGoalStep, hasGoalUpdateChange, projectGoalRead, readCurrentGoalArtifact, resolveGoalNextSteps, toGoalSnapshot } from '../../utils/builtin/goals'

/**
 * 目标三个工具（`goal:get` / `goal:create` / `goal:update`）的执行面。
 *
 * 目标存在活动上下文的 requirement 条目里，同一会话同一时刻只允许一个活动目标。
 * 整个进程一份，自身不持有状态：每次都从工具上下文现读现写。
 */
export interface GoalOperationsApi {
  /** 读当前目标；没有目标时返回 `status:'none'`，不报错。与 `update` 的空调用同一条路。 */
  read(ctx: KernelToolContext): Promise<unknown>
  /**
   * 建立当前目标。
   *
   * 已经有活动目标时不覆盖，原样回带并标 `reused:true`——重复创建是幂等读取。
   */
  create(
    input: { objective: string; token_budget?: number; steps?: GoalStep[]; constraints?: GoalConstraint[] },
    ctx: KernelToolContext
  ): Promise<unknown>
  /**
   * 更新当前目标的内容、步骤、约束或生命周期。
   *
   * 所有字段都不传就是一次读取：没有目标时回 `status:'none'`，也不报错。真要改而没有可改的目标
   * （从没建过、或已终态）时抛 `VALIDATION`。
   * `status=complete` 会把还没收尾的 pending/in_progress 步骤一并标完成，failed 步骤仍会拦住收尾。
   */
  update(input: GoalUpdateRequest, ctx: KernelToolContext): Promise<unknown>
}

class GoalOperations implements GoalOperationsApi {
  public async read(ctx: KernelToolContext): Promise<unknown> {
    return projectGoalRead(await readCurrentGoalArtifact(ctx.activeContext))
  }

  public async create(
    input: { objective: string; token_budget?: number; steps?: GoalStep[]; constraints?: GoalConstraint[] },
    ctx: KernelToolContext
  ): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    const current = await readCurrentGoalArtifact(ctx.activeContext)
    if (current && toGoalSnapshot(current).status === 'active') {
      const goal = toGoalSnapshot(current)
      return {
        status: goal.status,
        goal,
        reused: true,
        nextAction: '已经有一个活动目标，这次没有覆盖它。要改或要收尾请用 goal:update。',
      }
    }

    const artifact = await ctx.activeContext.upsertActiveContextArtifact(
      buildGoalUpsertInput({
        objective: input.objective.trim(),
        tokenBudget: input.token_budget,
        steps: input.steps,
        constraints: input.constraints,
        now: Date.now(),
      })
    )
    const goal = toGoalSnapshot(artifact)

    return { status: goal.status, goal }
  }

  public async update(input: GoalUpdateRequest, ctx: KernelToolContext): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    const artifact = await readCurrentGoalArtifact(ctx.activeContext)

    // 空调用 = 读取：没有目标时也照样答「没有」，不报错——读一件不存在的东西不是错误。
    if (!hasGoalUpdateChange(input)) return projectGoalRead(artifact)

    const currentStatus = artifact ? toGoalSnapshot(artifact).status : null
    if (!artifact || (currentStatus !== 'active' && currentStatus !== 'paused')) {
      throw new AppError('VALIDATION', '当前没有进行中的目标可以更新：本会话要么从没建过目标，要么已有目标已经完成或被放弃。先用 goal:create 建一个新目标。')
    }

    // 基线步骤:传了 steps 就用它重建,否则沿用当前;complete_step 可与 steps 组合(先重建再完成)。
    const hasSteps = isPresent(input.steps)
    const baseSteps: GoalStep[] = hasSteps ? input.steps! : [...toGoalSnapshot(artifact).steps]
    const stepCompletion = isPresent(input.complete_step)
      ? completeGoalStep(baseSteps, input.complete_step!)
      : null
    const nextSteps = resolveGoalNextSteps(input, artifact, stepCompletion ? [...stepCompletion.steps] : hasSteps ? baseSteps : undefined)
    const goal = await applyGoalUpdate(input, ctx.activeContext, artifact, nextSteps)

    return {
      status: goal.status,
      goal,
      steps: describeGoalStepRefsForModel(goal.steps),
      completedStep: toNullable(stepCompletion?.completedStep),
      promotedStep: toNullable(stepCompletion?.promotedStep),
      allStepsResolved: toNullable(stepCompletion?.allStepsResolved),
      nextAction: stepCompletion
        ? stepCompletion.allStepsResolved
          ? '目标的步骤已经全部有了结论。如果目标确实达成了，调用 goal:update({status:"complete"}) 收尾。'
          : '继续做当前这个目标步骤。'
        : null,
      finalTokenUsage: null,
    }
  }

}

/** 进程内唯一一份目标执行面；工具文件按它一行委托。 */
export const goalOperations: GoalOperationsApi = new GoalOperations()
