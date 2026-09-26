import { isUndefined, toNullable, toOptional } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  ContextBuildOptions,
  ContextCompletionPort,
  ContextViewOptions,
} from '../contract/requires.js'
import type { ContextCompletionResult } from '../types/context.js'
import type {
  ContextContent,
  ContextFeedback,
  ContextReadRange,
  ContextRecord,
  ContextRef,
  ContextSourceCard,
  ContextStepRecord,
  ContextTaskState,
  ContextTaskStatus,
  ContextViewLimits,
  ModelView,
  RegisteredViewIntent,
  TaskCapsule,
  ViewIntentInput,
} from '../types/context.js'
import type { ContextTaskMutation } from '../types/runtime.js'
import { contextFailure, emptyContextState, sameContextRef } from '../utils/state.js'
import { hourlyRetryMs, recentHourlyTokens, rolledHourly } from '../utils/usage.js'
import { awaitContextOperation, readContextTask, resolveViewLimits } from '../utils/view.js'
import { checkTaskCapsule, checkViewIntent } from '../utils/view-input.js'

import { ContextEvidenceBuilder } from './ContextEvidenceBuilder.js'

/** 绑定会话的任务检查点与证据视图，不另持有工具、模型或数据库。 */
export interface ContextViewApi {
  /** 列出已装配的证据源与其真实一致性能力。 */
  sources(): readonly ContextSourceCard[]
  /** 生效预算供共享模型网关使用。 */
  readonly limits: ContextViewLimits
  /** 读取持久检查点，包含真实阶段和用量。 */
  inspect(): Promise<Nullable<ContextTaskState>>
  /** 追加用户目标并取得一个有限租约，返回租约身份。 */
  begin(goal: ContextRef, signal?: AbortSignal, mode?: 'continue' | 'new'): Promise<string>
  /** 活动运行接收已归档的用户补充，保留总预算并使旧视图失效。 */
  appendGoal(goal: ContextRef, signal?: AbortSignal): Promise<void>
  /** 只有持有当前租约的运行可以开始下一步。 */
  startStep(
    executionId: string,
    signal?: AbortSignal,
    concurrent?: boolean,
    basis?: LooseOptional<ModelView>
  ): Promise<void>
  /** 通过当前执行登记下一轮观察需求。 */
  request(
    intent: ViewIntentInput,
    signal?: AbortSignal,
    executionId?: string
  ): Promise<RegisteredViewIntent>
  /** 模型只更新非事实性任务胶囊。 */
  updateCapsule(
    capsule: Partial<TaskCapsule>,
    signal?: AbortSignal,
    executionId?: string
  ): Promise<TaskCapsule>
  /** 保存中间材料到同一不可变对象存储，返回受会话范围保护的引用。 */
  putArtifact(
    body: string,
    sources?: readonly ContextRef[],
    signal?: AbortSignal,
    executionId?: string
  ): Promise<ContextRef>
  /** 按范围读取当前任务登记的材料。 */
  readArtifact(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent>
  /** 记录真实执行效果后进入物化屏障，取消终态不会被复活。 */
  settle(
    feedback: readonly ContextFeedback[],
    signal?: AbortSignal,
    step?: ContextStepRecord
  ): Promise<void>
  /** 在同一存储上只读组装候选，不发布视图也不要求执行租约。 */
  preview(options: ContextBuildOptions, signal?: AbortSignal): Promise<ModelView>
  /** 精确解析或按检索取候选后发布当前证据；重做本阶段不执行世界操作。 */
  build(options: ContextBuildOptions, signal?: AbortSignal): Promise<ModelView>
  /** 发送前复核任务、范围和资源版本。 */
  validate(view: ModelView, signal?: AbortSignal): Promise<boolean>
  /** 世界写入前核对当前执行身份与先前证据。 */
  assertCanWrite(executionId: string, signal?: AbortSignal): Promise<void>
  /** 在模型或后台任务等待时续期当前所有权，失去所有权则失败。 */
  renew(signal?: AbortSignal): Promise<void>
  /** 为主模型或搜索、整理会话预占调用与 token 预算。 */
  reserveModel(role: 'main' | 'context', tokens: number): Promise<void>
  /** 释放未实际发出的预留模型调用。 */
  releaseModel(role: 'main' | 'context', tokens: number): Promise<void>
  /** 保存供应商实际用量；缺少用量时保持未知计数。 */
  recordUsage(inputTokens: number, outputTokens: number): Promise<void>
  /** 依照证据缺口、新鲜度和领域验收器判断交付；效果不明的操作不挡交付，照实留在结算事实里。 */
  complete(verifier?: ContextCompletionPort, signal?: AbortSignal): Promise<ContextCompletionResult>
  /** 上次执行中断后，把按持久日志收拾出的结算事实合入检查点；不复活取消终态。 */
  recover(feedback: readonly ContextFeedback[]): Promise<void>
  /** 宿主保存结束或暂停阶段，撤销当前租约。 */
  end(status?: ContextTaskStatus): Promise<void>
}

/** 在既有存储的会话 CAS 上维护任务状态，世界效果以 Kernel 回执为准。 */
export class ContextViewSession implements ContextViewApi {
  public readonly limits: ContextViewLimits
  private leaseId?: string
  private building = false
  private readonly builder: ContextEvidenceBuilder

