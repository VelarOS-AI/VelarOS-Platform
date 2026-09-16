import { isPresent, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { GoalConstraint, GoalStep } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { describeGoalStepRefsForModel } from '../../utils/builtin/goal-schemas'
import { assertGoalCanComplete, buildGoalLifecycleUpsertInput, buildGoalStateUpsertInput, buildGoalUpsertInput, completeGoalStep, findCurrentGoalArtifact, toGoalSnapshot } from '../../utils/builtin/goals'

/** `goal:update` 的模型面入参：全部字段可省，全省就是一次读取。 */
export interface GoalUpdateRequest {
  /** 目标生命周期状态；不传时只更新内容字段。 */
  status?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled'
  /** 新的目标描述；省略则保留当前的。 */
  objective?: string
  /** 完整的步骤列表；传 [] 清空，省略则保留。 */
  steps?: GoalStep[]
  /** 要完成的那个步骤：1-based 序号或精确标题。 */
  complete_step?: string | number
  /** 完整的目标约束列表；传 [] 清空，省略则保留。 */
  constraints?: GoalConstraint[]
}

/**
 * 目标三个工具（`goal:get` / `goal:create` / `goal:update`）的执行面。
 *
 * 目标存在活动上下文的 requirement 条目里，同一会话同一时刻只允许一个活动目标。
 * 整个进程一份，自身不持有状态：每次都从工具上下文现读现写。
 */
export interface GoalOperationsApi {
  /** 读当前目标；没有目标时返回 `status:'none'`，不报错。 */
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
   * 所有字段都不传就是一次读取，不报错；没有可更新的目标（从没建过、或已终态）时抛 `VALIDATION`。
   * `status=complete` 会把还没收尾的 pending/in_progress 步骤一并标完成，failed 步骤仍会拦住收尾。
   */
  update(input: GoalUpdateRequest, ctx: KernelToolContext): Promise<unknown>
}

class GoalOperations implements GoalOperationsApi {
  /** 目标存在这一类活动上下文条目里。 */
  private static readonly GoalArtifactKinds = ['requirement'] as const

  public async read(ctx: KernelToolContext): Promise<unknown> {
    const artifact = await this.findGoalArtifact(ctx)
    const goal = artifact ? toGoalSnapshot(artifact) : null

    return { status: goal?.status ?? 'none', goal }
  }

  public async create(
    input: { objective: string; token_budget?: number; steps?: GoalStep[]; constraints?: GoalConstraint[] },
    ctx: KernelToolContext
  ): Promise<unknown> {
    ctx.abortSignal.throwIfAborted()
    const current = await this.findGoalArtifact(ctx)
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
    const artifact = await this.findGoalArtifact(ctx)
    const currentStatus = artifact ? toGoalSnapshot(artifact).status : null
    if (!artifact || (currentStatus !== 'active' && currentStatus !== 'paused')) {
      throw new AppError('VALIDATION', '当前没有进行中的目标可以更新：本会话要么从没建过目标，要么已有目标已经完成或被放弃。先用 goal:create 建一个新目标。')
    }

    // 空调用 = 无操作:回带当前目标状态,不报错(宽容)。
    if (!this.hasAnyChange(input)) {
      const goal = toGoalSnapshot(artifact)
      return {
        status: goal.status,
        goal,
        steps: describeGoalStepRefsForModel(goal.steps),
        noop: true,
      }
    }

    // 基线步骤:传了 steps 就用它重建,否则沿用当前;complete_step 可与 steps 组合(先重建再完成)。
    const hasSteps = isPresent(input.steps)
    const baseSteps: GoalStep[] = hasSteps ? input.steps! : [...toGoalSnapshot(artifact).steps]
    const stepCompletion = isPresent(input.complete_step)
      ? completeGoalStep(baseSteps, input.complete_step!)
      : null
    const nextSteps = this.resolveNextSteps(input, artifact, stepCompletion ? [...stepCompletion.steps] : hasSteps ? baseSteps : undefined)
    const goal = await this.applyUpdate(input, ctx, artifact, nextSteps)

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

  /** 从活动上下文里取当前目标条目。 */
  private async findGoalArtifact(ctx: KernelToolContext) {
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: [...GoalOperations.GoalArtifactKinds],
    })
    return findCurrentGoalArtifact(artifacts)
  }

  /** 这次调用有没有任何要改的东西；一件都没有就是读取。 */
  private hasAnyChange(input: GoalUpdateRequest): boolean {
    return !!input.status
      || isPresent(input.steps)
      || isPresent(input.complete_step)
      || !!input.objective
      || isPresent(input.constraints)
  }

  /**
   * 定出这次要写回的步骤列表。
   *
   * `status=complete` 时把还没收尾的 pending/in_progress 步骤自动标 completed：模型宣布目标完成
   * 即隐含这些步骤已做，不该因为没逐个 complete_step 就被拦（failed 步骤仍保留、由收尾门判定）。
   */
  private resolveNextSteps(
    input: GoalUpdateRequest,
    artifact: Parameters<typeof toGoalSnapshot>[0],
    steps: LooseOptional<GoalStep[]>
  ): LooseOptional<GoalStep[]> {
    if (input.status !== 'complete') return steps
    const source = steps ?? [...toGoalSnapshot(artifact).steps]
    return source.map((step) =>
      step.status === 'pending' || step.status === 'in_progress'
        ? { ...step, status: 'completed' as const }
        : step
    )
  }

  /** 先写内容再写生命周期：`complete` 前要过收尾门，过不了就抛，不会留下半个终态。 */
  private async applyUpdate(
    input: GoalUpdateRequest,
    ctx: KernelToolContext,
    artifact: Parameters<typeof toGoalSnapshot>[0],
    nextSteps: LooseOptional<GoalStep[]>
  ) {
    let currentArtifact = artifact
    if (input.objective || nextSteps || isPresent(input.constraints)) {
      currentArtifact = await ctx.activeContext.upsertActiveContextArtifact(
        buildGoalStateUpsertInput({
          artifact,
          objective: input.objective,
          steps: toOptional(nextSteps),
          constraints: input.constraints,
        })
      )
    }

    if (input.status === 'complete') assertGoalCanComplete(toGoalSnapshot(currentArtifact))
    const updatedArtifact = input.status
      ? await ctx.activeContext.upsertActiveContextArtifact(
          buildGoalLifecycleUpsertInput({
            artifact: currentArtifact,
            status: input.status,
            now: Date.now(),
          })
        )
      : currentArtifact
    return toGoalSnapshot(updatedArtifact)
  }
}

/** 进程内唯一一份目标执行面；工具文件按它一行委托。 */
export const goalOperations: GoalOperationsApi = new GoalOperations()
