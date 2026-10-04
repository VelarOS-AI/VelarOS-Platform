import type { ActInputFile, AgentJob, AgentStart, AgentSupervisorApi } from '@velaros-ai/agent'
import { createAgentSupervisor } from '@velaros-ai/agent'
import { createContextInvocationJournal, createEvidenceAccess } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isFalse, isNull, isUndefined } from '@velaros-ai/core'
import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import type {
  ModuleDescription,
  ModulePage,
  ModuleQuery,
  OperationContext,
  OperationModuleDefinition,
  OperationRuntimeApi,
  OperationRuntimeCloseOptions,
  PendingInvocation,
} from '@velaros-ai/kernel'
import { createOperationRuntime } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'
import type { ScriptPackageDefinition } from '@velaros-ai/script'
import type { MemoryScopePort } from '@velaros-ai/velaros/memory'

import { EvidenceModuleId } from '../../search/contract/constants.js'
import type { AdvancedSearchApi } from '../../search/impl/AdvancedSearch.js'
import { AdvancedSearch } from '../../search/impl/AdvancedSearch.js'
import {
  ContextMaterialsModuleId,
  GoalModuleId,
  LocalMemoryModuleId,
  LongTermMemoryModuleIds,
  MemoryModuleId,
  PersistentMemoryModuleId,
  StoreModuleId,
  StoreReadModuleId,
  StoreWriteModuleId,
  SystemPackageSpecifier,
} from '../../system/contract/constants.js'
import type { StoreSessionApi } from '../../system/impl/StoreSession.js'
import { StoreSession } from '../../system/impl/StoreSession.js'
import { systemModules } from '../../system/impl/SystemModules.js'
import { systemMembers } from '../../system/utils/members.js'
import {
  ModelToolLimits,
  VelarosAgentBudget,
  VelarosAgentRunLimits,
  VelarosMainBudget,
  VelarosRunLimits,
} from '../contract/constants.js'
import type { VelarosRuntimeOptions } from '../contract/requires.js'
import type { ActTracePage, ActTraceQuery } from '../types/trace.js'

import { BudgetedModelDriver } from './BudgetedModelDriver.js'
import { ContextMaintenance } from './ContextMaintenance.js'
import { EffectScheduler } from './EffectScheduler.js'
import { ModelToolRuntime } from './ModelToolRuntime.js'
import type { RuntimeBootstrapOptions } from './RuntimeBootstrap.js'
import { runtimeBootstrap } from './RuntimeBootstrap.js'
import { RuntimeDiagnostics } from './RuntimeDiagnostics.js'
import type { RuntimeSessionAccess, VelarosSession } from './RuntimeSession.js'
import { RuntimeSession } from './RuntimeSession.js'
import { RuntimeTrace } from './RuntimeTrace.js'
import { RuntimeWorkspaceBinding } from './RuntimeWorkspaceBinding.js'
import { standardModules } from './StandardModules.js'

/** 一份由共享主干装配好的运行时。 */
export interface VelarosRuntime {
  /** 分页读取主线或持久归属下的支线原始上下文、响应、脚本与回执；不唤醒模型。 */
  trace(rootSessionId: string, input?: ActTraceQuery): Promise<ActTracePage>
  /** 宿主访问活动会话，包括子任务的交互回答；不存在时不创建。 */
  getSession(id: string): Optional<VelarosSession>
  /** 打开或恢复持久会话，先原子核对工作区绑定；同一实例内相同 id 复用句柄。 */
  openSession(id: string): Promise<VelarosSession>
  /** 查询实际挂载的模块目录。 */
  modules(query?: ModuleQuery): ModulePage
  /** 查看真实契约，脚本声明与校验同源。 */
  describe(moduleId: string): ModuleDescription
  /** 不含输入的在途调用身份与阶段；已请求取消的调用可能仍在真实执行。 */
  pending(): readonly PendingInvocation[]
  /** 有界等待关闭；TIMEOUT 附带 pending/phase，后台真实收束后才释放模块和存储。 */
  close(options?: OperationRuntimeCloseOptions): Promise<void>
}

