import { Log, toOptional } from '@velaros-ai/core'
import { isFalse } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'

import { ContextLimits } from '../contract/constants.js'
import type {
  ContextBuildOptions,
  ContextSourcePort,
  ContextViewOptions,
} from '../contract/requires.js'
import type {
  ContextCandidate,
  ContextEvidence,
  ContextGap,
  ContextPlan,
  ContextPlannerDecision,
  ContextSelection,
  ContextSourceRead,
  ContextTarget,
  ContextTaskScope,
  ContextTaskState,
  ContextTime,
  ContextViewForm,
  ModelView,
  RegisteredViewIntent,
} from '../types/context.js'
import { contextProgress } from '../utils/progress.js'
import { contextFailure, sameContextRef } from '../utils/state.js'
import { checkContextSelections } from '../utils/view.js'
import { awaitContextOperation, contextGap, contextHash, resolveViewLimits } from '../utils/view.js'
import { checkPlannerDecision } from '../utils/view-input.js'

import { createEvidenceAccess } from './EvidenceAccess.js'

/** 物化器只读取固定任务快照，提交权由会话服务持有。 */
export interface ContextEvidenceBuilderApi {
  /** 解析需求、选择候选并从真实源生成证据。 */
  build(
    task: ContextTaskState,
    options: ContextBuildOptions,
    signal: AbortSignal
  ): Promise<ModelView>
  /** 发送前验证源授权和版本。 */
  validate(view: ModelView, signal: AbortSignal): Promise<boolean>
}

/** 只从已登记源读取事实，模型计划仅决定候选和表示。 */
export class ContextEvidenceBuilder implements ContextEvidenceBuilderApi {
  private readonly sources: ReadonlyMap<string, ContextSourcePort>
  private readonly access
  private readonly limits

  public constructor(private readonly options: ContextViewOptions) {
    this.access = createEvidenceAccess(options.sources)
    this.sources = new Map(options.sources.map((source) => [source.id, source]))
    if (
      this.sources.size !== options.sources.length ||
      options.sources.some((source) => !source.id)
    )
      throw contextFailure('SOURCE_ID', '数据源身份重复或为空')
    this.limits = resolveViewLimits(options.limits)
  }

