import type { ModelToolDelivery } from '@velaros-ai/agent'
import type { ContextStorage, ContextViewApi } from '@velaros-ai/context'
import { createContextRuntime } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isNull } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'
import type { ModelTurnRequest } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'

import { ModelToolLimits } from '../contract/constants.js'
import type { ModelBudgetPort } from '../types/model-budget.js'
import type { ModelToolBinding, ModelToolPolicy } from '../types/model-tools.js'
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
      throw new Error('交付报告不属于调用者')
    const producer = await this.options.storage.load(sessionId)
    const context = createContextRuntime({ sessionId: parent, storage: this.options.storage })
    const artifacts: Array<ModelToolDelivery['artifacts'][number]> = []
    for (const ref of evidence) {
      if (ref.sessionId !== sessionId && ref.sessionId !== parent)
        throw new Error('证据不属于生产者或调用者')
      const state = ref.sessionId === sessionId ? producer : caller
      const record = state?.records.find((item) => item.ref.id === ref.id)
      if (!record) throw new Error('交付证据不存在')
      const body = await this.options.storage.get(ref.sessionId, record.objectId)
      if (isNull(body)) throw new Error('共享证据原文缺失')
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
      if (isNull(body)) throw new Error('共享脚本原文缺失')
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
      throw new Error('模型工具调度上限必须为正整数')
  }

  public root(sessionId: string): void {
    if (this.active.has(sessionId)) throw new Error('子会话不能注册为根')
    this.roots.add(sessionId)
  }

  public releaseRoot(sessionId: string): void {
    this.roots.delete(sessionId)
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
      throw new Error('模型工具必须声明有限时限')
    if (!sessionId || sessionId === parentSessionId || this.roots.has(sessionId))
      throw Object.assign(new Error('模型工具身份与父会话冲突'), { code: 'MODEL_TOOL_SCOPE' })
    if (this.active.has(sessionId))
      throw Object.assign(new Error('模型工具已有活动调用'), { code: 'MODEL_TOOL_BUSY' })
    const parent = this.active.get(parentSessionId)
    if (!parent && !this.roots.has(parentSessionId))
      throw Object.assign(new Error('模型工具父会话不可用'), { code: 'MODEL_TOOL_SCOPE' })
    if (parent && parent.binding.kind !== 'agent')
      throw Object.assign(new Error('单一职责模型工具是叶子调用，不能派发其他模型工具或子任务'), {
        code: 'MODEL_TOOL_LEAF',
      })
    if (parent && kind === 'agent')
      throw Object.assign(new Error('只有主线可以派发业务子任务'), {
        code: 'MODEL_TOOL_DELEGATION',
      })
    const depth = (parent?.binding.depth ?? 0) + 1
    if (depth > this.policy.maxDepth)
      throw Object.assign(new Error('模型工具调用深度已达上限'), { code: 'MODEL_TOOL_DEPTH' })
    const rootSessionId = parent?.binding.rootSessionId ?? parentSessionId
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
    let ancestor = parentSessionId
    while (true) {
      ancestors.unshift(this.options.view(ancestor))
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
        reserveModel: async (role, tokens) => {
          const reserved: ContextViewApi[] = []
          try {
            for (const view of ancestors) {
              combined.throwIfAborted()
              await view.reserveModel(role, tokens)
              reserved.push(view)
            }
            combined.throwIfAborted()
          } catch (error) {
            Log.tag('ActRuntime').debug('ModelToolRuntime 已进入异常处理或降级分支')
            const failures: unknown[] = [error]
            for (const view of reserved.reverse())
              try {
                await view.releaseModel(role, tokens)
              } catch (release) {
                Log.tag('ActRuntime').debug('ModelToolRuntime 已进入异常处理或降级分支')
                failures.push(release)
              }
            if (failures.length > 1) throw new AggregateError(failures, '祖先预算预留回收失败')
            throw error
          }
        },
        releaseModel: async (role, tokens) => {
          const failures = (
            await Promise.allSettled(ancestors.map((view) => view.releaseModel(role, tokens)))
          ).flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
          if (failures.length === 1) throw failures[0]
          if (!isEmpty(failures)) throw new AggregateError(failures, '祖先预算归还失败')
        },
        recordUsage: async (input, output) => {
          const failures = (
            await Promise.allSettled(ancestors.map((view) => view.recordUsage(input, output)))
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
      get limits() {
        return driver.limits
      },
      estimate: (request) => driver.estimate(request),
      stream: (request, signal) => this.stream(sessionId, driver, request, signal),
    }
  }

  private async *stream(
    sessionId: string,
    driver: ModelDriver,
    request: ModelTurnRequest,
    signal: AbortSignal
  ) {
    const scope = this.active.get(sessionId)
    if (!scope && !this.roots.has(sessionId))
      throw Object.assign(new Error('模型工具活动已结束'), { code: 'MODEL_TOOL_CLOSED' })
    const combined = scope ? AbortSignal.any([signal, scope.signal]) : signal
    await this.acquire(combined)
    try {
      combined.throwIfAborted()
      yield* driver.stream(request, combined)
    } finally {
      this.running--
      this.queue.shift()?.()
    }
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
      if (!snapshot) throw new Error('模型工具根会话尚未建立')
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
        throw Object.assign(new Error('模型工具恢复归属不匹配'), { code: 'MODEL_TOOL_SCOPE' })
      if (prior?.status === 'active' && prior.deadline > Date.now())
        throw Object.assign(new Error('模型工具已有活动调用'), { code: 'MODEL_TOOL_BUSY' })
      if (snapshot.task?.id !== binding.rootTaskId)
        throw Object.assign(new Error('根任务已变化'), { code: 'MODEL_TOOL_SCOPE' })
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
        throw Object.assign(new Error('模型工具会话配额耗尽'), { code: 'MODEL_TOOL_QUOTA' })
      const body = JSON.stringify(binding)
      const objectId = await this.options.storage.put(binding.rootSessionId, body)
      const record = {
        ref: { sessionId: binding.rootSessionId, id: crypto.randomUUID() },
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
    throw Object.assign(new Error('模型工具占位持续冲突'), { code: 'MODEL_TOOL_BUSY' })
  }

  private async release(binding: ModelToolBinding): Promise<void> {
    const title = `model-tool:node:${binding.sessionId}`
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = await this.options.storage.load(binding.rootSessionId)
      const previous = snapshot?.records.findLast((record) => record.title === title)
      if (!snapshot || !previous) throw new Error('模型工具活动记录丢失')
      const prior = JSON.parse(
        (await this.options.storage.get(binding.rootSessionId, previous.objectId))!
      ) as ModelToolBinding
      if (prior.activationId !== binding.activationId || prior.status === 'closed') return
      const body = JSON.stringify({ ...binding, status: 'closed' })
      const objectId = await this.options.storage.put(binding.rootSessionId, body)
      const record = {
        ...previous,
        ref: { sessionId: binding.rootSessionId, id: crypto.randomUUID() },
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
    throw Object.assign(new Error('模型工具关闭占位持续冲突'), { code: 'MODEL_TOOL_BUSY' })
  }
}