class ComposedRuntime implements VelarosRuntime {
  private static readonly closeTimeoutMs = 5_000
  private shutdownPhase: 'openings' | 'sessions' | 'modules' | 'storage' | 'closed' = 'openings'
  private readonly maintenance?: ContextMaintenance
  private readonly taskModels = new Map<string, ModelDriver>()
  private readonly search?: AdvancedSearchApi
  private readonly agents?: AgentSupervisorApi
  private readonly tools: ModelToolRuntime
  private readonly scopes = new Map<
    string,
    {
      kind: 'main' | 'search' | 'agent' | 'context'
      modules?: readonly string[]
    }
  >()
  private readonly kernel: OperationRuntimeApi
  private readonly sessions = new Map<string, VelarosSession>()
  private closing?: Promise<void>
  private readonly effects = new EffectScheduler()
  private readonly diagnostics: RuntimeDiagnostics
  private readonly journal
  private readonly programAccess = new Map<string, RuntimeSessionAccess>()
  private readonly memories = new Map<string, MemoryScopePort>()
  private readonly stores = new Map<string, StoreSessionApi>()
  private readonly openings = new Map<string, Promise<VelarosSession>>()

  private readonly options: RuntimeBootstrapOptions
  public constructor(input: RuntimeBootstrapOptions) {
    this.diagnostics = new RuntimeDiagnostics(input.storage, input.onMetric)
    this.options = {
      ...input,
      storage: this.diagnostics.storage,
      context: {
        sources: [],
        ...input.context,
        limits: { ...VelarosMainBudget, ...input.context?.limits },
      },
    }
    const options = this.options
    if (
      options.modules.some(
        (module) =>
          [SystemPackageSpecifier, 'velaros:program', ContextMaterialsModuleId].includes(
            module.binding.moduleId
          ) || systemModules.owns(module.binding.moduleId)
      )
    )
      throw new AppError('VALIDATION', '业务模块占用了系统保留身份')
    if (options.modules.some((module) => module.binding.moduleId === 'velaros:memory'))
      throw new AppError(
        'VALIDATION',
        '长期记忆请通过 Runtime memory(sessionId) 装配到 velaros:system'
      )
    const journal = (this.journal = createContextInvocationJournal(options.storage))
    this.tools = new ModelToolRuntime({
      storage: options.storage,
      policy: options.modelTools,
      view: (id) => {
        const view = this.sessions.get(id)?.view
        if (!view) throw new AppError('UNAVAILABLE', '模型工具预算会话不可用')
        return view
      },
      deadline: (id) => this.programAccess.get(id)?.deadline(),
    })
    if (
      !isFalse(options.context?.maintenance) &&
      (options.model || options.agents || options.context?.maintenance?.model)
    )
      this.maintenance = new ContextMaintenance({
        preview: (id) => {
          const access = this.programAccess.get(id)
          if (!access) throw new AppError('UNAVAILABLE', '父会话不可用')
          return access
        },
        storage: options.storage,
        tools: this.tools,
        options: options.context?.maintenance,
        model: (id) => this.taskModels.get(id),
        open: async (id, model, tool, profile) => {
          this.scopes.set(id, { kind: 'context' })
          const materials = this.kernel.describe(ContextMaterialsModuleId)
          const contextTool = {
            ...tool,
            instructions: `本会话材料读取合同：\n${materials.declarations}\n${materials.template ?? ''}`,
          }
          const session = new RuntimeSession(id, {
            environment: options.environment,
            packages: [this.systemPackage(id)],
            allowedModules: () => this.allowedModuleIds(id),
            tool: contextTool,
            memory: { recentRecords: 32, recentShare: 0.4 },
            protocol: {
              ...options.protocol,
              allowed: ['blobs', 'execute', 'done'],
              defaultRetain: 'task',
            },
            journal,
            contextOptions: {
              sources: [],
              limits: { modelCalls: profile.modelCalls, modelTokens: profile.modelTokens },
            },
            kernel: this.kernel,
            runner: options.runner,
            storage: options.storage,
            model: this.tools.model(id, model),
            limits: {
              ...VelarosRunLimits,
              turns: profile.modelCalls,
              timeoutMs: profile.timeoutMs,
              outputTokens: profile.outputTokens,
              projectionChars: profile.projectionChars,
            },
            register: (access) => this.programAccess.set(id, access),
          })
          this.sessions.set(id, session)
          return session
        },
        close: async (id) => {
          try {
            await this.sessions.get(id)?.close()
          } finally {
            this.sessions.delete(id)
            this.programAccess.delete(id)
            this.scopes.delete(id)
          }
        },
      })
    if (options.agents)
      this.agents = createAgentSupervisor({
        deliver: (job, payload) =>
          this.tools.deliver(
            job.parentSessionId,
            job.sessionId,
            'agent',
            payload,
            job.status === 'completed'
              ? 'completed'
              : job.status === 'waiting'
                ? 'partial'
                : 'failed',
            [],
            {
              operation: 'agents.resume',
              input: { id: job.id, input: '继续完成交付中未完成的事项。' },
            }
          ),
        storage: options.storage,
        concurrency: options.agents.concurrency,
        maxChildren: options.agents.maxChildren,
        open: (job, input, signal) => this.openChild(job, input, signal),
      })
    if (options.search)
      this.search = new AdvancedSearch({
        tools: this.tools,
        storage: options.storage,
        evidence: createEvidenceAccess(options.context?.sources ?? []),
        parentDeadline: (id) => this.programAccess.get(id)?.deadline(),
        options: { ...options.search, profiles: structuredClone(options.search.profiles) },
        view: (id) => {
          const view = this.sessions.get(id)?.view
          if (!view) throw new AppError('UNAVAILABLE', '父任务尚未打开')
          return view
        },
        open: async (id, activation, profile) => {
          this.scopes.set(id, { kind: 'search' })
          const evidence = this.kernel.describe(EvidenceModuleId)
          const session = new RuntimeSession(id, {
            environment: options.environment,
            packages: [this.systemPackage(id)],
            allowedModules: () => this.allowedModuleIds(id),
            tool: {
              instructions: `本会话证据合同：\n${evidence.declarations}`,
              pressure: () => activation.pressure(),
              deadline: () => activation.deadline(),
              phase: () => activation.phase(),
              material: (maxChars) => activation.material(maxChars),
              refresh: (signal) => activation.refresh(signal),
              authorizeReference: (ref, signal) => activation.authorizeReference(ref, signal),
            },
            memory: { recentRecords: 64, recentShare: 0.4, ...options.search?.memory },
            protocol: {
              ...options.protocol,
              allowed: ['blobs', 'execute', 'done'],
              defaultRetain: 'task',
            },
            journal: this.journal,
            contextOptions: {
              sources: [],
              policy: options.search?.contextPolicy,
              limits: { modelCalls: profile.modelCalls, modelTokens: profile.modelTokens },
            },
            kernel: this.kernel,
            runner: options.runner,
            storage: options.storage,
            model: this.tools.model(id, activation),
            limits: {
              ...(options.limits ?? VelarosRunLimits),
              turns: profile.modelCalls,
              timeoutMs: profile.timeoutMs,
              outputTokens: profile.outputTokens,
              projectionChars: profile.projectionChars,
            },
            register: (access) => this.programAccess.set(id, access),
          })
          this.sessions.set(id, session)
          return session
        },
        close: async (id) => {
          try {
            await this.sessions.get(id)?.close()
          } finally {
            this.sessions.delete(id)
            this.programAccess.delete(id)
            this.scopes.delete(id)
          }
        },
      })
    this.kernel = createOperationRuntime({
      journal,
      beforeDispatch: async (invocation, descriptor, signal) => {
        if (!this.allows(invocation.sessionId, invocation.binding.moduleId))
          throw new AppError('CAPABILITY_DENIED', '当前会话没有此模块能力')
        await this.options.authorize?.(invocation, descriptor, signal)
        if (
          this.programAccess.get(invocation.sessionId)?.phase() === 'maintenance' &&
          !systemModules.owns(invocation.binding.moduleId)
        )
          throw new AppError('CONTEXT_MAINTENANCE', '上下文维护轮不派发业务能力')
        await this.search?.authorize(invocation, descriptor, signal)
        if (
          invocation.mode === 'observe' ||
          descriptor.effects !== 'write' ||
          systemModules.owns(invocation.binding.moduleId)
        )
          return
        const view = this.sessions.get(invocation.sessionId)?.view
        if (!view) throw new AppError('UNAVAILABLE', '任务视图不可用')
        await view.assertCanWrite(invocation.executionId, signal)
      },
      modules: [
        ...standardModules.create({
          agentProfiles: () =>
            Object.entries(options.agents?.profiles ?? {}).map(([name, profile]) => ({
              name,
              description: profile.description ?? '在指定能力范围内完成父任务派发的工作',
              modules: profile.modules.filter((module) => module !== 'velaros:agents'),
              turns: profile.limits?.turns ?? VelarosAgentRunLimits.turns,
              timeoutMs: profile.limits?.timeoutMs ?? VelarosAgentRunLimits.timeoutMs,
              modelCalls: profile.budget?.modelCalls ?? VelarosAgentBudget.modelCalls,
              modelTokens: profile.budget?.modelTokens ?? VelarosAgentBudget.modelTokens,
            })),
          stores: options.storage.stores
            ? {
                stores: (id) => {
                  const state = this.stores.get(id)
                  if (!state)
                    throw AppError.withFields('STORE_DENIED', '当前会话未获配共享状态', {
                      effect: 'none',
                    })
                  return state
                },
              }
            : undefined,
          longTermMemory: options.memory
            ? {
                organize: Boolean(
                  this.maintenance &&
                  (options.model ||
                    (options.context?.maintenance && options.context.maintenance.model))
                ),
                scope: (id) => {
                  const memory = this.memories.get(id)
                  if (!memory) throw new AppError('UNAVAILABLE', '主会话长期记忆未装配')
                  return memory
                },
              }
            : undefined,
          maintenance: this.maintenance,
          agents: this.agents,
          widgets: options.widgets,
          allows: (id, module) => this.allows(id, module),
          search: this.search,
          journal,
          kernel: () => this.kernel,
          programs: (id) => {
            const access = this.programAccess.get(id)
            if (!access) throw new AppError('UNAVAILABLE', '会话尚未打开')
            return access
          },
          programCatalog: (id) => {
            const access = this.programAccess.get(id)
            if (!access) throw new AppError('UNAVAILABLE', '会话尚未打开')
            return access.programCatalog
          },
          view: (id) => {
            const view = this.sessions.get(id)?.view
            if (!view) throw new AppError('SESSION_NOT_OPEN', '当前会话尚未打开')
            return view
          },
        }),
        ...options.modules,
      ].map((module) => this.scheduleEffects(module)),
    })
  }