  public constructor(private readonly options: ContextViewOptions) {
    this.limits = resolveViewLimits(options.limits)
    this.builder = new ContextEvidenceBuilder(options)
  }

  public sources(): readonly ContextSourceCard[] {
    return this.options.sources.map((source) => ({
      id: source.id,
      capabilities: { ...source.capabilities },
    }))
  }

  public async inspect(): Promise<Nullable<ContextTaskState>> {
    const task = (
      await (this.options.storage.loadMetadata
        ? this.options.storage.loadMetadata(this.options.sessionId)
        : this.options.storage.load(this.options.sessionId))
    )?.task
    return task ? readContextTask(task) : null
  }

  public async begin(
    goal: ContextRef,
    signal?: AbortSignal,
    mode: 'continue' | 'new' = 'continue'
  ): Promise<string> {
    if (!['continue', 'new'].includes(mode)) throw contextFailure('TASK_MODE', '任务模式无效')
    const content = await this.options.context.read(goal)
    if (content.record.kind !== 'user')
      throw contextFailure('TASK_GOAL', '只有原始用户记录可以成为任务目标')
    const id = crypto.randomUUID()
    await this.change(
      {
        apply: (current) => {
          if (current?.lease && current.lease.expiresAt > Date.now())
            throw contextFailure('TASK_BUSY', '另一个运行持有任务租约')
          if (
            current?.status === 'executing' ||
            Object.keys(current?.activeExecutions ?? {}).length
          )
            throw contextFailure('TASK_INTERRUPTED', '上次执行被中断，先按持久日志收拾再开始')
          const revision = (current?.revision ?? 0) + 1
          const prior = mode === 'new' ? undefined : current
          return {
            ...prior,
            id: prior?.id ?? id,
            startedSequence:
              prior?.startedSequence ?? (mode === 'new' ? content.record.sequence - 1 : 0),
            revision,
            step: prior?.step ?? 0,
            status: 'ready',
            lease: { id, expiresAt: Date.now() + this.limits.leaseMs },
            goals: prior?.goals.some((ref) => sameContextRef(ref, goal))
              ? prior.goals
              : [...(prior?.goals ?? []), goal],
            capsule: prior?.capsule ?? {
              nextObjective: '',
              hypotheses: [],
              decisions: [],
              openQuestions: [],
            },
            activeExecutions: {},
            provenance: prior?.provenance ?? [],
            executionId: `initial:${id}`,
            intents: [],
            mandatory: prior?.mandatory ?? [],
            artifacts: prior?.artifacts ?? [],
            view: toNullable(prior?.view),
            usage: prior
              ? prior.usage
              : {
                  mainCalls: 0,
                  contextCalls: 0,
                  reservedTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  unmeasuredCalls: 0,
                },
            verification: 'unverified',
          }
        },
      },
      false,
      signal
    )
    this.leaseId = id
    return id
  }

