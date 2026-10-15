import type { ModelToolDelivery } from '@velaros-ai/agent'
import type { ContextStorage, ContextViewApi } from '@velaros-ai/context'
import { createContextReference } from '@velaros-ai/context'
import { createContextRuntime } from '@velaros-ai/context'
import { createContextView } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isNull } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelTurnRequest } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'
import { modelProviderRetry, modelRequestDispatcher } from '@velaros-ai/model'

import { ModelToolLimits } from '../contract/constants.js'
import type { ModelBudgetPort, ModelBudgetSettlement } from '../types/model-budget.js'
import type { ModelToolBinding, ModelToolPolicy } from '../types/model-tools.js'
import { readModelBudgetSettlement } from '../utils/model-budget.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

/** 一次模型工具活动共享的资源权，不授予业务能力。 */
export interface ModelToolRuntimeScope {
  /** 根任务至当前工具的稳定归属。 */
  readonly binding: ModelToolBinding
  /** 包含父调用、期限和本次关闭的取消信号。 */
  readonly signal: AbortSignal
  /** 原子预留祖先预算，实际用量在各级总账各记录一次。 */
  readonly budget: ModelBudgetPort
  /** 取消活动并释放持久占位；调用者先收束会话和预算。 */
  close(): Promise<void>
}

/** 树形执行的注入依赖，事实和总账仍归现有 Context 所有。 */
export interface ModelToolRuntimeOptions {
  /** 共享可靠存储。 */
  readonly storage: ContextStorage
  /** 统一的调度上限。 */
  readonly policy?: ModelToolPolicy
  /** 活动会话的预算权威。 */
  view(sessionId: string): ContextViewApi
  /** 当前运行的绝对截止时间。 */
  deadline(sessionId: string): Optional<number>
}