  private systemPackage(id: string): ScriptPackageDefinition {
    const allowed = new Set(this.allowedModuleIds(id))
    return {
      specifier: SystemPackageSpecifier,
      exports: Object.fromEntries(systemMembers((module) => allowed.has(module))),
    }
  }

  private allowedModuleIds(id: string): readonly string[] {
    const ids: string[] = []
    let offset: Nullable<number> = 0
    while (!isNull(offset)) {
      const page = this.kernel.list({ offset })
      ids.push(
        ...page.items
          .filter((item) => this.allows(id, item.binding.moduleId))
          .map((item) => item.binding.moduleId)
      )
      offset = page.nextOffset
    }
    return ids
  }

  private allows(id: string, module: string): boolean {
    const scope = this.scopes.get(id)
    if (!scope) return false
    if (module === GoalModuleId) return scope.kind === 'main'
    if (module === ContextMaterialsModuleId)
      return scope.kind === 'context' && Boolean(this.maintenance?.active(id))
    if (scope.kind === 'context') return false
    if (module === 'velaros:interaction') return scope.kind === 'main' || scope.kind === 'agent'
    if (module === StoreModuleId || module === StoreWriteModuleId || module === StoreReadModuleId) {
      const stores = this.stores.get(id)
      return Boolean(
        stores &&
        module ===
          (stores.mode === 'create'
            ? StoreModuleId
            : stores.mode === 'write'
              ? StoreWriteModuleId
              : StoreReadModuleId)
      )
    }
    if (LongTermMemoryModuleIds.includes(module))
      return scope.kind === 'main' && Boolean(this.options.memory)
    if (module === LocalMemoryModuleId)
      return (
        scope.kind === 'search' ||
        (!this.allows(id, MemoryModuleId) && !this.allows(id, PersistentMemoryModuleId))
      )
    if (scope.kind === 'search')
      return module !== MemoryModuleId && !!this.search?.allows(id, module)
    if (scope.kind !== 'main' && module === 'velaros:agents') return false
    if (
      scope.kind === 'agent' &&
      (this.options.modelTools?.maxDepth ?? ModelToolLimits.maxDepth) < 2 &&
      (module === MemoryModuleId || module === 'velaros:search')
    )
      return false
    if (module === MemoryModuleId)
      return (
        !this.allows(id, PersistentMemoryModuleId) &&
        Boolean(
          this.maintenance &&
          (this.taskModels.has(id) ||
            (this.options.context?.maintenance && this.options.context.maintenance.model))
        )
      )
    if (scope.modules && !scope.modules.includes(module) && !systemModules.owns(module))
      return false
    return module !== 'velaros:evidence'
  }

