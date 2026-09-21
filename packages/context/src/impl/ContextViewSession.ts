import {isUndefined,toNullable,toOptional} from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'

import type { ContextCompletionResult } from '../contract/context.js'
import type { ContextContent, ContextFeedback, ContextReadRange, ContextRef, ContextSourceCard, ContextStepRecord, ContextTaskState, ContextTaskStatus, ContextViewLimits, ModelView, RegisteredViewIntent, TaskCapsule, ViewIntentInput } from '../contract/context.js'
import { TaskCapsuleSchema, ViewIntentSchema } from '../contract/view-schema.js'
import type { ContextTaskMutation } from '../interface/internal.js'
import type { ContextViewApi } from '../interface/provides.js'
import type { ContextBuildOptions, ContextCompletionPort, ContextViewOptions } from '../interface/requires.js'
import { contextFailure, emptyContextState, sameContextRef } from '../utils/state.js'
import { assertContextTask, assertViewSchema, awaitContextOperation, resolveViewLimits } from '../utils/view.js'

import { ContextEvidenceBuilder } from './ContextEvidenceBuilder.js'

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

  public sources(): readonly ContextSourceCard[] { return this.options.sources.map(source => ({id:source.id,capabilities:{...source.capabilities}})) }

  public async inspect(): Promise<Nullable<ContextTaskState>> {
    const task = (await this.options.storage.load(this.options.sessionId))?.task
    if (task) assertContextTask(task)
    return toNullable(task)
  }

  public async begin(goal: ContextRef, signal?: AbortSignal, mode:'continue'|'new'='continue'): Promise<string> {
    if(!['continue','new'].includes(mode))throw contextFailure('TASK_MODE','任务模式无效')
    const content = await this.options.context.read(goal)
    if (content.record.kind !== 'user') throw contextFailure('TASK_GOAL', '只有原始用户记录可以成为任务目标')
    const id = crypto.randomUUID()
    await this.change({ apply: current => {
      if (current?.lease && current.lease.expiresAt > Date.now()) throw contextFailure('TASK_BUSY', '另一个运行持有任务租约')
      if (current?.status === 'executing'||Object.keys(current?.activeExecutions??{}).length) throw contextFailure('NEEDS_RECONCILE', '上次执行被中断，必须先核对已派发操作')
      const revision=(current?.revision??0)+1
      if(mode==='new'&&current?.mandatory.some(item=>item.effect==='unknown'||item.outcome==='unknown'))throw contextFailure('NEEDS_RECONCILE','必须先核对未知效果，不能通过新任务跳过')
      const prior=mode==='new'?undefined:current
      return {
        ...prior, id:prior?.id??id,startedSequence:prior?.startedSequence??(mode==='new'?content.record.sequence-1:0), revision, step:prior?.step ?? 0, status: 'ready', lease: { id, expiresAt: Date.now() + this.limits.leaseMs },
        goals: prior?.goals.some(ref=>sameContextRef(ref,goal)) ? prior.goals : [...(prior?.goals ?? []), goal], capsule: prior?.capsule ?? { nextObjective: '', hypotheses: [], decisions: [], openQuestions: [] },
        activeExecutions:{}, provenance: prior?.provenance ?? [], executionId: `initial:${  id}`, intents: [], mandatory: prior?.mandatory ?? [], artifacts: prior?.artifacts ?? [], view: toNullable(prior?.view),
        usage: prior ? prior.usage : { mainCalls: 0, contextCalls: 0, reservedTokens: 0, inputTokens: 0, outputTokens: 0, unmeasuredCalls: 0 }, verification: 'unverified',
      }
    } }, false, signal)
    this.leaseId = id
    return id
  }

  public async appendGoal(goal:ContextRef,signal?:AbortSignal):Promise<void>{
    const content=await this.options.context.read(goal)
    if(content.record.kind!=='user')throw contextFailure('TASK_GOAL','目标补充必须来自用户输入')
    await this.change({apply:current=>{const task=this.owned(current);return {...task,revision:task.revision+1,goals:task.goals.some(ref=>sameContextRef(ref,goal))?task.goals:[...task.goals,goal],view:null,verification:'unverified'}}},true,signal)
  }

  public async startStep(executionId: string, signal?: AbortSignal, concurrent=false, basis?:LooseOptional<ModelView>): Promise<void> {
    if (!executionId) throw contextFailure('STEP_ID', '执行号不能为空')
    await this.change({ apply: current => {
      const task = this.owned(current)
      if (task.activeExecutions?.[executionId] || (task.status==='executing'||Object.keys(task.activeExecutions??{}).length)&&!concurrent) throw contextFailure('TASK_BUSY', '当前步骤尚未结束')
      if (task.mandatory.some(item => item.effect === 'unknown' || item.outcome === 'unknown')) throw contextFailure('NEEDS_RECONCILE', '未知操作结果需要先由宿主核对')
      return { ...task, revision: task.revision + 1, step:(task.step ?? 0)+1, status: 'executing', executionId, activeExecutions:{...task.activeExecutions,[executionId]:{view:isUndefined(basis)?task.view:basis,concurrent}}, intents: concurrent?task.intents:[], verification: 'unverified' }
    } }, true, signal)
  }

  public async request(intent: ViewIntentInput, signal?: AbortSignal, executionId?:string): Promise<RegisteredViewIntent> {
    assertViewSchema(ViewIntentSchema, intent)
    if (intent.kind === 'direct' && intent.target.kind === 'resource' && intent.target.selector?.kind === 'lines' && intent.target.selector.end < intent.target.selector.start) throw contextFailure('VIEW_SCHEMA', '行范围终点不能早于起点')
    const id = crypto.randomUUID()
    const task = await this.change({ apply: current => {
      const task = this.executing(current,executionId)
      if (task.intents.length >= this.limits.intents) throw contextFailure('INTENT_LIMIT', '观察需求超过本步上限')
      const next = { ...task, revision: task.revision + 1 }
      const registered: RegisteredViewIntent = { id, scope: { sessionId: this.options.sessionId, revision: next.revision }, executionId: task.executionId!, request: structuredClone(intent) }
      return { ...next, intents: [...task.intents, registered] }
    } }, true, signal)
    return task.intents.find(item => item.id === id)!
  }

  public async updateCapsule(capsule: Partial<TaskCapsule>, signal?: AbortSignal, executionId?:string): Promise<TaskCapsule> {
    assertViewSchema(TaskCapsuleSchema, capsule)
    return (await this.change({ apply: current => {
      const task = this.executing(current,executionId)
      return { ...task, revision: task.revision + 1, capsule: { ...task.capsule, ...structuredClone(capsule) } }
    } }, true, signal)).capsule
  }

  public async putArtifact(body: string, sources: readonly ContextRef[] = [], signal?: AbortSignal, executionId?:string): Promise<ContextRef> {
    this.executing(toOptional(await this.inspect()),executionId)
    const record = await this.options.context.append({ kind: 'note', title: 'task:artifact', body, sources }, signal)
    await this.change({ apply: current => {
      const task = this.executing(current,executionId)
      const resolved = sources.map(ref => {
        const evidence = (task.activeExecutions?.[task.executionId]?.view??task.view)?.evidence.find(item => sameContextRef(item.recovery, ref))
        const artifact = task.provenance?.find(item => sameContextRef(item.ref, ref))
        return evidence ? { readSet: evidence.readSet, complete: evidence.complete } : artifact ?? { readSet: [], complete: false }
      })
      const provenance = { ref: record.ref, readSet: resolved.flatMap(item => item.readSet), complete: resolved.every(item => item.complete) }
      return { ...task, revision: task.revision + 1, artifacts: [...task.artifacts, record.ref], provenance: [...(task.provenance ?? []), provenance] }
    } }, true, signal)
    return record.ref
  }

  public async readArtifact(ref: ContextRef, range?: ContextReadRange): Promise<ContextContent> {
    const task = await this.inspect()
    if (!task?.artifacts.some(item => sameContextRef(item, ref))) throw contextFailure('SCOPE_MISMATCH', '材料不在当前任务中')
    return this.options.context.read(ref, range)
  }

  public async settle(feedback: readonly ContextFeedback[], signal?: AbortSignal, step?: ContextStepRecord): Promise<void> {
    await this.change({ apply: current => {
      const task = this.executing(current,feedback[0]?.executionId)
      if (feedback.some(item => item.executionId !== task.executionId)) throw contextFailure('RECEIPT_SCOPE', '回执不属于当前执行')
      const mandatory = [...task.mandatory.filter(old => !feedback.some(item => item.id === old.id)), ...structuredClone(feedback)]
      const activeExecutions=Object.fromEntries(Object.entries(task.activeExecutions??{}).filter(([id])=>id!==task.executionId))
      return { ...task, activeExecutions, revision: task.revision + 1, mandatory, lastStep: step ?? task.lastStep, status: mandatory.some(item => item.effect === 'unknown' || item.outcome === 'unknown') ? 'needs-reconcile' : !isEmpty(Object.keys(activeExecutions))?'executing':'context-pending' }
    } }, true, signal)
  }

  public async preview(options:ContextBuildOptions,signal:AbortSignal=new AbortController().signal):Promise<ModelView>{
    const task=await this.inspect()
    if(!task)throw contextFailure('TASK_STATE','任务不存在')
    return this.builder.build(task,{...options,planner:undefined},signal)
  }

  public async build(options: ContextBuildOptions, externalSignal: AbortSignal = new AbortController().signal): Promise<ModelView> {
    if (this.building) throw contextFailure('TASK_BUSY', '物化已经在进行')
    if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1) throw contextFailure('VIEW_BUDGET', '视图预算必须为正整数')
    this.building = true
    const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(this.limits.materializationMs)])
    try {
      const task = this.owned(toOptional(await this.inspect()))
      if(task.status==='executing'&&(!task.activeExecutions||Object.values(task.activeExecutions).some(item=>!item.concurrent)))throw contextFailure('TASK_BUSY','执行尚未结束')
      const view = await this.builder.build(task, options, signal)
      signal.throwIfAborted()
      if (!await this.builder.validate(view, signal)) throw contextFailure('STALE_VIEW', '发布前资源版本或范围发生变化')
      await this.options.context.append({ kind: 'audit', title: 'context:model-view', body: JSON.stringify(view) }, signal)
      await this.change({ apply: current => {
        const latest = this.owned(current)
        if (latest.revision!==task.revision) throw contextFailure('STALE_VIEW', '物化期间任务已变化')
        const old = latest.metrics ?? { views: 0, sourceReads: 0, sourceBytes: 0, searches: 0, durationMs: 0 }
        const metrics = { views: old.views + 1, sourceReads: old.sourceReads + view.metrics.sourceReads, sourceBytes: old.sourceBytes + view.metrics.sourceBytes, searches: old.searches + view.metrics.searches, durationMs: old.durationMs + view.metrics.durationMs }
        return { ...latest, view, metrics, status: latest.status === 'needs-reconcile' ? 'needs-reconcile' : 'view-ready' }
      } }, true, signal)
      return view
    } finally { this.building = false }
  }

  public async validate(view: ModelView, signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    const task = await this.inspect()
    return Boolean(task && task.view?.id === view.id && task.revision===view.scope.revision && (task.status !== 'executing'||Object.values(task.activeExecutions??{}).every(item=>item.concurrent)) && await this.builder.validate(view, signal))
  }

  public async assertCanWrite(executionId: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted()
    const task = this.executing(toOptional(await this.inspect()),executionId)
    if (task.executionId !== executionId) throw contextFailure('LEASE_LOST', '操作不属于当前执行')
    if (task.mandatory.some(item => item.effect === 'unknown' || item.outcome === 'unknown')) throw contextFailure('NEEDS_RECONCILE', '操作结果尚待核对')
    const basis=task.activeExecutions?.[executionId]?.view??task.view
    if (basis?.gaps.some(gap => gap.required)) throw contextFailure('REQUIRED_EVIDENCE_MISSING', '先补齐所需证据，再执行修改')
    if (basis && !await this.builder.validate(basis, signal)) throw contextFailure('STALE_VIEW', '决策依赖的资源已经变化，请重新观察')
  }

  public async renew(signal?:AbortSignal):Promise<void> { await this.change({apply:current=>this.owned(current)},true,signal) }

  public async reserveModel(role: 'main' | 'context', tokens: number): Promise<void> {
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw contextFailure('MODEL_BUDGET', '模型预算无效')
    await this.change({ apply: current => {
      const task = this.owned(current); const usage = task.usage
      if (usage.mainCalls + usage.contextCalls >= this.limits.modelCalls || Math.max(usage.reservedTokens, usage.inputTokens + usage.outputTokens) + tokens > this.limits.modelTokens) throw contextFailure('MODEL_BUDGET', '任务共享模型预算耗尽')
      return { ...task, usage: { ...usage, [role === 'main' ? 'mainCalls' : 'contextCalls']: usage[role === 'main' ? 'mainCalls' : 'contextCalls'] + 1, reservedTokens: usage.reservedTokens + tokens, unmeasuredCalls: usage.unmeasuredCalls + 1 } }
    } })
  }

  public async releaseModel(role:'main'|'context',tokens:number):Promise<void> {
    if(!Number.isSafeInteger(tokens)||tokens<1)throw contextFailure('MODEL_BUDGET','预留预算无效')
    await this.change({apply:current=>{const task=this.owned(current); const usage=task.usage; const key=role==='main'?'mainCalls':'contextCalls';return {...task,usage:{...usage,[key]:Math.max(0,usage[key]-1),reservedTokens:Math.max(0,usage.reservedTokens-tokens),unmeasuredCalls:Math.max(0,usage.unmeasuredCalls-1)}}}})
  }

  public async recordUsage(inputTokens: number, outputTokens: number): Promise<void> {
    if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw contextFailure('MODEL_USAGE', '供应商用量无效')
    await this.change({ apply: current => {
      const task = this.owned(current); const usage = task.usage
      return { ...task, usage: { ...usage, inputTokens: usage.inputTokens + inputTokens, outputTokens: usage.outputTokens + outputTokens, unmeasuredCalls: Math.max(0, usage.unmeasuredCalls - 1) } }
    } })
  }

  public async complete(verifier?: ContextCompletionPort, signal: AbortSignal = new AbortController().signal): Promise<ContextCompletionResult> {
    const task = this.owned(toOptional(await this.inspect()))
    if(!isEmpty(Object.keys(task.activeExecutions??{}))||task.status==='executing')return {completed:false,verified:false,reason:'PENDING_EXECUTIONS',recovery:'refresh'}
    if (task.mandatory.some(item => item.effect === 'unknown' || item.outcome === 'unknown')) return { completed: false, verified: false, reason: 'NEEDS_RECONCILE', recovery:'reconcile' }
    if (!task.view || task.view.gaps.some(gap => gap.required)) return { completed: false, verified: false, reason: 'REQUIRED_EVIDENCE_MISSING', recovery:'repair' }
    if (!await this.validate(task.view, signal)) return { completed: false, verified: false, reason: 'STALE_VIEW', recovery:'refresh' }
    const validation = verifier ? await awaitContextOperation(verifier.verify(task.view, signal), signal) : { verified: false, reason: '未配置领域验收器，结果为未验证交付' }
    if (!await this.validate(task.view, signal)) return { completed: false, verified: false, reason: 'STALE_VIEW', recovery:'refresh' }
    if (verifier && !validation.verified) return { completed: false, recovery:'repair', ...validation }
    await this.change({ apply: current => {
      const latest = this.owned(current)
      if (latest.revision !== task.revision) throw contextFailure('STALE_VIEW', '验收期间任务发生变化')
      return { ...latest, status: 'completed', verification: validation.verified ? 'verified' : 'unverified' }
    } }, true, signal)
    return { completed: true, ...validation }
  }

  public async recover(feedback: readonly ContextFeedback[]): Promise<void> {
    if (!await this.inspect()) return
    await this.change({ apply: task => {
      if (!task) throw contextFailure('TASK_STATE', '任务不存在')
      if (task.lease && task.lease.expiresAt > Date.now() && (task.lease.id !== this.leaseId || task.status === 'executing')) throw contextFailure('TASK_BUSY', '活动任务不能从外部恢复')
      const mandatory = [...task.mandatory.filter(old => !feedback.some(item => item.id === old.id)), ...structuredClone(feedback)]
      const terminal = ['completed','cancelled'].includes(task.status)
      return { ...task, activeExecutions:{}, revision: task.revision + 1, mandatory, view: null,
        lease: task.lease?.id === this.leaseId ? task.lease : null,
        status: terminal ? task.status : mandatory.some(item => item.effect === 'unknown' || item.outcome === 'unknown') ? 'needs-reconcile' : 'context-pending' }
    } }, false)
  }

  public async end(status?: ContextTaskStatus): Promise<void> {
    const owner = this.leaseId
    if (!owner) return
    await this.change({ apply: current => {
      if (!current) throw contextFailure('TASK_STATE', '任务检查点不存在')
      if (!current.lease) return current
      if (current.lease.id !== owner) throw contextFailure('LEASE_LOST', '任务租约已被替换')
      const terminal = ['completed', 'cancelled', 'failed'].includes(current.status)
      return { ...current, status: terminal ? current.status : status ?? current.status, lease: null }
    } }, false)
    if (this.leaseId === owner) this.leaseId = undefined
  }

  private owned(task: Optional<ContextTaskState>): ContextTaskState {
    if (!task || !this.leaseId || task.lease?.id !== this.leaseId || task.lease.expiresAt <= Date.now()) throw contextFailure('LEASE_LOST', '当前运行不持有有效任务租约')
    if (['completed', 'cancelled', 'failed'].includes(task.status)) throw contextFailure('TASK_TERMINAL', '任务已经结束')
    return task
  }

  private executing(task: Optional<ContextTaskState>,executionId?:string): ContextTaskState {
    const current=this.owned(task)
    const ids=Object.keys(current.activeExecutions??{})
    if(!isEmpty(ids)){
      const id=executionId??(ids.length===1?ids[0]:undefined)
      if(!id||!Object.hasOwn(current.activeExecutions!,id))throw contextFailure('LEASE_LOST','操作不属于当前活动执行')
      return {...current,executionId:id}
    }
    if(current.status!=='executing'||executionId&&executionId!==current.executionId)throw contextFailure('STEP_REQUIRED','此操作只能由当前执行调用')
    return current
  }

  private async change(mutation: ContextTaskMutation, renew = true, signal?: AbortSignal): Promise<ContextTaskState> {
    for (let attempt = 0; attempt < 32; attempt++) {
      signal?.throwIfAborted()
      const state = await this.options.storage.load(this.options.sessionId) ?? emptyContextState()
      if (state.task) assertContextTask(state.task)
      let task = mutation.apply(state.task)
      if (renew && task.lease) task = { ...task, lease: { ...task.lease, expiresAt: Date.now() + this.limits.leaseMs } }
      signal?.throwIfAborted()
      let records=state.records
      if(state.task&&task.id&&state.task.id!==task.id){
        const body=JSON.stringify(state.task); const objectId=await this.options.storage.put(this.options.sessionId,body)
        records=[...records,{ref:{sessionId:this.options.sessionId,id:crypto.randomUUID()},sequence:records.length+1,kind:'audit',title:`task:archive:${state.task.id??'legacy'}`,objectId,chars:body.length,sources:state.task.goals,createdAt:new Date().toISOString()}]
      }
      if (await this.options.storage.compareAndSwap(this.options.sessionId, state.version, { ...state, version: state.version + 1, records, task })) return task
    }
    throw contextFailure('TASK_CONFLICT', '任务提交竞争超过重试上限')
  }
}

/** 装配现有会话记录与只读源，创建任务视图控制面。 */
export function createContextView(options: ContextViewOptions): ContextViewApi { return new ContextViewSession(options) }