  public async appendGoal(goal: ContextRef, signal?: AbortSignal): Promise<void> {
    const content = await this.options.context.read(goal)
    if (content.record.kind !== 'user')
      throw contextFailure('TASK_GOAL', '目标补充必须来自用户输入')
    await this.change(
      {
        apply: (current) => {
          const task = this.owned(current)
          return {
            ...task,
            revision: task.revision + 1,
            goals: task.goals.some((ref) => sameContextRef(ref, goal))
              ? task.goals
              : [...task.goals, goal],
            view: null,
            verification: 'unverified',
          }
        },
      },
      true,
      signal
    )
  }

  public async startStep(
    executionId: string,
    signal?: AbortSignal,
    concurrent = false,
    basis?: LooseOptional<ModelView>
  ): Promise<void> {
    if (!executionId) throw contextFailure('STEP_ID', '执行号不能为空')
    await this.change(
      {
        apply: (current) => {
          const task = this.owned(current)
          if (
            task.activeExecutions?.[executionId] ||
            ((task.status === 'executing' || Object.keys(task.activeExecutions ?? {}).length) &&
              !concurrent)
          )
            throw contextFailure('TASK_BUSY', '当前步骤尚未结束')
          return {
            ...task,
            revision: task.revision + 1,
            step: (task.step ?? 0) + 1,
            status: 'executing',
            executionId,
            activeExecutions: {
              ...task.activeExecutions,
              [executionId]: { view: isUndefined(basis) ? task.view : basis, concurrent },
            },
            intents: concurrent ? task.intents : [],
            verification: 'unverified',
          }
        },
      },
      true,
      signal
    )
  }

  public async request(
    intent: ViewIntentInput,
    signal?: AbortSignal,
    executionId?: string
  ): Promise<RegisteredViewIntent> {
    checkViewIntent(intent)
    if (
      intent.kind === 'direct' &&
      intent.target.kind === 'resource' &&
      intent.target.selector?.kind === 'lines' &&
      intent.target.selector.end < intent.target.selector.start
    )
      throw contextFailure('VIEW_SCHEMA', '行范围终点不能早于起点')
    const id = crypto.randomUUID()
    const task = await this.change(
      {
        apply: (current) => {
          const task = this.executing(current, executionId)
          if (task.intents.length >= this.limits.intents)
            throw contextFailure('INTENT_LIMIT', '观察需求超过本步上限')
          const next = { ...task, revision: task.revision + 1 }
          const registered: RegisteredViewIntent = {
            id,
            scope: { sessionId: this.options.sessionId, revision: next.revision },
            executionId: task.executionId!,
            request: structuredClone(intent),
          }
          return { ...next, intents: [...task.intents, registered] }
        },
      },
      true,
      signal
    )
    return task.intents.find((item) => item.id === id)!
  }

  public async updateCapsule(
    capsule: Partial<TaskCapsule>,
    signal?: AbortSignal,
    executionId?: string
  ): Promise<TaskCapsule> {
    checkTaskCapsule(capsule)
    return (
      await this.change(
        {
          apply: (current) => {
            const task = this.executing(current, executionId)
            return {
              ...task,
              revision: task.revision + 1,
              capsule: { ...task.capsule, ...structuredClone(capsule) },
            }
          },
        },
        true,
        signal
      )
    ).capsule
  }