  private async openChild(job: AgentJob, input: Optional<AgentStart>, signal: AbortSignal) {
    const profile = this.options.agents?.profiles[job.profile]
    const parent = this.sessions.get(job.parentSessionId)
    if (!profile || !parent) throw new AppError('UNAVAILABLE', '子任务配置或父任务不可用')
    if (this.scopes.get(job.parentSessionId)?.kind !== 'main')
      throw new AppError('PERMISSION', '只有主线可以派发业务子任务')
    const childLimits = {
      ...VelarosAgentRunLimits,
      outputTokens: profile.model.limits.outputTokens,
      ...profile.limits,
    }
    const modules = profile.modules.filter((module) => module !== 'velaros:agents')
    for (const module of modules)
      if (!this.allows(job.parentSessionId, module))
        throw new AppError('VALIDATION', '子任务能力不能超过父任务')
    // 子任务直接继承父任务此刻能用的共享空间与读写范围；父任务能建空间，子任务也能建（归它自己）
    let childStores: Optional<StoreSessionApi>
    const parentStores = this.stores.get(job.parentSessionId)
    if (parentStores) {
      childStores = new StoreSession(job.sessionId, this.options.storage, {
        scope: parentStores.scope,
        create: parentStores.mode === 'create',
        grants: await parentStores.inherit(),
      })
      await childStores.initialize()
    }
    const activity = await this.tools.begin(
      job.sessionId,
      job.parentSessionId,
      'agent',
      childLimits.timeoutMs,
      signal
    )
    if (childStores) this.stores.set(job.sessionId, childStores)
    this.scopes.set(job.sessionId, { kind: 'agent', modules })
    this.taskModels.set(job.sessionId, profile.model)
    const model = new BudgetedModelDriver({
      model: profile.model,
      parent: activity.budget,
      signal: activity.signal,
    })
    let session: VelarosSession
    try {
      session = new RuntimeSession(job.sessionId, {
        node: profile.node ? this.options.node : undefined,
        environment: this.options.environment,
        maintain: this.allows(job.sessionId, MemoryModuleId)
          ? (input, signal) => this.maintenance!.maintain(job.sessionId, input, signal)
          : undefined,
        stores: this.stores.get(job.sessionId),
        packages: [this.systemPackage(job.sessionId)],
        allowedModules: () => this.allowedModuleIds(job.sessionId),
        agents: this.agents,
        settleModelTools: (executionId) =>
          this.search?.settleExecution(job.sessionId, executionId) ?? Promise.resolve(),
        memory: profile.memory,
        protocol: this.options.protocol,
        journal: this.journal,
        contextOptions: {
          ...this.options.context!,
          limits: { ...this.options.context?.limits, ...VelarosAgentBudget, ...profile.budget },
        },
        kernel: this.kernel,
        runner: this.options.runner,
        storage: this.options.storage,
        model: this.tools.model(job.sessionId, model),
        limits: childLimits,
        register: (access) => this.programAccess.set(job.sessionId, access),
      })
    } catch (error) {
      const settled = await Promise.allSettled([model.close(), activity.close()])
      this.programAccess.delete(job.sessionId)
      this.scopes.delete(job.sessionId)
      this.stores.delete(job.sessionId)
      this.taskModels.delete(job.sessionId)
      const failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (!isEmpty(failures)) throw new AggregateError([error, ...failures], '子会话建立和清理失败')
      throw error
    }
    this.sessions.set(job.sessionId, session)
    const files: ActInputFile[] = []
    try {
      for (const ref of input?.materials ?? []) {
        if (ref.sessionId !== job.parentSessionId)
          throw new AppError('VALIDATION', '只能分享父任务已经持有的原文')
        const source = (await this.options.storage.load(ref.sessionId))?.records.find(
          (r) => r.ref.id === ref.id
        )
        if (!source) throw new AppError('NOT_FOUND', '共享材料不存在')
        const body = await this.options.storage.get(ref.sessionId, source.objectId)
        if (isNull(body)) throw new AppError('NOT_FOUND', '共享原文缺失')
        signal.throwIfAborted()
        const copied = await session.context.append({
          kind: 'note',
          title: 'shared:material',
          body,
        })
        await session.context.append({
          kind: 'audit',
          title: 'shared:provenance',
          body: JSON.stringify({
            source: ref,
            objectId: source.objectId,
            copy: copied.ref,
            profile: job.profile,
          }),
        })
        files.push({ ref: copied.ref, name: source.title || ref.id, mediaType: 'text/plain' })
      }
    } catch (error) {
      const cleanup = await Promise.allSettled([session.close(), model.close()])
      try {
        await activity.close()
      } finally {
        this.sessions.delete(job.sessionId)
        this.programAccess.delete(job.sessionId)
        this.scopes.delete(job.sessionId)
        this.stores.delete(job.sessionId)
        this.taskModels.delete(job.sessionId)
      }
      const failures = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (!isEmpty(failures))
        throw new AggregateError([error, ...failures], '子会话启动失败且清理异常')
      throw error
    }
    return {
      submit: (value: Parameters<typeof session.submit>[0], runSignal?: AbortSignal) =>
        session.submit(
          !isEmpty(files) ? { ...(isString(value) ? { text: value } : value), files } : value,
          AbortSignal.any([activity.signal, ...(runSignal ? [runSignal] : [])])
        ),
      answer: (value: Parameters<typeof session.answer>[0]) => session.answer(value),
      steer: (value: Parameters<typeof session.steer>[0]) => session.steer(value),
      cancel: () => session.cancel(),
      close: async () => {
        const results = await Promise.allSettled([session.close(), model.close()])
        this.sessions.delete(job.sessionId)
        this.programAccess.delete(job.sessionId)
        this.scopes.delete(job.sessionId)
        this.stores.delete(job.sessionId)
        this.taskModels.delete(job.sessionId)
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
        try {
          await activity.close()
        } catch (error) {
          Log.tag('ActRuntime').debug('ComposedRuntime 已进入异常处理或降级分支')
          failures.push(error)
        }
        if (!isEmpty(failures)) throw new AggregateError(failures, '子会话和父预算清理失败')
      },
    }
  }