/** 搜索、业务子任务和上下文维护共用的生命周期与资源管理。 */
export interface ModelToolRuntimeApi {
  /** 统一归档领域交付、真实引用及显式续跑入口，不执行任何共享脚本。 */
  deliver(
    parent: string,
    sessionId: string,
    kind: string,
    payload: ModelToolDelivery['payload'],
    status: ModelToolDelivery['status'],
    evidence: ReadonlyArray<ModelToolDelivery['payload']>,
    continuation?: ModelToolDelivery['continuation']
  ): Promise<ModelToolDelivery>
  /** 注册宿主根会话；模型不能自行成为根。 */
  root(sessionId: string): void
  /** 根会话资源已收束，撤回调度身份。 */
  releaseRoot(sessionId: string): void
  /** 在持久归属检查之后取得一次子会话活动权。 */
  begin(
    sessionId: string,
    parentSessionId: string,
    kind: ModelToolBinding['kind'],
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<ModelToolRuntimeScope>
  /** 对实际模型请求排队，复用原驱动和原请求编译器。 */
  model(sessionId: string, driver: ModelDriver): ModelDriver
  /** 判断活动调用关系，写入委托据此暂停祖先的同范围写入。 */
  descends(sessionId: string, ancestorId: string): boolean
}

/** 一棵调用树只有归属、活动权、祖先总账和实际模型调用配额。 */
export class ModelToolRuntime implements ModelToolRuntimeApi {
  private readonly budgetRecovery = new Map<string, Promise<void>>()
  private readonly budgetRecoveredSequence = new Map<string, number>()
  public async deliver(
    parent: string,
    sessionId: string,
    kind: string,
    payload: ModelToolDelivery['payload'],
    status: ModelToolDelivery['status'],
    evidence: ReadonlyArray<ModelToolDelivery['payload']>,
    continuation?: ModelToolDelivery['continuation']
  ): Promise<ModelToolDelivery> {
    const caller = await this.options.storage.load(parent)
    if (
      payload.sessionId !== parent ||
      !caller?.records.some((record) => record.ref.id === payload.id)
    )
      throw new AppError('PERMISSION', '交付报告不属于调用者')
    const producer = await this.options.storage.load(sessionId)
    const context = createContextRuntime({ sessionId: parent, storage: this.options.storage })
    const artifacts: Array<ModelToolDelivery['artifacts'][number]> = []
    for (const ref of evidence) {
      if (ref.sessionId !== sessionId && ref.sessionId !== parent)
        throw new AppError('PERMISSION', '证据不属于生产者或调用者')
      const state = ref.sessionId === sessionId ? producer : caller
      const record = state?.records.find((item) => item.ref.id === ref.id)
      if (!record) throw new AppError('NOT_FOUND', '交付证据不存在')
      const body = await this.options.storage.get(ref.sessionId, record.objectId)
      if (isNull(body)) throw new AppError('NOT_FOUND', '共享证据原文缺失')
      const copy =
        ref.sessionId === parent
          ? record
          : await context.append({ kind: 'note', title: 'shared:evidence', body })
      if (ref.sessionId !== parent)
        await context.append({
          kind: 'audit',
          title: 'shared:provenance',
          body: JSON.stringify({
            source: ref,
            objectId: record.objectId,
            copy: copy.ref,
            kind: 'evidence',
            mode: 'snapshot',
          }),
        })
      artifacts.push({ kind: 'evidence', ref: copy.ref, objectId: record.objectId })
    }
    const sources = new Set<string>(
      producer?.task?.lastStep ? [producer.task.lastStep.source.id] : []
    )
    for (const record of producer?.records ?? [])
      if (
        record.title.startsWith('script:version:') &&
        record.sequence > (producer?.task?.startedSequence ?? 0)
      )
        sources.add(record.title.slice('script:version:'.length))
    for (const id of [...sources].slice(-ActRuntimeTuning.deliveryScripts)) {
      const record = producer?.records.find((item) => item.ref.id === id)
      if (!record) continue
      const body = await this.options.storage.get(sessionId, record.objectId)
      if (isNull(body)) throw new AppError('NOT_FOUND', '共享脚本原文缺失')
      // 共享只是不可变源码材料；调用者显式读取并经自身 ScriptAct 校验后才可运行。
      const copy = await context.append({ kind: 'note', title: 'shared:script', body })
      await context.append({
        kind: 'audit',
        title: 'shared:provenance',
        body: JSON.stringify({
          source: record.ref,
          objectId: record.objectId,
          copy: copy.ref,
          kind: 'script',
        }),
      })
      artifacts.push({ kind: 'script', ref: copy.ref, objectId: copy.objectId })
    }
    const body = {
      schemaVersion: 1 as const,
      kind,
      sessionId,
      parentTaskId: caller.task?.id,
      status,
      payload,
      artifacts,
      omittedScripts: Math.max(0, sources.size - ActRuntimeTuning.deliveryScripts),
    }
    if (continuation) Object.assign(body, { continuation })
    const manifest = await context.append({
      kind: 'audit',
      title: 'model-tool:delivery',
      body: JSON.stringify(body),
      sources: [
        payload,
        ...artifacts.filter((item) => item.ref.sessionId === parent).map((item) => item.ref),
      ],
    })
    return { ...body, ref: manifest.ref }
  }

  private readonly policy: Required<ModelToolPolicy>
  private readonly roots = new Set<string>()
  private readonly active = new Map<
    string,
    { binding: ModelToolBinding; controller: AbortController; signal: AbortSignal }
  >()
  private running = 0
  private readonly queue: Array<() => void> = []