  public async putArtifact(
    body: string,
    sources: readonly ContextRef[] = [],
    signal?: AbortSignal,
    executionId?: string
  ): Promise<ContextRef> {
    this.executing(toOptional(await this.inspect()), executionId)
    const record = await this.options.context.append(
      { kind: 'note', title: 'task:artifact', body, sources },
      signal
    )
    await this.change(
      {
        apply: (current) => {
          const task = this.executing(current, executionId)
          const resolved = sources.map((ref) => {
            const evidence = (
              task.activeExecutions?.[task.executionId]?.view ?? task.view
            )?.evidence.find((item) => sameContextRef(item.recovery, ref))
            const artifact = task.provenance?.find((item) => sameContextRef(item.ref, ref))
            return evidence
              ? { readSet: evidence.readSet, complete: evidence.complete }
              : (artifact ?? { readSet: [], complete: false })
          })
          const provenance = {
            ref: record.ref,
            readSet: resolved.flatMap((item) => item.readSet),
            complete: resolved.every((item) => item.complete),
          }
          return {
            ...task,
            revision: task.revision + 1,
            artifacts: [...task.artifacts, record.ref],
            provenance: [...(task.provenance ?? []), provenance],
          }
        },
      },
      true,
      signal
    )
    return record.ref
  }