  private scheduleEffects(module: OperationModuleDefinition): OperationModuleDefinition {
    return {
      ...module,
      operations: Object.fromEntries(
        Object.entries(module.operations).map(([name, operation]) => [
          name,
          operation.effects === 'none'
            ? operation
            : {
                ...operation,
                run: (input, call) => this.withEffectGate(call, () => operation.run(input, call)),
                observe: operation.observe
                  ? (input: unknown, call: OperationContext) =>
                      this.withEffectGate(call, () => operation.observe!(input, call))
                  : undefined,
              },
        ])
      ),
    }
  }

  private async withEffectGate(
    call: OperationContext,
    run: () => unknown | Promise<unknown>
  ): Promise<unknown> {
    let release = (): void => {}
    const queuedAt = performance.now()
    let started: Optional<number>
    let succeeded = false
    try {
      try {
        call.signal.throwIfAborted()
        release = await this.effects.acquire(
          this.options.effectResources?.(call.invocation),
          call.signal
        )
        call.signal.throwIfAborted()
        started = performance.now()
        this.diagnostics.record({
          phase: 'effect-wait',
          sessionId: call.invocation.sessionId,
          executionId: call.invocation.executionId,
          operation: `${call.invocation.binding.moduleId}.${call.invocation.operation}`,
          durationMs: started - queuedAt,
          succeeded: true,
        })
        if (
          call.invocation.mode !== 'observe' &&
          !systemModules.owns(call.invocation.binding.moduleId)
        ) {
          await this.sessions
            .get(call.invocation.sessionId)!
            .view.assertCanWrite(call.invocation.executionId, call.signal)
        }
        call.signal.throwIfAborted()
      } catch (error) {
        call.recordEffect('none')
        throw error
      }
      const value = await run()
      succeeded = true
      return value
    } finally {
      const ended = performance.now()
      release()
      this.diagnostics.record({
        phase: isUndefined(started) ? 'effect-wait' : 'effect-run',
        sessionId: call.invocation.sessionId,
        executionId: call.invocation.executionId,
        operation: `${call.invocation.binding.moduleId}.${call.invocation.operation}`,
        durationMs: ended - (started ?? queuedAt),
        succeeded,
      })
    }
  }