  public async build(
    task: ContextTaskState,
    options: ContextBuildOptions,
    signal: AbortSignal
  ): Promise<ModelView> {
    signal.throwIfAborted()
    const startedAt = Date.now()
    const metrics = { sourceReads: 0, sourceBytes: 0, searches: 0, durationMs: 0 }
    const scope = { sessionId: this.options.sessionId, revision: task.revision }
    const goals = []
    for (const ref of task.goals) {
      goals.push(
        await this.options.context.projectInput(
          ref,
          Math.max(1, Math.floor(options.maxChars / Math.max(4, task.goals.length * 4)))
        )
      )
    }
    const visible = options.visibleExecutionIds
    const lastStep =
      !isFalse(options.executionDetails) &&
      (!visible || visible.includes(task.executionId ?? '')) &&
      task.lastStep
        ? {
            attachments: task.lastStep.attachments?.length
              ? await Promise.all(
                  task.lastStep.attachments.map(async (ref) => ({
                    ref,
                    hash: (await this.options.context.read(ref, { limit: 1 })).record.objectId,
                  }))
                )
              : undefined,
            source: await this.options.context.read(task.lastStep.source, {
              limit: Math.min(4000, Math.floor(options.maxChars / 8)),
            }),
            result: await this.options.context.read(task.lastStep.result, {
              limit: Math.min(4000, Math.floor(options.maxChars / 8)),
            }),
          }
        : undefined
    const gaps: ContextGap[] = []
    const taskFrame = {
      goals,
      capsule: task.capsule,
      mandatory:
        isFalse(options.executionDetails) || visible
          ? task.mandatory.filter(
              (item) =>
                item.effect === 'unknown' ||
                item.outcome === 'unknown' ||
                visible?.includes(item.executionId)
            )
          : task.mandatory,
      lastStep: toOptional(lastStep),
    }
    const candidates: ContextCandidate[] = []
    const direct: ContextSelection[] = []
    const degraded: string[] = []
    const budget = { searches: 0, bytes: 0, calls: 0 }
    const readSource = async (
      target: ContextTarget,
      form: ContextViewForm,
      time: ContextTime,
      maxBytes: number
    ): Promise<ContextSourceRead> => {
      metrics.sourceReads++
      const result = await this.read(scope, target, form, time, maxBytes, task, signal)
      metrics.sourceBytes += new TextEncoder().encode(result.text).byteLength
      return result
    }
    const register = async (
      intent: RegisteredViewIntent,
      target: ContextTarget,
      preview: string,
      forms: readonly ContextViewForm[]
    ): Promise<ContextCandidate> => {
      if (candidates.length >= this.limits.candidates)
        throw contextFailure('CANDIDATE_LIMIT', '候选上限已到')
      await this.authorize(scope, target, task, signal)
      const allowedForms = forms.filter(
        (form) => !intent.request.forms || intent.request.forms.includes(form)
      )
      if (isEmpty(allowedForms))
        throw contextFailure('UNSUPPORTED_FORM', '候选不能提供请求允许的表示')
      const candidate = {
        id: crypto.randomUUID(),
        target,
        preview: preview.slice(0, 500),
        forms: allowedForms,
        intentIds: [intent.id],
      }
      candidates.push(candidate)
      return candidate
    }
    const search = async (
      intent: RegisteredViewIntent,
      source: ContextSourcePort,
      query: string,
      limit: number
    ): Promise<void> => {
      if (++budget.searches > this.limits.searchCalls)
        throw contextFailure('SEARCH_LIMIT', '只读检索预算耗尽')
      metrics.searches++
      const hits = await awaitContextOperation(
        source.search(
          scope,
          query,
          Math.min(limit, this.limits.candidates - candidates.length),
          signal
        ),
        signal
      )
      for (const hit of hits.slice(0, Math.max(0, this.limits.candidates - candidates.length))) {
        try {
          await register(intent, hit.target, hit.preview, hit.forms)
        } catch {
          Log.tag('ActRuntime').debug('ContextEvidenceBuilder 已进入异常处理或降级分支')
          degraded.push('候选未通过当前数据源范围检查')
        }
      }
    }
    for (const intent of task.intents) {
      try {
        if (intent.request.kind === 'direct') {
          const forms = intent.request.forms ?? ['full']
          const form = forms.find((value) => value !== 'diff')
          if (!form) {
            gaps.push(
              contextGap(
                intent,
                'BASELINE_MISSING',
                '当前请求没有可重构差量的基线，请请求原文或切片'
              )
            )
            continue
          }
          const candidate = await register(intent, intent.request.target, '', forms)
          direct.push({ candidateId: candidate.id, intentIds: [intent.id], form })
        } else {
          for (const target of intent.request.anchors ?? [])
            await register(
              intent,
              target,
              '任务提供的定位线索',
              intent.request.forms ?? ['full', 'excerpt']
            )
          for (const source of this.sources.values()) {
            if (
              candidates.length >= this.limits.candidates ||
              budget.searches >= this.limits.searchCalls
            )
              break
            await search(intent, source, intent.request.objective, this.limits.candidates)
          }
        }
      } catch (error) {
        Log.tag('ActRuntime').debug('ContextEvidenceBuilder 已进入异常处理或降级分支')
        gaps.push(
          contextGap(
            intent,
            (error as { code?: string }).code ?? 'SOURCE_UNAVAILABLE',
            '目标不可用或不满足当前范围'
          )
        )
      }
    }
    let chosen: readonly ContextSelection[] = []
    const semantic = task.intents.filter((intent) => intent.request.kind === 'semantic')
    if (!isEmpty(semantic)) {
      if (options.planner) {
        for (let attempt = 0; attempt < this.limits.plannerCalls; attempt++) {
          signal.throwIfAborted()
          try {
            for (let index = candidates.length - 1; index >= 0; index--) {
              try {
                await this.authorize(scope, candidates[index]!.target, task, signal)
              } catch {
                Log.tag('ActRuntime').debug('ContextEvidenceBuilder 已进入异常处理或降级分支')
                candidates.splice(index, 1)
                degraded.push('候选范围已变化，已移除其预览')
              }
            }
            signal.throwIfAborted()
            budget.calls++
            const decision: ContextPlannerDecision = await awaitContextOperation(
              options.planner.decide(
                {
                  scope,
                  task: taskFrame,
                  intents: semantic,
                  candidates,
                  sources: [...this.sources.keys()],
                  remainingCalls: this.limits.plannerCalls - attempt,
                  feedback: degraded.slice(-3),
                },
                signal
              ),
              signal
            )
            checkPlannerDecision(decision)
            if (decision.kind === 'select') {
              checkContextSelections(decision.selections, candidates, semantic)
              chosen = decision.selections
              break
            }
            if (decision.kind === 'insufficient') {
              if (decision.intentIds.some((id) => !semantic.some((intent) => intent.id === id)))
                throw contextFailure('PLAN_SCOPE', '未知需求')
              degraded.push('规划器报告证据不足')
              break
            }
            if (decision.kind === 'search') {
              const intent = semantic.find((item) => item.id === decision.intentId)
              const source = this.sources.get(decision.sourceId)
              if (!intent || !source) throw contextFailure('PLAN_SCOPE', '检索引用不在当前候选范围')
              await search(intent, source, decision.query, decision.limit)
            } else {
              for (const id of decision.candidateIds) {
                if (++budget.searches > this.limits.searchCalls)
                  throw contextFailure('INSPECT_LIMIT', '只读检索与检查共享预算耗尽')
                const candidate = candidates.find((item) => item.id === id)
                if (!candidate || budget.bytes >= this.limits.inspectBytes)
                  throw contextFailure('INSPECT_LIMIT', '候选检查预算或身份无效')
                const read = await readSource(
                  candidate.target,
                  'excerpt',
                  { kind: 'after-step' },
                  this.limits.inspectBytes - budget.bytes
                )
                const bytes = new TextEncoder().encode(read.text).byteLength
                if (bytes > this.limits.inspectBytes - budget.bytes)
                  throw contextFailure('INSPECT_LIMIT', '适配器超过读取预算')
                budget.bytes += bytes
                const index = candidates.indexOf(candidate)
                candidates[index] = { ...candidate, preview: read.text.slice(0, 2000) }
              }
            }
          } catch (error) {
            Log.tag('ActRuntime').debug('ContextEvidenceBuilder 已进入异常处理或降级分支')
            signal.throwIfAborted()
            degraded.push(`规划未被接受：${(error as { code?: string }).code ?? 'PLANNER_FAILED'}`)
          }
        }
      }
      if (isEmpty(chosen)) {
        chosen = candidates
          .filter((candidate) => semantic.some((intent) => candidate.intentIds.includes(intent.id)))
          .slice(0, 8)
          .map((candidate) => ({
            candidateId: candidate.id,
            intentIds: candidate.intentIds,
            form: candidate.forms.find((form) => form !== 'diff') ?? 'full',
          }))
        degraded.push('语义需求使用确定性候选回退，覆盖仍需判断')
        for (const intent of semantic)
          gaps.push(contextGap(intent, 'INSUFFICIENT_EVIDENCE', '确定性候选尚未证明语义需求已覆盖'))
      }
    }
    const plan: ContextPlan = {
      id: crypto.randomUUID(),
      scope,
      selections: [...direct, ...chosen],
      plannerCalls: budget.calls,
      degraded,
    }
    await this.options.context.append(
      { kind: 'audit', title: 'context:plan', body: JSON.stringify(plan) },
      signal
    )
    const evidence: ContextEvidence[] = []
    let chars = 0
    for (const selection of plan.selections) {
      const candidate = candidates.find((item) => item.id === selection.candidateId)!
      const intent = task.intents.find((item) => selection.intentIds.includes(item.id))!
      try {
        const remaining = this.limits.evidenceChars - chars
        if (remaining <= 0) throw contextFailure('BUDGET_EXCEEDED', '证据区预算耗尽')
        let read: Optional<ContextSourceRead>
        for (let retry = 0; retry <= this.limits.refreshes; retry++) {
          read = await readSource(
            candidate.target,
            selection.form,
            intent.request.time ?? { kind: 'after-step' },
            Math.min(this.limits.inspectBytes, remaining * 4)
          )
          if (
            intent.request.time?.kind === 'historical' ||
            read.stamp.consistency !== 'revision-checkable'
          )
            break
          if (
            (await awaitContextOperation(
              this.source(read.stamp.sourceId).validate(scope, read.stamp, signal),
              signal
            )) === 'current'
          )
            break
          read = undefined
        }
        if (!read) throw contextFailure('SOURCE_UNSTABLE', '发布前资源持续变化')
        await this.authorize(scope, candidate.target, task, signal)
        const body = read.text.slice(0, remaining)
        const complete = read.complete && body.length === read.text.length
        const record = await this.options.context.append(
          { kind: 'audit', title: 'context:evidence', body },
          signal
        )
        evidence.push({
          id: crypto.randomUUID(),
          intentIds: selection.intentIds,
          target: candidate.target,
          body,
          hash: await contextHash(body),
          form: body.length === read.text.length ? read.form : 'excerpt',
          complete,
          trust: candidate.target.kind === 'artifact' ? 'model-derived' : 'source-data',
          freshness:
            intent.request.time?.kind === 'historical'
              ? 'historical'
              : read.stamp.consistency === 'observed-only'
                ? 'observed-at'
                : 'validated-as-of',
          readSet: [read.stamp, ...(read.dependencies ?? [])],
          recovery: record.ref,
        })
        chars += body.length
        if (!complete)
          for (const id of selection.intentIds)
            gaps.push(
              contextGap(
                task.intents.find((item) => item.id === id)!,
                'BUDGET_EXCEEDED',
                '当前只包含部分证据，请按引用继续读取'
              )
            )
      } catch (error) {
        Log.tag('ActRuntime').debug('ContextEvidenceBuilder 已进入异常处理或降级分支')
        for (const id of selection.intentIds)
          gaps.push(
            contextGap(
              task.intents.find((item) => item.id === id)!,
              (error as { code?: string }).code ?? 'SOURCE_UNAVAILABLE',
              '所选证据未能物化；实际执行回执仍保留'
            )
          )
      }
    }
    for (const intent of task.intents)
      if (
        !evidence.some((block) => block.intentIds.includes(intent.id)) &&
        !gaps.some((gap) => gap.intentId === intent.id)
      )
        gaps.push(contextGap(intent, 'INSUFFICIENT_EVIDENCE', '没有可发布的真实证据'))
    const coverage = task.intents.map((intent) => ({
      intentId: intent.id,
      status: !evidence.some((block) => block.intentIds.includes(intent.id))
        ? ('missing' as const)
        : gaps.some((gap) => gap.intentId === intent.id)
          ? ('partial' as const)
          : ('satisfied' as const),
    }))
    metrics.durationMs = Date.now() - startedAt
    const view: ModelView = {
      ...taskFrame,
      progress: contextProgress(task, taskFrame, evidence),
      metrics,
      id: crypto.randomUUID(),
      scope,
      executionId: task.executionId,
      evidence,
      gaps,
      coverage,
      readSet: evidence.flatMap((block) => block.readSet),
      plannerCalls: plan.plannerCalls,
      degraded,
      builtAt: new Date().toISOString(),
    }
    if (JSON.stringify({ ...view, evidence: [], readSet: [] }).length > options.maxChars)
      throw contextFailure('CONTEXT_BUDGET', '用户约束、真实回执和缺口超过最小请求容量')
    while (
      JSON.stringify({ ...view, readSet: evidence.flatMap((block) => block.readSet) }).length >
        options.maxChars &&
      !isEmpty(evidence)
    ) {
      const removed = evidence.pop()!
      for (const id of removed.intentIds) {
        const entry = coverage.find((item) => item.intentId === id)!
        entry.status = evidence.some((block) => block.intentIds.includes(id))
          ? 'partial'
          : 'missing'
        gaps.push(
          contextGap(
            task.intents.find((intent) => intent.id === id)!,
            'BUDGET_EXCEEDED',
            '最终容量门排除此证据，覆盖已同步更新'
          )
        )
      }
    }
    const final = {
      ...view,
      progress: contextProgress(task, taskFrame, evidence),
      readSet: evidence.flatMap((block) => block.readSet),
    }
    if (JSON.stringify(final).length > options.maxChars)
      throw contextFailure('CONTEXT_BUDGET', '强制反馈超过容量')
    return final
  }