  public constructor(private readonly options: ModelToolRuntimeOptions) {
    this.policy = { ...ModelToolLimits, ...options.policy }
    if (Object.values(this.policy).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new AppError('VALIDATION', '模型工具调度上限必须为正整数')
  }

  public root(sessionId: string): void {
    if (this.active.has(sessionId)) throw new AppError('VALIDATION', '子会话不能注册为根')
    this.roots.add(sessionId)
  }

  public releaseRoot(sessionId: string): void {
    this.roots.delete(sessionId)
    this.budgetRecoveredSequence.delete(sessionId)
  }

  public descends(sessionId: string, ancestorId: string): boolean {
    let node = this.active.get(sessionId)
    while (node) {
      if (node.binding.parentSessionId === ancestorId) return true
      node = this.active.get(node.binding.parentSessionId)
    }
    return false
  }

  public async begin(
    sessionId: string,
    parentSessionId: string,
    kind: ModelToolBinding['kind'],
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<ModelToolRuntimeScope> {
    signal.throwIfAborted()
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new AppError('VALIDATION', '模型工具必须声明有限时限')
    if (!sessionId || sessionId === parentSessionId || this.roots.has(sessionId))
      throw new AppError('MODEL_TOOL_SCOPE', '模型工具身份与父会话冲突')
    if (this.active.has(sessionId)) throw new AppError('MODEL_TOOL_BUSY', '模型工具已有活动调用')
    const parent = this.active.get(parentSessionId)
    if (!parent && !this.roots.has(parentSessionId))
      throw new AppError('MODEL_TOOL_SCOPE', '模型工具父会话不可用')
    if (parent && parent.binding.kind !== 'agent')
      throw new AppError(
        'MODEL_TOOL_LEAF',
        '单一职责模型工具是叶子调用，不能派发其他模型工具或子任务'
      )
    if (parent && kind === 'agent')
      throw new AppError('MODEL_TOOL_DELEGATION', '只有主线可以派发业务子任务')
    const depth = (parent?.binding.depth ?? 0) + 1
    if (depth > this.policy.maxDepth)
      throw new AppError('MODEL_TOOL_DEPTH', '模型工具调用深度已达上限')
    const rootSessionId = parent?.binding.rootSessionId ?? parentSessionId
    await this.recoverBudget(rootSessionId)
    const deadline = Math.min(
      Date.now() + timeoutMs,
      parent?.binding.deadline ?? Infinity,
      this.options.deadline(parentSessionId) ?? Infinity
    )
    const binding: ModelToolBinding = {
      sessionId,
      parentSessionId,
      rootSessionId,
      rootTaskId: (await this.options.storage.load(rootSessionId))?.task?.id,
      kind,
      depth,
      deadline,
      activationId: crypto.randomUUID(),
      status: 'active',
    }
    const controller = new AbortController()
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      ...(parent ? [parent.signal] : []),
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ])
    combined.throwIfAborted()
    const ancestors: ContextViewApi[] = []
    const taskIds = new Map<ContextViewApi, string>()
    const sessionIds = new Map<ContextViewApi, string>()
    let ancestor = parentSessionId
    while (true) {
      const view = this.options.view(ancestor)
      const taskId = (await view.inspect())?.id
      if (!taskId) throw new AppError('MODEL_TOOL_SCOPE', '模型预算祖先没有活动逻辑任务')
      ancestors.unshift(view)
      taskIds.set(view, taskId)
      sessionIds.set(view, ancestor)
      const node = this.active.get(ancestor)
      if (!node) break
      ancestor = node.binding.parentSessionId
    }
    await this.claim(binding, combined)
    this.active.set(sessionId, { binding, controller, signal: combined })
    let closing: Optional<Promise<void>>
    return {
      binding,
      signal: combined,
      budget: {
        reserveModel: async (role, tokens, requestId) => {
          const reserved: ContextViewApi[] = []
          try {
            for (const view of ancestors) {
              combined.throwIfAborted()
              for (;;) {
                try {
                  await view.reserveModel(
                    role,
                    tokens,
                    requestId ? { requestId, taskId: taskIds.get(view)! } : undefined
                  )
                  break
                } catch (error) {
                  if (!requestId || (error as { code?: string }).code !== 'MODEL_RATE') throw error
                  await modelProviderRetry.wait(
                    (error as { retryAfterMs?: number }).retryAfterMs ??
                      ActRuntimeTuning.rateRetryMs,
                    combined
                  )
                }
              }
              reserved.push(view)
            }
            combined.throwIfAborted()
          } catch (error) {
            Log.tag('ActRuntime').debug('ModelToolRuntime 已进入异常处理或降级分支')
            const failures: unknown[] = [error]
            for (const view of reserved.reverse())
              try {
                await view.releaseModel(
                  role,
                  tokens,
                  requestId ? { requestId, taskId: taskIds.get(view)! } : undefined
                )
              } catch (release) {
                Log.tag('ActRuntime').debug('ModelToolRuntime 已进入异常处理或降级分支')
                failures.push(release)
              }
            if (failures.length > 1) throw new AggregateError(failures, '祖先预算预留回收失败')
            throw error
          }
        },
        transferModelReservation: async (reservationId, requestId) => {
          const failures = (
            await Promise.allSettled(
              ancestors.map((view) =>
                view.transferModelReservation(
                  { requestId: reservationId, taskId: taskIds.get(view)! },
                  requestId
                )
              )
            )
          ).flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
          if (failures.length === 1) throw failures[0]
          if (!isEmpty(failures)) throw new AggregateError(failures, '祖先收尾占位转交失败')
        },
        dispatchModel: async (requestId) => {
          const failures = (
            await Promise.allSettled(
              ancestors.map((view) => view.dispatchModel({ requestId, taskId: taskIds.get(view)! }))
            )
          ).flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
          if (failures.length === 1) throw failures[0]
          if (!isEmpty(failures)) throw new AggregateError(failures, '祖先模型派发登记失败')
        },
        releaseModel: async (role, tokens, requestId, confirmedNotDispatched) => {
          const failures = (
            await Promise.allSettled(
              ancestors.map((view) =>
                view.releaseModel(
                  role,
                  tokens,
                  requestId ? { requestId, taskId: taskIds.get(view)! } : undefined,
                  confirmedNotDispatched
                )
              )
            )
          ).flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
          if (failures.length === 1) throw failures[0]
          if (!isEmpty(failures)) throw new AggregateError(failures, '祖先预算归还失败')
        },
        recordUsage: async (input, output, requestId) => {
          if (requestId && binding.rootTaskId) {
            const receipt: ModelBudgetSettlement = {
              requestId,
              rootSessionId,
              rootTaskId: binding.rootTaskId,
              inputTokens: input,
              outputTokens: output,
              targets: ancestors.map((view) => ({
                sessionId: sessionIds.get(view)!,
                taskId: taskIds.get(view)!,
              })),
              status: 'pending',
            }
            readModelBudgetSettlement(receipt, rootSessionId)
            const context = createContextRuntime({
              sessionId: rootSessionId,
              storage: this.options.storage,
            })
            await context.append({
              kind: 'audit',
              title: 'model-budget:settlement',
              body: JSON.stringify(receipt),
            })
            try {
              await this.applyBudgetSettlement(receipt, ancestors)
            } catch (error) {
              this.budgetRecovery.delete(rootSessionId)
              this.budgetRecoveredSequence.delete(rootSessionId)
              throw error
            }
            return
          }
          const failures = (
            await Promise.allSettled(
              ancestors.map((view) =>
                view.recordUsage(
                  input,
                  output,
                  requestId ? { requestId, taskId: taskIds.get(view)! } : undefined
                )
              )
            )
          ).flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
          if (failures.length === 1) throw failures[0]
          if (!isEmpty(failures)) throw new AggregateError(failures, '祖先用量结算失败')
        },
      },
      close: () => {
        if (!closing) {
          controller.abort()
          closing = this.release(binding).finally(() => {
            if (this.active.get(sessionId)?.binding.activationId === binding.activationId)
              this.active.delete(sessionId)
          })
        }
        return closing
      },
    }
  }