  public async openSession(id: string): Promise<VelarosSession> {
    const prior = this.openings.get(id)
    if (prior) return prior
    const opening = this.openMain(id)
    this.openings.set(id, opening)
    try {
      return await opening
    } finally {
      if (this.openings.get(id) === opening) this.openings.delete(id)
    }
  }

  private async openMain(id: string): Promise<VelarosSession> {
    if (
      this.closing ||
      !id ||
      id.startsWith('search:') ||
      id.startsWith('agent:') ||
      id.startsWith('context:') ||
      id.startsWith('store-material:')
    )
      throw new AppError('CLOSED', '运行时已关闭或会话身份无效')
    await new RuntimeWorkspaceBinding(this.options.storage, this.options.workspace).bind(id)
    if (this.closing) throw new AppError('CLOSED', '运行时已关闭')
    await this.kernel.start()
    if (this.closing) throw new AppError('CLOSED', '运行时已关闭')
    let session = this.sessions.get(id)
    if (!session) {
      try {
        const configuration = this.options.stores
          ? this.options.stores(id)
          : this.options.storage.stores
            ? { scope: `session:${id}` }
            : undefined
        if (configuration) {
          if (!this.options.storage.stores)
            throw new AppError('UNAVAILABLE', '当前 ContextStorage 未实现持久 store')
          const stores = new StoreSession(id, this.options.storage, configuration)
          await stores.initialize()
          if (this.closing) throw new AppError('CLOSED', '运行时已关闭')
          this.stores.set(id, stores)
        }
        const memory = this.options.memory?.(id)
        if (memory) this.memories.set(id, memory)
        this.scopes.set(id, { kind: 'main' })
        this.tools.root(id)
        if (this.options.model) this.taskModels.set(id, this.options.model)
        session = new RuntimeSession(id, {
          node: this.options.node,
          instructions: this.options.instructions,
          residentModules: this.options.residentModules,
          environment: this.options.environment,
          maintain:
            this.maintenance &&
            (this.options.model ||
              (this.options.context?.maintenance && this.options.context.maintenance.model))
              ? (input, signal) => this.maintenance!.maintain(id, input, signal)
              : undefined,
          stores: this.stores.get(id),
          packages: [this.systemPackage(id)],
          allowedModules: () => this.allowedModuleIds(id),
          agents: this.agents,
          settleModelTools: (executionId) =>
            this.search?.settleExecution(id, executionId) ?? Promise.resolve(),
          protocol: this.options.protocol,
          inputs: this.options.inputs ? () => this.options.inputs!(id) : undefined,
          journal: this.journal,
          contextOptions: this.options.context,
          kernel: this.kernel,
          runner: this.options.runner,
          storage: this.options.storage,
          model: this.options.model ? this.tools.model(id, this.options.model) : undefined,
          limits: this.options.limits ?? VelarosRunLimits,
          renewRuns: true,
          closed: () => {
            if (this.sessions.get(id) === session) this.releaseMain(id)
          },
          register: (access) => {
            this.programAccess.set(id, access)
          },
        })
        this.sessions.set(id, session)
      } catch (error) {
        this.releaseMain(id)
        throw error
      }
    }
    return session
  }