  public async validate(view: ModelView, signal: AbortSignal): Promise<boolean> {
    if (!view.progress) return false
    for (const evidence of view.evidence) {
      if (evidence.hash !== (await contextHash(evidence.body))) return false
      if (
        evidence.target.kind === 'resource' &&
        !(await awaitContextOperation(
          this.source(evidence.target.sourceId).authorize(view.scope, evidence.target, signal),
          signal
        ))
      )
        return false
      if (evidence.freshness === 'historical') continue
      for (const stamp of evidence.readSet) {
        if (stamp.sourceId === 'artifact') continue
        const source = this.source(stamp.sourceId)
        if (
          !(await awaitContextOperation(
            source.authorize(
              view.scope,
              { kind: 'resource', sourceId: stamp.sourceId, resourceId: stamp.resourceId },
              signal
            ),
            signal
          ))
        )
          return false
        if (
          stamp.consistency === 'revision-checkable' &&
          (await awaitContextOperation(source.validate(view.scope, stamp, signal), signal)) !==
            'current'
        )
          return false
      }
    }
    return true
  }

  private source(id: string): ContextSourcePort {
    const source = this.sources.get(id)
    if (!source) throw contextFailure('SOURCE_UNAVAILABLE', '数据源未装配')
    return source
  }

  private async authorize(
    scope: ContextTaskScope,
    target: ContextTarget,
    task: ContextTaskState,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (target.kind === 'artifact') {
      if (
        target.ref.sessionId !== scope.sessionId ||
        ![...task.artifacts, ...task.goals].some((ref) => sameContextRef(ref, target.ref))
      )
        throw contextFailure('SCOPE_MISMATCH', '引用不在当前任务中')
    } else if (
      !(await awaitContextOperation(
        this.source(target.sourceId).authorize(scope, target, signal),
        signal
      ))
    )
      throw contextFailure('DENIED', '目标不在当前来源范围内')
  }