  public model(sessionId: string, driver: ModelDriver): ModelDriver {
    return {
      id: driver.id,
      dispatchAware: true,
      get limits() {
        return driver.limits
      },
      nativeTools: driver.nativeTools,
      estimate: (request) => driver.estimate(request),
      stream: (request, signal, beforeDispatch) =>
        this.stream(sessionId, driver, request, signal, beforeDispatch),
    }
  }

  private async *stream(
    sessionId: string,
    driver: ModelDriver,
    request: ModelTurnRequest,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>
  ) {
    const scope = this.active.get(sessionId)
    if (!scope && !this.roots.has(sessionId))
      throw new AppError('MODEL_TOOL_CLOSED', '模型工具活动已结束')
    const combined = scope ? AbortSignal.any([signal, scope.signal]) : signal
    await this.recoverBudget(scope?.binding.rootSessionId ?? sessionId)
    await this.acquire(combined)
    try {
      combined.throwIfAborted()
      yield* modelRequestDispatcher.stream(driver, request, combined, beforeDispatch)
    } finally {
      this.running--
      this.queue.shift()?.()
    }
  }

  private recoverBudget(rootSessionId: string): Promise<void> {
    let pending = this.budgetRecovery.get(rootSessionId)
    if (!pending) {
      pending = this.recoverBudgetSettlements(rootSessionId).finally(() => {
        if (this.budgetRecovery.get(rootSessionId) === pending)
          this.budgetRecovery.delete(rootSessionId)
      })
      this.budgetRecovery.set(rootSessionId, pending)
    }
    return pending
  }