  private releaseMain(id: string): void {
    this.sessions.delete(id)
    this.programAccess.delete(id)
    this.scopes.delete(id)
    this.stores.delete(id)
    this.memories.delete(id)
    this.taskModels.delete(id)
    this.tools.releaseRoot(id)
  }

  public async trace(rootSessionId: string, input?: ActTraceQuery): Promise<ActTracePage> {
    if (this.closing) throw new AppError('CLOSED', '运行时已关闭')
    return new RuntimeTrace(rootSessionId, this.options.storage, this.journal).page(input)
  }

  public getSession(id: string) {
    return this.sessions.get(id)
  }

  public modules(query?: ModuleQuery): ModulePage {
    return this.kernel.list(query)
  }
  public describe(moduleId: string): ModuleDescription {
    return this.kernel.describe(moduleId)
  }

  public pending(): readonly PendingInvocation[] {
    return this.kernel.pending()
  }

  public async close(options: OperationRuntimeCloseOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? ComposedRuntime.closeTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new AppError('VALIDATION', '关闭等待时限必须是非负有限数字')
    this.closing ??= this.shutdown()
    const timers = new TimerScope({ name: 'ComposedRuntime.close' })
    let deadline: Optional<AbortSignal>
    try {
      await timers.withTimeout(timeoutMs, (signal) => {
        deadline = signal
        return this.closing!
      })
    } catch (error) {
      if (deadline?.aborted)
        throw AppError.withFields('TIMEOUT', '运行时尚未完成真实收束，后台继续保留资源', {
          pending: this.pending(),
          phase: this.shutdownPhase,
        })
      throw error
    } finally {
      timers.dispose()
    }
  }