  private async read(
    scope: ContextTaskScope,
    target: ContextTarget,
    form: ContextViewForm,
    time: ContextTime,
    maxBytes: number,
    task: ContextTaskState,
    signal: AbortSignal
  ): Promise<ContextSourceRead> {
    await this.authorize(scope, target, task, signal)
    if (target.kind === 'artifact') {
      const content = await this.options.context.read(target.ref, {
        limit: Math.min(ContextLimits.readChars, Math.floor(maxBytes / 4)),
      })
      const provenance = task.provenance?.find((item) => sameContextRef(item.ref, target.ref))
      for (const stamp of provenance?.readSet ?? []) {
        if (stamp.sourceId === 'artifact') continue
        const source = this.source(stamp.sourceId)
        if (
          !(await awaitContextOperation(
            source.authorize(
              scope,
              { kind: 'resource', sourceId: stamp.sourceId, resourceId: stamp.resourceId },
              signal
            ),
            signal
          )) ||
          (stamp.consistency === 'revision-checkable' &&
            (await awaitContextOperation(source.validate(scope, stamp, signal), signal)) !==
              'current')
        )
          throw contextFailure('STALE_DEPENDENCY', '模型材料引用的来源版本或范围已失效')
      }
      return {
        dependencies: provenance?.readSet ?? [],
        text: content.text,
        form: content.text.length === content.totalChars ? 'full' : 'excerpt',
        complete: content.text.length === content.totalChars && (provenance?.complete ?? true),
        mediaType: 'text/plain',
        stamp: {
          sourceId: 'artifact',
          resourceId: target.ref.id,
          revision: content.record.objectId,
          contentHash: await contextHash(content.text),
          observedAt: content.record.createdAt,
          consistency: 'snapshot',
        },
      }
    }
    return this.access.read(scope, target, form, time, maxBytes, signal)
  }
}