  public async readArtifact(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent> {
    const task = await this.inspect()
    if (!task?.artifacts.some((item) => sameContextRef(item, ref)))
      throw contextFailure('SCOPE_MISMATCH', '材料不在当前任务中')
    return this.options.context.read(ref, range)
  }

  public async settle(
    feedback: readonly ContextFeedback[],
    signal?: AbortSignal,
    step?: ContextStepRecord
  ): Promise<void> {
    await this.change(
      {
        apply: (current) => {
          const task = this.executing(current, feedback[0]?.executionId)
          if (feedback.some((item) => item.executionId !== task.executionId))
            throw contextFailure('RECEIPT_SCOPE', '回执不属于当前执行')
          const mandatory = [
            ...task.mandatory.filter((old) => !feedback.some((item) => item.id === old.id)),
            ...structuredClone(feedback),
          ]
          const activeExecutions = Object.fromEntries(
            Object.entries(task.activeExecutions ?? {}).filter(([id]) => id !== task.executionId)
          )
          return {
            ...task,
            activeExecutions,
            revision: task.revision + 1,
            mandatory,
            lastStep: step ?? task.lastStep,
            status: !isEmpty(Object.keys(activeExecutions)) ? 'executing' : 'context-pending',
          }
        },
      },
      true,
      signal
    )
  }

  public async preview(
    options: ContextBuildOptions,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ModelView> {
    const task = await this.inspect()
    if (!task) throw contextFailure('TASK_STATE', '任务不存在')
    return this.builder.build(task, options, signal)
  }

  public async build(
    options: ContextBuildOptions,
    externalSignal: AbortSignal = new AbortController().signal
  ): Promise<ModelView> {
    if (this.building) throw contextFailure('TASK_BUSY', '物化已经在进行')
    if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1)
      throw contextFailure('VIEW_BUDGET', '视图预算必须为正整数')
    this.building = true
    const signal = AbortSignal.any([
      externalSignal,
      AbortSignal.timeout(this.limits.materializationMs),
    ])
    try {
      const task = this.owned(toOptional(await this.inspect()))
      if (
        task.status === 'executing' &&
        (!task.activeExecutions ||
          Object.values(task.activeExecutions).some((item) => !item.concurrent))
      )
        throw contextFailure('TASK_BUSY', '执行尚未结束')
      const view = await this.builder.build(task, options, signal)
      signal.throwIfAborted()
      if (!(await this.builder.validate(view, signal)))
        throw contextFailure('STALE_VIEW', '发布前资源版本或范围发生变化')
      await this.options.context.append(
        { kind: 'audit', title: 'context:model-view', body: JSON.stringify(view) },
        signal
      )
      await this.change(
        {
          apply: (current) => {
            const latest = this.owned(current)
            if (latest.revision !== task.revision)
              throw contextFailure('STALE_VIEW', '物化期间任务已变化')
            const old = latest.metrics ?? {
              views: 0,
              sourceReads: 0,
              sourceBytes: 0,
              searches: 0,
              durationMs: 0,
            }
            const metrics = {
              views: old.views + 1,
              sourceReads: old.sourceReads + view.metrics.sourceReads,
              sourceBytes: old.sourceBytes + view.metrics.sourceBytes,
              searches: old.searches + view.metrics.searches,
              durationMs: old.durationMs + view.metrics.durationMs,
            }
            return {
              ...latest,
              view,
              metrics,
              status: 'view-ready',
            }
          },
        },
        true,
        signal
      )
      return view
    } finally {
      this.building = false
    }
  }

  public async validate(
    view: ModelView,
    signal: AbortSignal = new AbortController().signal
  ): Promise<boolean> {
    const task = await this.inspect()
    return Boolean(
      task &&
      task.view?.id === view.id &&
      task.revision === view.scope.revision &&
      (task.status !== 'executing' ||
        Object.values(task.activeExecutions ?? {}).every((item) => item.concurrent)) &&
      (await this.builder.validate(view, signal))
    )
  }

  public async assertCanWrite(
    executionId: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
    signal.throwIfAborted()
    const task = this.executing(toOptional(await this.inspect()), executionId)
    if (task.executionId !== executionId) throw contextFailure('LEASE_LOST', '操作不属于当前执行')
    const basis = task.activeExecutions?.[executionId]?.view ?? task.view
    if (basis?.gaps.some((gap) => gap.required))
      throw contextFailure('REQUIRED_EVIDENCE_MISSING', '先补齐所需证据，再执行修改')
    if (basis && !(await this.builder.validate(basis, signal)))
      throw contextFailure('STALE_VIEW', '决策依赖的资源已经变化，请重新观察')
  }

  public async renew(signal?: AbortSignal): Promise<void> {
    await this.change({ apply: (current) => this.owned(current) }, true, signal)
  }

  public async reserveModel(role: 'main' | 'context', tokens: number): Promise<void> {
    if (!Number.isSafeInteger(tokens) || tokens < 1)
      throw contextFailure('MODEL_BUDGET', '模型预算无效')
    // 单次请求就超过每小时上限，等多久都放不进去
    if (tokens > this.limits.modelTokensPerHour)
      throw contextFailure('MODEL_BUDGET', '单次模型请求超过任务每小时用量上限')
    await this.change({
      apply: (current) => {
        const task = this.owned(current)
        const usage = task.usage
        if (
          usage.mainCalls + usage.contextCalls >= this.limits.modelCalls ||
          Math.max(usage.reservedTokens, usage.inputTokens + usage.outputTokens) + tokens >
            this.limits.modelTokens
        )
          throw contextFailure('MODEL_BUDGET', '任务共享模型预算耗尽')
        const now = Date.now()
        const hourly = rolledHourly(usage.hourly, now)
        if (recentHourlyTokens(hourly, now) + tokens > this.limits.modelTokensPerHour)
          throw AppError.withFields('MODEL_RATE', '任务每小时的模型用量已到上限，稍后继续', {
            retryAfterMs: hourlyRetryMs(hourly, tokens, this.limits.modelTokensPerHour, now),
          })
        return {
          ...task,
          usage: {
            ...usage,
            [role === 'main' ? 'mainCalls' : 'contextCalls']:
              usage[role === 'main' ? 'mainCalls' : 'contextCalls'] + 1,
            reservedTokens: usage.reservedTokens + tokens,
            unmeasuredCalls: usage.unmeasuredCalls + 1,
            hourly: { ...hourly, tokens: hourly.tokens + tokens },
          },
        }
      },
    })
  }

  public async releaseModel(role: 'main' | 'context', tokens: number): Promise<void> {
    if (!Number.isSafeInteger(tokens) || tokens < 1)
      throw contextFailure('MODEL_BUDGET', '预留预算无效')
    await this.change({
      apply: (current) => {
        const task = this.owned(current)
        const usage = task.usage
        const key = role === 'main' ? 'mainCalls' : 'contextCalls'
        return {
          ...task,
          usage: {
            ...usage,
            [key]: Math.max(0, usage[key] - 1),
            reservedTokens: Math.max(0, usage.reservedTokens - tokens),
            unmeasuredCalls: Math.max(0, usage.unmeasuredCalls - 1),
            // 没派发的预留从当前桶退回；跨了桶的部分随桶自然淡出
            hourly: usage.hourly
              ? { ...usage.hourly, tokens: Math.max(0, usage.hourly.tokens - tokens) }
              : undefined,
          },
        }
      },
    })
  }

  public async recordUsage(inputTokens: number, outputTokens: number): Promise<void> {
    if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw contextFailure('MODEL_USAGE', '供应商用量无效')
    await this.change({
      apply: (current) => {
        const task = this.owned(current)
        const usage = task.usage
        return {
          ...task,
          usage: {
            ...usage,
            inputTokens: usage.inputTokens + inputTokens,
            outputTokens: usage.outputTokens + outputTokens,
            unmeasuredCalls: Math.max(0, usage.unmeasuredCalls - 1),
          },
        }
      },
    })
  }

  public async complete(
    verifier?: ContextCompletionPort,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ContextCompletionResult> {
    const task = this.owned(toOptional(await this.inspect()))
    if (!isEmpty(Object.keys(task.activeExecutions ?? {})) || task.status === 'executing')
      return {
        completed: false,
        verified: false,
        reason: 'PENDING_EXECUTIONS',
        recovery: 'refresh',
      }
    if (!task.view || task.view.gaps.some((gap) => gap.required))
      return {
        completed: false,
        verified: false,
        reason: 'REQUIRED_EVIDENCE_MISSING',
        recovery: 'repair',
      }
    if (!(await this.validate(task.view, signal)))
      return { completed: false, verified: false, reason: 'STALE_VIEW', recovery: 'refresh' }
    const validation = verifier
      ? await awaitContextOperation(verifier.verify(task.view, signal), signal)
      : { verified: false, reason: '未配置领域验收器，结果为未验证交付' }
    if (!(await this.validate(task.view, signal)))
      return { completed: false, verified: false, reason: 'STALE_VIEW', recovery: 'refresh' }
    if (verifier && !validation.verified)
      return { completed: false, recovery: 'repair', ...validation }
    await this.change(
      {
        apply: (current) => {
          const latest = this.owned(current)
          if (latest.revision !== task.revision)
            throw contextFailure('STALE_VIEW', '验收期间任务发生变化')
          return {
            ...latest,
            status: 'completed',
            verification: validation.verified ? 'verified' : 'unverified',
          }
        },
      },
      true,
      signal
    )
    return { completed: true, ...validation }
  }

  public async recover(feedback: readonly ContextFeedback[]): Promise<void> {
    if (!(await this.inspect())) return
    await this.change(
      {
        apply: (task) => {
          if (!task) throw contextFailure('TASK_STATE', '任务不存在')
          if (
            task.lease &&
            task.lease.expiresAt > Date.now() &&
            (task.lease.id !== this.leaseId || task.status === 'executing')
          )
            throw contextFailure('TASK_BUSY', '活动任务不能从外部恢复')
          const mandatory = [
            ...task.mandatory.filter((old) => !feedback.some((item) => item.id === old.id)),
            ...structuredClone(feedback),
          ]
          const terminal = ['completed', 'cancelled'].includes(task.status)
          return {
            ...task,
            activeExecutions: {},
            revision: task.revision + 1,
            mandatory,
            view: null,
            lease: task.lease?.id === this.leaseId ? task.lease : null,
            status: terminal ? task.status : 'context-pending',
          }
        },
      },
      false
    )
  }

  public async end(status?: ContextTaskStatus): Promise<void> {
    const owner = this.leaseId
    if (!owner) return
    await this.change(
      {
        apply: (current) => {
          if (!current) throw contextFailure('TASK_STATE', '任务检查点不存在')
          if (!current.lease) return current
          if (current.lease.id !== owner) throw contextFailure('LEASE_LOST', '任务租约已被替换')
          const terminal = ['completed', 'cancelled', 'failed'].includes(current.status)
          return {
            ...current,
            status: terminal ? current.status : (status ?? current.status),
            lease: null,
          }
        },
      },
      false
    )
    if (this.leaseId === owner) this.leaseId = undefined
  }

  private owned(task: Optional<ContextTaskState>): ContextTaskState {
    if (
      !task ||
      !this.leaseId ||
      task.lease?.id !== this.leaseId ||
      task.lease.expiresAt <= Date.now()
    )
      throw contextFailure('LEASE_LOST', '当前运行不持有有效任务租约')
    if (['completed', 'cancelled', 'failed'].includes(task.status))
      throw contextFailure('TASK_TERMINAL', '任务已经结束')
    return task
  }

  private executing(task: Optional<ContextTaskState>, executionId?: string): ContextTaskState {
    const current = this.owned(task)
    const ids = Object.keys(current.activeExecutions ?? {})
    if (!isEmpty(ids)) {
      const id = executionId ?? (ids.length === 1 ? ids[0] : undefined)
      if (!id || !Object.hasOwn(current.activeExecutions!, id))
        throw contextFailure('LEASE_LOST', '操作不属于当前活动执行')
      return { ...current, executionId: id }
    }
    if (current.status !== 'executing' || (executionId && executionId !== current.executionId))
      throw contextFailure('STEP_REQUIRED', '此操作只能由当前执行调用')
    return current
  }

  private async change(
    mutation: ContextTaskMutation,
    renew = true,
    signal?: AbortSignal
  ): Promise<ContextTaskState> {
    const { storage, sessionId } = this.options
    const incremental = Boolean(storage.loadMetadata && storage.compareAndSwapMetadata)
    for (let attempt = 0; attempt < 32; attempt++) {
      signal?.throwIfAborted()
      const full = incremental ? undefined : await storage.load(sessionId)
      const state = incremental
        ? ((await storage.loadMetadata!(sessionId)) ?? {
            version: 0,
            workingSet: { revision: 0, cursor: 0, items: [] },
          })
        : (full ?? emptyContextState())
      let task = mutation.apply(state.task ? readContextTask(state.task) : undefined)
      if (renew && task.lease)
        task = { ...task, lease: { ...task.lease, expiresAt: Date.now() + this.limits.leaseMs } }
      signal?.throwIfAborted()
      const append: Array<Omit<ContextRecord, 'sequence'>> = []
      if (state.task && task.id && state.task.id !== task.id) {
        const body = JSON.stringify(state.task)
        const objectId = await storage.put(sessionId, body)
        append.push({
          ref: { sessionId, id: crypto.randomUUID() },
          kind: 'audit',
          title: `task:archive:${state.task.id ?? 'legacy'}`,
          objectId,
          chars: body.length,
          sources: state.task.goals,
          createdAt: new Date().toISOString(),
        })
      }
      signal?.throwIfAborted()
      const next = { ...state, version: state.version + 1, task }
      if (incremental) {
        if (await storage.compareAndSwapMetadata!(sessionId, state.version, next, append))
          return task
      } else {
        const records = full?.records ?? []
        if (
          await storage.compareAndSwap(sessionId, state.version, {
            ...next,
            records: [
              ...records,
              ...append.map((record, index) => ({
                ...record,
                sequence: (records.at(-1)?.sequence ?? 0) + index + 1,
              })),
            ],
          })
        )
          return task
      }
    }
    throw contextFailure('TASK_CONFLICT', '任务提交竞争超过重试上限')
  }
}

/** 装配现有会话记录与只读源，创建任务视图控制面。 */
export function createContextView(options: ContextViewOptions): ContextViewApi {
  return new ContextViewSession(options)
}