  private async recoverBudgetSettlements(rootSessionId: string): Promise<void> {
    const snapshot = await this.options.storage.load(rootSessionId)
    if (!snapshot) return
    const recovered = this.budgetRecoveredSequence.get(rootSessionId) ?? 0
    const latest = new Map<string, ModelBudgetSettlement>()
    for (const record of snapshot.records) {
      if (record.sequence <= recovered || record.title !== 'model-budget:settlement') continue
      const receipt = readModelBudgetSettlement(
        JSON.parse((await this.options.storage.get(rootSessionId, record.objectId))!),
        rootSessionId
      )
      latest.set(receipt.requestId, receipt)
    }
    for (const receipt of latest.values()) {
      if (receipt.status !== 'pending') continue
      const views = receipt.targets.map((target) =>
        createContextView({
          sessionId: target.sessionId,
          storage: this.options.storage,
          context: createContextRuntime({
            sessionId: target.sessionId,
            storage: this.options.storage,
          }),
          sources: [],
        })
      )
      await this.applyBudgetSettlement(receipt, views)
    }
    this.budgetRecoveredSequence.set(rootSessionId, snapshot.records.length)
  }

  private async applyBudgetSettlement(
    receipt: ModelBudgetSettlement,
    views: readonly ContextViewApi[]
  ): Promise<void> {
    let archived = false
    const results = await Promise.allSettled(
      views.map(async (view, index) => {
        const target = receipt.targets[index]
        const state = await view.inspect()
        if (state?.id !== target.taskId) {
          archived = true
          return
        }
        await view.recordUsage(receipt.inputTokens, receipt.outputTokens, {
          requestId: receipt.requestId,
          taskId: target.taskId,
        })
      })
    )
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length === 1) throw failures[0]
    if (!isEmpty(failures)) throw new AggregateError(failures, '祖先用量结算失败，持久回执可重试')
    const context = createContextRuntime({
      sessionId: receipt.rootSessionId,
      storage: this.options.storage,
    })
    await context.append({
      kind: 'audit',
      title: 'model-budget:settlement',
      body: JSON.stringify({ ...receipt, status: archived ? 'archived' : 'settled' }),
    })
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.running < this.policy.concurrency) {
      this.running++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', cancel)
        this.running++
        resolve()
      }
      const cancel = () => {
        const index = this.queue.indexOf(start)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal.reason)
      }
      this.queue.push(start)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
  }

  private async claim(binding: ModelToolBinding, signal: AbortSignal): Promise<void> {
    const title = `model-tool:node:${binding.sessionId}`
    for (let attempt = 0; attempt < 32; attempt++) {
      signal.throwIfAborted()
      const snapshot = await this.options.storage.load(binding.rootSessionId)
      if (!snapshot) throw new AppError('UNAVAILABLE', '模型工具根会话尚未建立')
      const records = [
        ...new Map(
          snapshot.records
            .filter((record) => record.title.startsWith('model-tool:node:'))
            .map((record) => [record.title, record])
        ).values(),
      ]
      const bindings: ModelToolBinding[] = []
      for (const record of records)
        bindings.push(
          JSON.parse((await this.options.storage.get(binding.rootSessionId, record.objectId))!)
        )
      const prior = bindings.find((node) => node.sessionId === binding.sessionId)
      if (
        prior &&
        (prior.parentSessionId !== binding.parentSessionId ||
          prior.kind !== binding.kind ||
          prior.rootTaskId !== binding.rootTaskId)
      )
        throw new AppError('MODEL_TOOL_SCOPE', '模型工具恢复归属不匹配')
      if (prior?.status === 'active' && prior.deadline > Date.now())
        throw new AppError('MODEL_TOOL_BUSY', '模型工具已有活动调用')
      if (snapshot.task?.id !== binding.rootTaskId)
        throw new AppError('MODEL_TOOL_SCOPE', '根任务已变化')
      const current = bindings.filter((node) => node.rootTaskId === binding.rootTaskId)
      // 整理是各会话的保留叶子槽，不消耗业务派发次数；调用成本仍受祖先总账约束。
      if (
        !prior &&
        binding.kind !== 'context' &&
        (current.filter((node) => node.kind !== 'context').length >= this.policy.maxSessions ||
          current.filter(
            (node) => node.kind !== 'context' && node.parentSessionId === binding.parentSessionId
          ).length >= this.policy.maxChildren)
      )
        throw new AppError('MODEL_TOOL_QUOTA', '模型工具会话配额耗尽')
      const body = JSON.stringify(binding)
      const objectId = await this.options.storage.put(binding.rootSessionId, body)
      const record = {
        ref: await createContextReference(this.options.storage, binding.rootSessionId),
        sequence: snapshot.records.length + 1,
        kind: 'audit' as const,
        title,
        objectId,
        chars: body.length,
        sources: [],
        createdAt: new Date().toISOString(),
      }
      signal.throwIfAborted()
      if (
        await this.options.storage.compareAndSwap(binding.rootSessionId, snapshot.version, {
          ...snapshot,
          version: snapshot.version + 1,
          records: [...snapshot.records, record],
        })
      )
        return
    }
    throw new AppError('MODEL_TOOL_BUSY', '模型工具占位持续冲突')
  }

  private async release(binding: ModelToolBinding): Promise<void> {
    const title = `model-tool:node:${binding.sessionId}`
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = await this.options.storage.load(binding.rootSessionId)
      const previous = snapshot?.records.findLast((record) => record.title === title)
      if (!snapshot || !previous) throw new AppError('NOT_FOUND', '模型工具活动记录丢失')
      const prior = JSON.parse(
        (await this.options.storage.get(binding.rootSessionId, previous.objectId))!
      ) as ModelToolBinding
      if (prior.activationId !== binding.activationId || prior.status === 'closed') return
      const body = JSON.stringify({ ...binding, status: 'closed' })
      const objectId = await this.options.storage.put(binding.rootSessionId, body)
      const record = {
        ...previous,
        ref: await createContextReference(this.options.storage, binding.rootSessionId),
        sequence: snapshot.records.length + 1,
        objectId,
        chars: body.length,
        createdAt: new Date().toISOString(),
      }
      if (
        await this.options.storage.compareAndSwap(binding.rootSessionId, snapshot.version, {
          ...snapshot,
          version: snapshot.version + 1,
          records: [...snapshot.records, record],
        })
      )
        return
    }
    throw new AppError('MODEL_TOOL_BUSY', '模型工具关闭占位持续冲突')
  }
}