  private async shutdown(): Promise<void> {
    const failures: unknown[] = []
    // 先向现有会话广播关闭；一个未合作的 opening 或子会话不能延迟其他会话的取消。
    const sessions = Promise.allSettled([
      ...(this.agents ? [this.agents.close()] : []),
      ...[...this.sessions.values()].map((session) => session.close()),
    ])
    await Promise.allSettled([...this.openings.values()])
    this.shutdownPhase = 'sessions'
    for (const result of await sessions)
      if (result.status === 'rejected') failures.push(result.reason)
    try {
      this.shutdownPhase = 'modules'
      await this.kernel.drain()
    } catch (error) {
      Log.tag('ActRuntime').debug('ComposedRuntime 已进入异常处理或降级分支')
      failures.push(error)
    }
    try {
      this.shutdownPhase = 'storage'
      await this.options.storage.close()
    } catch (error) {
      Log.tag('ActRuntime').debug('ComposedRuntime 已进入异常处理或降级分支')
      failures.push(error)
    }
    this.sessions.clear()
    this.programAccess.clear()
    this.memories.clear()
    this.stores.clear()
    this.scopes.clear()
    this.taskModels.clear()
    this.shutdownPhase = 'closed'
    if (!isEmpty(failures))
      throw new AggregateError(failures, 'Runtime 关闭失败；已尝试释放全部资源')
  }
}

/** 宿主提供模型周边资源，一份实例图统一维护模块、脚本与上下文。 */
export async function createRuntime(options: VelarosRuntimeOptions): Promise<VelarosRuntime> {
  const configured = await runtimeBootstrap.prepare(options)
  try {
    return new ComposedRuntime(configured)
  } catch (error) {
    try {
      if (!options.storage) await configured.storage.close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Runtime 初始化及存储清理失败')
    }
    throw error
  }
}
