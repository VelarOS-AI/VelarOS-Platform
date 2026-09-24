import type {
  ActAnswer,
  ActEvent,
  ActInput,
  ActInteraction,
  ActRunEvent,
  ActRunLimits,
  ActRunServiceApi,
  ActRunSnapshot,
  AgentJob,
  AgentSupervisorApi,
} from '@velaros-ai/agent'
import { createActRunService } from '@velaros-ai/agent'
import type {
  ContextFeedback,
  ContextInvocationJournalApi,
  ContextRef,
  ContextRuntime,
  ContextStorage,
  ContextViewApi,
  ModelView,
} from '@velaros-ai/context'
import { createContextRuntime, createContextView } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isNull, isUndefined, toNullable, toOptional } from '@velaros-ai/core'
import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelImage, ModelTurnRequest, OperationRuntimeApi } from '@velaros-ai/kernel'
import type { ModelDriver } from '@velaros-ai/model'
import { createProviderRequestCompiler } from '@velaros-ai/model'
import type {
  CodeProgramRequest,
  CodeRunnerApi,
  CodeSurfaceOutcome,
  ScriptPackageDefinition,
} from '@velaros-ai/script'
import { createKernelScriptSession } from '@velaros-ai/script'

import {
  LongTermMemoryModuleIds,
  ScriptLeaseLimits,
  StoreProjectionLimits,
} from '../../system/contract/constants.js'
import type { ContextCandidateValidator } from '../../system/contract/requires.js'
import type { StoreSessionApi } from '../../system/impl/StoreSession.js'
import type { GoalControl, GoalState, GoalUpdate } from '../../system/types/goal.js'
import type { WorkspaceEntry } from '../../system/types/workspace.js'
import { isSystemMember } from '../../system/utils/members.js'
import type { VelarosContextOptions } from '../contract/requires.js'
import type { RuntimeNoteContent, RuntimeNoteRead, RuntimeNoteRetention } from '../types/memory.js'
import type { ContextMemoryPolicy } from '../types/memory.js'
import type { PreparedScript, ScriptProtocolSubmission } from '../types/program.js'
import type { ScriptRetention } from '../types/results.js'
import type {
  ObservationRegistration,
  ScriptControlIdentity,
  ScriptControlOptions,
  ScriptControlReceipt,
  ScriptDecisionBasis,
  ScriptObservationEdit,
  ScriptProgramVersion,
  ScriptProtocolOptions,
  ScriptReferenceProgram,
} from '../types/runtime.js'
import type {
  ScriptExecutionReceipt,
  ScriptSourceProgram,
  ScriptSubmission,
  ScriptSubmissionReceipt,
} from '../types/session.js'
import type { ActTurnTrace } from '../types/trace.js'
import { memoryPrompt } from '../utils/context-memory.js'
import { runtimeInstructions } from '../utils/model-instructions.js'
import {
  recoverScriptSubmission,
  scriptControlIdentity,
  stableProgramJson,
} from '../utils/program-context.js'
import { protocolConfig } from '../utils/script-protocol.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

import type { ContextMemoryApi } from './ContextMemory.js'
import { ContextMemory } from './ContextMemory.js'
import type { ProgramContextApi } from './ProgramContext.js'
import { ProgramContext } from './ProgramContext.js'
import type { RecentContextApi } from './RecentContext.js'
import { RecentContext } from './RecentContext.js'
import { RuntimeTrace } from './RuntimeTrace.js'
import { ScriptTurnDecoder } from './ScriptTurnDecoder.js'
import type { SessionGoalApi } from './SessionGoal.js'
import { SessionGoal } from './SessionGoal.js'
import { standardModules } from './StandardModules.js'

/** 标准模块持有的源码与结果访问端口。 */
export interface RuntimeSessionAccess extends ContextCandidateValidator {
  /** 模型与宿主共用的会话目标。 */
  readonly goal: SessionGoalApi
  /** 写入闸门内核对本执行实际看到的资源依据。 */
  validateDecision(executionId: string, signal: AbortSignal): Promise<void>
  /** 父运行的取消权，独立于单次脚本调用。 */
  runSignal(): AbortSignal
  /** 当前会话的统一工作区。 */
  readonly memory: ContextMemoryApi
  /** 通过当前 Act 运行发起用户交互。 */
  interact(
    kind: 'input' | 'confirmation' | 'capability',
    message: string,
    signal: AbortSignal,
    detail?: unknown
  ): Promise<unknown>
  /** 当前会话的用户输入归档。 */
  readonly context: ContextRuntime
  /** 当前请求阶段由宿主设置。 */
  phase(): 'work' | 'maintenance' | 'finalizing'
  /** 当前主运行的绝对截止时间；纯宿主脚本可未声明。 */
  deadline(): Optional<number>
}

/** 单一职责模型工具复用普通会话，只注入专项阶段、材料边界与结果校验。 */
export interface RuntimeSessionModelTool {
  /** 专项的固定说明（如能力合同），会话内不变，进入系统提示。 */
  readonly instructions?: string
  /** 叶子会话容量预警时直接进入交付阶段。 */
  pressure(): void
  /** 当前模型请求的截止时间。 */
  deadline(): number
  /** 有界工作与最终交付的指令。 */
  phase(): { phase: 'work' | 'maintenance' | 'finalizing'; instructions: string }
  /** 返回受预算约束的专项运行事实，作为数据进入 runtime 分区。 */
  material?(maxChars: number): unknown
  /** 模型响应接纳后确认原请求中的专项材料，估算和候选编译不计入展示。 */
  acknowledge?(material: unknown): void
  /** 下一轮前检查专项材料状态。 */
  refresh(signal: AbortSignal): Promise<void>
  /** 读取保存脚本时仍遵守当前授权代次。 */
  authorizeReference(ref: ContextRef, signal: AbortSignal): Promise<void>
}

/** 会话由运行时注入的共享实例。 */
export interface RuntimeSessionDependencies {
  /** 主会话的可信宿主产品指令；与运行协议一起编译和归档。 */
  readonly instructions?: string
  /** 常驻模块：本会话可用的那些把声明与用法示例附进运行说明。 */
  readonly residentModules?: readonly string[]
  /** 会话全部资源收束后撤回宿主持有的活动句柄。 */
  closed?(): void
  /** 固定授权的持久状态及订阅交付。 */
  readonly stores?: StoreSessionApi
  /** 主线：回合与墙钟上限到点时封段续跑，而不是结束运行。 */
  readonly renewRuns?: boolean
  /** 在请求边界调用独立上下文工具。 */
  maintain?(
    input: { reason: 'boundary' | 'pressure' | 'provider' | 'narrate'; targetChars: number },
    signal: AbortSignal
  ): Promise<boolean>
  /** 当前装配的虚拟包，由声明与运行器共同使用。 */
  readonly packages: readonly ScriptPackageDefinition[]
  /** 当前宿主范围中的模块；发现、类型检查和执行共用它。 */
  allowedModules(): readonly string[]
  /** 同一子运行调度器。 */
  readonly agents?: AgentSupervisorApi
  /** 投影策略与协议独立。 */
  readonly memory?: ContextMemoryPolicy
  /** 模型工具共享执行器，注入独立阶段及专项结果校验。 */
  readonly tool?: RuntimeSessionModelTool
  /** 父执行结算前等待模型工具归还预算、关闭会话并释放执行权。 */
  settleModelTools?(executionId: string): Promise<void>

  /** 每帧固定的协议选项。 */
  readonly protocol?: ScriptProtocolOptions
  /** 当前会话的宿主参数读取口。 */
  inputs?(): Readonly<Record<string, unknown>>
  /** 统一调用日志，可按本步查询真实效果。 */
  readonly journal: ContextInvocationJournalApi
  /** 上下文来源与验收的宿主配置。 */
  readonly contextOptions?: VelarosContextOptions
  /** 注册本会话的源码与结果访问端口，装配层负责生命周期。 */
  register(access: RuntimeSessionAccess): void
  /** 可选的共享模型驱动。 */
  readonly model?: ModelDriver
  /** 本会话的运行预算。 */
  readonly limits: ActRunLimits
  /** 唯一 Kernel 实例。 */
  readonly kernel: OperationRuntimeApi
  /** 显式隔离运行器。 */
  readonly runner: CodeRunnerApi
  /** 可靠存储连接。 */
  readonly storage: ContextStorage
}

/** 一个会话共享上下文，模型回合有序，执行任务按并发预算运行。 */
export interface VelarosSession {
  /** 读取目标生命周期；与执行状态独立。 */
  getGoal(): Promise<Nullable<GoalState>>
  /** 已登记输入的会话中按版本创建或更新目标。 */
  updateGoal(input: GoalUpdate): Promise<GoalState>
  /** 用户侧目标控制，包括保留历史的删除。 */
  controlGoal(input: GoalControl): Promise<GoalState>
  /** 双核任务检查点与视图，仅宿主可访问完整控制面。 */
  readonly view: ContextViewApi
  /** 会话的稳定身份。 */
  readonly id: string
  /** 宿主记录输入、读取原文和投影下一次请求的入口。 */
  readonly context: ContextRuntime
  /** 由共享 Agent 循环处理用户输入、脚本与上下文维护。 */
  submit(input: string | ActInput, signal?: AbortSignal): AsyncIterable<ActRunEvent>
  /** 运行中追加用户输入，抢占尚未派发的模型响应。 */
  steer(input: string | ActInput): Promise<void>
  /** 回答当前运行的指定交互。 */
  answer(answer: ActAnswer): Promise<void>
  /** 读取持久运行状态。 */
  inspect(): Promise<ActRunSnapshot>
  /** 宿主等待获配空间的新变化；只返回唤醒信号，不自行启动或复活模型任务。 */
  waitForChanges(signal: AbortSignal): Promise<void>
  /** 按事件游标回放真实执行进展。 */
  events(after?: number, limit?: number): Promise<readonly ActEvent[]>
  /** 按 turn 事件身份读取真实请求、原文、调度、回执及下一帧；正文总预算默认一百万 UTF-16 字符。 */
  trace(turnId: string, maxChars?: number): Promise<ActTurnTrace>
  /** 立即取消活动运行。 */
  cancel(): void
  /** 由能力边界发起可等待的用户交互。 */
  request(
    kind: ActInteraction['kind'],
    message: string,
    signal: AbortSignal,
    detail?: unknown
  ): Promise<unknown>
  /** 列举当前任务的工作笔记，含已移出上下文的条目；不调用模型。 */
  listNotes(input?: {
    after?: string
    limit?: number
  }): Promise<{ items: readonly WorkspaceEntry[]; nextAfter: Nullable<string> }>
  /** 按稳定键和版本读取笔记正文，不暴露内部存储封装。 */
  readNote(input: RuntimeNoteRead): Promise<RuntimeNoteContent>
  /** 按版本调整上下文驻留，保留正文、来源与不可变历史。 */
  setNoteResident(input: RuntimeNoteRetention): Promise<WorkspaceEntry>
  /** 统一提交观察更新和本轮执行；先检查全部代码，再发布并执行。 */
  script(
    input: ScriptSubmission,
    signal?: AbortSignal,
    options?: ScriptControlOptions
  ): Promise<ScriptSubmissionReceipt>
  /** 宿主观察便捷调用，转交 script({observe}) 并将拒绝回执转成错误。 */
  observe(
    program: ScriptSourceProgram | ScriptReferenceProgram,
    signal?: AbortSignal,
    options?: ScriptControlOptions
  ): Promise<ObservationRegistration>
  /** 宿主执行便捷调用，转交 script({execute}) 并将拒绝回执转成错误。 */
  execute(
    program: ScriptSourceProgram | ScriptReferenceProgram,
    turns?: ScriptRetention,
    signal?: AbortSignal,
    options?: ScriptControlOptions
  ): Promise<ScriptExecutionReceipt>
  /** 由宿主调用领域核对器恢复中断任务；不会重新运行脚本。 */
  reconcile(signal?: AbortSignal): Promise<void>
  /** 取消在途程序并释放会话绑定。 */
  close(): Promise<void>
}

export class RuntimeSession implements VelarosSession {
  public readonly context: ContextRuntime
  public readonly view: ContextViewApi
  private decision?: ScriptDecisionBasis
  private readonly decisions = new Map<string, ScriptDecisionBasis>()
  private readonly active = new Map<
    string,
    { pending: Promise<CodeSurfaceOutcome>; controller: AbortController }
  >()
  private readonly jobs = new Map<string, Promise<unknown>>()
  private readonly batchControllers = new Set<AbortController>()
  private readonly hostOperations = new Set<Promise<unknown>>()
  private readonly finalizers = new Set<Promise<unknown>>()
  private readonly waiters = new Set<() => void>()
  private slots = 0
  private backgroundFailure: unknown
  private readonly config
  private closed = false
  private closing?: Promise<void>
  private readonly lifetime = new AbortController()
  private modelRunning = false
  private runDeadline?: number
  private runController?: AbortController
  private contextPhase: 'work' | 'maintenance' | 'finalizing' = 'work'
  private readonly agent?: ActRunServiceApi
  private readonly programs: ProgramContextApi
  private readonly history: RecentContextApi
  private readonly goal: SessionGoalApi
  private readonly memory: ContextMemoryApi
  private readonly controls = new Map<
    string,
    { fingerprint: string; pending: Promise<ScriptSubmissionReceipt> }
  >()
  private controlController?: AbortController
  private expectedObservation: Nullable<string> = null
  private observationResult?: ContextRef
  private observationImages: readonly ModelImage[] = []

  public constructor(
    public readonly id: string,
    private readonly dependencies: RuntimeSessionDependencies
  ) {
    this.goal = new SessionGoal(id, dependencies.storage)
    this.config = protocolConfig(dependencies.protocol)
    this.context = createContextRuntime({ sessionId: id, storage: dependencies.storage })
    this.view = createContextView({
      sessionId: id,
      storage: dependencies.storage,
      context: this.context,
      sources: dependencies.contextOptions?.sources ?? [],
      limits: dependencies.contextOptions?.limits,
    })
    this.programs = new ProgramContext(id, this.context, dependencies.storage)
    this.history = new RecentContext(id, this.context, dependencies.storage)
    this.memory = new ContextMemory(
      id,
      this.context,
      dependencies.storage,
      this.view,
      this.programs,
      this.history,
      dependencies.memory ?? dependencies.contextOptions?.memory
    )
    const modules = dependencies.allowedModules()
    const instructions =
      runtimeInstructions({
        modules,
        resident: (dependencies.residentModules ?? [])
          .filter((module) => modules.includes(module))
          .map((module) => {
            const { declarations, template } = dependencies.kernel.describe(module)
            return { module, declarations, template }
          }),
        storeMode: dependencies.stores?.mode,
        maintain: Boolean(dependencies.maintain),
        observe: this.config.allowed.includes('observe'),
      }) +
      (dependencies.tool?.instructions ? `\n${dependencies.tool.instructions}` : '') +
      (dependencies.instructions?.trim() ? `\n宿主应用指令：\n${dependencies.instructions}` : '')
    dependencies.register({
      validateCandidate: async (frame, signal) => {
        signal.throwIfAborted()
        if (!dependencies.model) return
        const decoder = new ScriptTurnDecoder(
          `${this.config.markerPrefix}${crypto.randomUUID().replaceAll('-', '')}`,
          this.config,
          dependencies.inputs?.() ?? {}
        )
        // 与主循环同一布局：协议说明在最后一条消息末尾，系统提示只有运行说明
        const request: ModelTurnRequest = {
          instructions,
          materials: [
            {
              ref: JSON.parse(frame.body).id,
              origin: 'runtime-view',
              text: frame.body,
              totalChars: frame.body.length,
            },
          ],
          compiledPrompt: `${frame.prompt}\n\n${decoder.instructions}`,
          history: frame.history,
          images: frame.images,
          response: { type: 'text' },
          mode: 'work',
          outputTokens: Math.min(
            dependencies.limits.outputTokens,
            dependencies.model.limits.outputTokens
          ),
        }
        const checked = await createProviderRequestCompiler().compileModelTurn(
          request,
          dependencies.model,
          dependencies.limits.safetyTokens
        )
        signal.throwIfAborted()
        if (!checked.okToSend)
          throw new AppError('CONTEXT_BUDGET', '整理候选仍超过实际模型窗口，补丁未发布')
      },
      validateDecision: (executionId, signal) => this.validateDecision(executionId, signal),
      context: this.context,
      runSignal: () => {
        if (!this.runController) throw new AppError('UNAVAILABLE', '需要活动模型运行')
        return this.runController.signal
      },
      memory: this.memory,
      goal: this.goal,
      phase: () => this.contextPhase,
      interact: (kind, message, signal, detail) => this.request(kind, message, signal, detail),
      deadline: () => this.runDeadline,
    })
    if (dependencies.model)
      this.agent = createActRunService({
        sessionId: id,
        storage: dependencies.storage,
        view: this.view,
        completionVerifier: dependencies.contextOptions?.completion,
        context: this.context,
        model: dependencies.model,
        limits: dependencies.limits,
        instructions,
        protocol: {
          open: () =>
            new ScriptTurnDecoder(
              `${this.config.markerPrefix}${crypto.randomUUID().replaceAll('-', '')}`,
              this.config,
              dependencies.inputs?.() ?? {},
              () =>
                this.jobs.size === 0 &&
                this.finalizers.size === 0 &&
                !dependencies.agents?.pending(id)
            ),
        },
        execution: {
          pending: () =>
            this.jobs.size > 0 ||
            this.finalizers.size > 0 ||
            Boolean(dependencies.agents?.pending(id)),
          wait: (signal) => this.waitExecution(signal),
          stop: async () => {
            try {
              await dependencies.agents?.cancelParent(id)
            } finally {
              await this.stopPrograms()
            }
          },
          invoke: (input, signal, acceptedTurnId) =>
            this.invokeBatch(input as ScriptProtocolSubmission, signal, acceptedTurnId),
        },
        frames: {
          maintain: dependencies.maintain
            ? async (input, signal) => {
                if (input.reason === 'boundary') {
                  // 显式整理先把段内较早的历史封成一卷，整理支线再给这一卷写叙事
                  if (await this.organizePending())
                    await this.memory.fold('organize', input.targetChars, signal)
                  // 自动封的上一卷只有骨架、那一段又没改笔记和计划：整理支线给它补写叙事
                  else if (await this.memory.narration(signal))
                    return dependencies.maintain!(
                      { reason: 'narrate', targetChars: input.targetChars },
                      signal
                    )
                }
                return dependencies.maintain!(input, signal)
              }
            : undefined,
          fold: (reason, maxChars, signal) => this.memory.fold(reason, maxChars, signal),
          renew: dependencies.renewRuns
            ? async (maxChars, signal) => {
                this.runDeadline = Date.now() + dependencies.limits.timeoutMs
                await this.memory.fold('renew', maxChars, signal)
              }
            : undefined,
          boundary: (signal) => this.memory.boundary(signal),
          pressure: dependencies.tool ? () => dependencies.tool!.pressure() : undefined,
          policy: dependencies.contextOptions?.policy,
          setPhase: (phase) => {
            this.contextPhase = phase
          },
          mode: 'partitioned',
          deadline: dependencies.tool ? () => dependencies.tool!.deadline() : undefined,
          phase: () => dependencies.tool?.phase() ?? { phase: 'work', instructions: '' },
          end: async (status) => {
            if (!dependencies.tool && (status === 'completed' || status === 'cancelled'))
              await this.programs.endTask()
          },
          prepare: (signal) => this.prepareObservation(signal),
          visibleExecutions: async () => {
            const state = await this.programs.state()
            return state.leases
              .filter((item) => item.task || item.expiresAfter > state.completedTurns)
              .map((item) => item.executionId)
          },
          project: (view, signal, maxChars) => this.project(view, signal, maxChars),
          acknowledge: (request, signal) => this.acknowledge(request, signal),
          completion: async (request, signal) => {
            if (!dependencies.tool && (await this.goal.get(signal))?.status === 'active')
              return {
                completed: false,
                verified: false,
                reason:
                  'GOAL_ACTIVE: 目标仍在推进，请继续执行；验收完成后用 goal.update 明确完成，确有阻碍则记录依据',
                recovery: 'repair',
              }
            if (await this.childNeedsReconcile())
              return {
                completed: false,
                verified: false,
                reason: 'CHILD_NEEDS_RECONCILE',
                recovery: 'reconcile',
              }
            if (
              (await this.view.inspect())?.mandatory.some(
                (item) => item.effect === 'unknown' || item.outcome === 'unknown'
              )
            )
              return {
                completed: false,
                verified: false,
                reason: 'NEEDS_RECONCILE',
                recovery: 'reconcile',
              }
            const basis = JSON.parse(
              request.materials.findLast((item) => item.origin === 'runtime-view')!.text
            ).partitions.runtime.decision as ScriptDecisionBasis
            // 只读模型工具可随时交付带缺口的成果；证据及补丁仍由专项发布器校验。
            if (basis.missing?.length && !dependencies.tool)
              return {
                completed: false,
                verified: false,
                reason: 'CONTEXT_REQUIRED',
                recovery: 'repair',
              }
            const validation = await dependencies.kernel.validateReads(id, basis.reads, signal)
            return validation.status === 'valid'
              ? undefined
              : {
                  completed: false,
                  verified: false,
                  reason:
                    validation.status === 'stale'
                      ? 'STALE_OBSERVATION'
                      : 'OBSERVATION_UNVERIFIABLE',
                  recovery: 'refresh',
                }
          },
          needsRefresh: async (request) => {
            if (this.backgroundFailure) throw this.backgroundFailure
            if (await dependencies.stores?.pending()) return true
            if (dependencies.tool) return false
            const frame = JSON.parse(
              request.materials.findLast((item) => item.origin === 'runtime-view')!.text
            )
            if (await this.organizePending()) return true
            const state = await this.programs.state()
            return (
              (state.resultsRevision ?? 0) !==
                frame.partitions.runtime.programFrame.resultsRevision ||
              toNullable(frame.partitions.observation.sourceRef) !== toNullable(state.observation)
            )
          },
        },
      })
  }

  /** 本任务是否有等待处理的整理请求。 */
  private async organizePending(): Promise<boolean> {
    const current = await this.dependencies.storage.load(this.id)
    const latest = current?.records.findLast(
      (record) =>
        record.title === 'context-maintenance:request' &&
        record.sequence > (current.task?.startedSequence ?? 0)
    )
    return latest
      ? JSON.parse((await this.dependencies.storage.get(this.id, latest.objectId))!).status ===
          'scheduled'
      : false
  }

  private async project(view: ModelView, signal: AbortSignal, maxChars: number) {
    const stores = await this.dependencies.stores?.frame(
      Math.max(1, Math.min(8, Math.floor(maxChars / 4000))),
      Math.min(StoreProjectionLimits.activeChars, Math.floor(maxChars / 4))
    )
    signal.throwIfAborted()
    const tool = this.dependencies.tool?.material?.(
      Math.min(ActRuntimeTuning.modelToolContextChars, Math.floor(maxChars / 4))
    )
    const currentGoal = this.dependencies.tool ? null : await this.goal.get(signal)
    const goal = currentGoal?.status === 'removed' ? null : currentGoal
    const extra =
      (goal ? JSON.stringify(goal).length : 0) +
      (stores ? JSON.stringify(stores).length : 0) +
      (tool ? JSON.stringify(tool).length : 0)
    const projected = await this.memory.project(
      view,
      this.observationResult,
      this.observationImages,
      signal,
      Math.max(1, maxChars - extra)
    )
    if (!stores && !tool && !goal) return projected
    const frame = JSON.parse(projected.body)
    if (goal) frame.partitions.runtime.goal = goal
    if (stores) frame.partitions.runtime.stores = stores
    if (tool) frame.partitions.runtime.modelTool = tool
    frame.memoryStatus.footprint.runtime = JSON.stringify(frame.partitions.runtime).length
    const body = JSON.stringify(frame)
    return { ...projected, body, prompt: memoryPrompt(body) }
  }

  private async waitExecution(signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      const progress = this.dependencies.agents?.pending(this.id)
        ? this.dependencies.agents.waitAny(this.id, combined)
        : this.waitProgress(combined)
      await (this.dependencies.stores
        ? Promise.race([progress, this.dependencies.stores.wait(combined)])
        : progress)
    } finally {
      controller.abort()
    }
  }

  public async *submit(input: string | ActInput, signal?: AbortSignal): AsyncIterable<ActRunEvent> {
    if (this.closed || this.active.size || this.controls.size)
      throw new AppError('CLOSED', '会话已关闭或已有活动程序')
    if (!this.agent) throw new AppError('UNAVAILABLE', '运行时尚未配置模型驱动')
    if (this.modelRunning) throw new AppError('CONFLICT', '会话已有活动模型运行')
    if (!isString(input) && input.task === 'new' && this.dependencies.agents?.pending(this.id))
      throw new AppError('CONFLICT', '子任务仍在运行，不能切换逻辑任务')
    if (!isString(input) && input.task === 'new' && (await this.childNeedsReconcile()))
      throw new AppError('NEEDS_RECONCILE', '子任务未知效果需要先核对，不能切换任务')
    this.decision = undefined
    this.modelRunning = true
    this.runDeadline = Date.now() + this.dependencies.limits.timeoutMs
    this.runController = new AbortController()
    try {
      yield* this.agent.submit(
        input,
        AbortSignal.any([this.runController.signal, ...(signal ? [signal] : [])])
      )
    } finally {
      this.runController.abort()
      try {
        await this.dependencies.agents?.cancelParent(this.id)
      } finally {
        this.modelRunning = false
        this.runDeadline = undefined
        this.runController = undefined
      }
    }
  }

  public async getGoal() {
    this.lifetime.signal.throwIfAborted()
    return this.trackHostOperation(this.goal.get(this.lifetime.signal))
  }
  public async updateGoal(input: GoalUpdate) {
    this.lifetime.signal.throwIfAborted()
    return this.trackHostOperation(this.goal.update(input, this.lifetime.signal))
  }
  public async controlGoal(input: GoalControl) {
    this.lifetime.signal.throwIfAborted()
    return this.trackHostOperation(this.goal.control(input, this.lifetime.signal))
  }

  public async listNotes(input: { after?: string; limit?: number } = {}) {
    this.lifetime.signal.throwIfAborted()
    return this.trackHostOperation(this.memory.list(input, this.lifetime.signal))
  }
  public async readNote(input: RuntimeNoteRead) {
    this.lifetime.signal.throwIfAborted()
    return this.trackHostOperation(this.memory.readNote(input, this.lifetime.signal))
  }
  public async setNoteResident(input: RuntimeNoteRetention) {
    this.lifetime.signal.throwIfAborted()
    return this.trackHostOperation(
      this.memory.update(
        { key: input.key, baseRevision: input.baseRevision, resident: input.resident },
        this.lifetime.signal
      )
    )
  }

  private async trackHostOperation<T>(operation: Promise<T>): Promise<T> {
    this.hostOperations.add(operation)
    try {
      return await operation
    } finally {
      this.hostOperations.delete(operation)
    }
  }

  public async steer(input: string | ActInput) {
    if (!this.agent) throw new AppError('UNAVAILABLE', '会话没有模型运行服务')
    return this.agent.steer(input)
  }
  public async answer(answer: ActAnswer) {
    if (!this.agent) throw new AppError('UNAVAILABLE', '会话没有模型运行服务')
    return this.agent.answer(answer)
  }
  public async inspect() {
    if (!this.agent) throw new AppError('UNAVAILABLE', '会话没有模型运行服务')
    return this.agent.inspect()
  }
  public async waitForChanges(signal: AbortSignal): Promise<void> {
    if (this.closed || !this.dependencies.stores)
      throw new AppError('CLOSED', '会话已关闭或没有获配 store')
    return this.dependencies.stores.wait(AbortSignal.any([signal, this.lifetime.signal]))
  }
  public async events(after?: number, limit?: number) {
    if (!this.agent) throw new AppError('UNAVAILABLE', '会话没有模型运行服务')
    return this.agent.events(after, limit)
  }
  public async trace(turnId: string, maxChars?: number) {
    return new RuntimeTrace(this.id, this.dependencies.storage, this.dependencies.journal).read(
      turnId,
      maxChars
    )
  }
  public cancel() {
    this.runController?.abort()
    this.agent?.cancel()
    this.controlController?.abort()
  }
  public async request(
    kind: ActInteraction['kind'],
    message: string,
    signal: AbortSignal,
    detail?: unknown
  ) {
    if (!this.agent) throw new AppError('UNAVAILABLE', '会话没有模型运行服务')
    return this.agent.request(kind, message, signal, detail)
  }

  public async script(
    input: ScriptSubmission,
    signal: AbortSignal = new AbortController().signal,
    options?: ScriptControlOptions
  ): Promise<ScriptSubmissionReceipt> {
    if (this.closed || this.modelRunning) throw new AppError('CLOSED', '会话已关闭或正在运行模型')
    return this.control(
      input,
      signal,
      options,
      toNullable((await this.programs.state()).observation),
      true
    )
  }

  public async observe(
    program: ScriptSourceProgram | ScriptReferenceProgram,
    signal?: AbortSignal,
    options?: ScriptControlOptions
  ): Promise<ObservationRegistration> {
    const result = await this.script({ observe: program }, signal, options)
    if (result.status === 'rejected') {
      const { code, message, ...fields } = result.observe ?? {}
      throw AppError.withFields(code ?? 'VALIDATION', message ?? '', fields)
    }
    return result.observe as ObservationRegistration
  }

  public async execute(
    program: ScriptSourceProgram | ScriptReferenceProgram,
    turns: ScriptRetention = ScriptLeaseLimits.defaultTurns,
    signal?: AbortSignal,
    options?: ScriptControlOptions
  ): Promise<ScriptExecutionReceipt> {
    const result = await this.script(
      { execute: { ...program, retainTurns: turns } },
      signal,
      options
    )
    if (result.status === 'rejected') {
      const { code, message, ...fields } = (result.execute as ScriptControlReceipt) ?? {}
      throw AppError.withFields(code ?? 'VALIDATION', message ?? '', fields)
    }
    return result.execute as ScriptExecutionReceipt
  }

  private async control(
    input: unknown,
    signal: AbortSignal,
    options: Optional<ScriptControlOptions>,
    expectedObservation: Nullable<string>,
    host = false
  ): Promise<ScriptSubmissionReceipt> {
    signal.throwIfAborted()
    const request = standardModules.parseScript(input)
    if (options && (!options.callId || options.callId.length > 2048))
      throw new AppError('VALIDATION', '调用身份长度无效')
    const control = scriptControlIdentity(
      this.id,
      options?.callId ?? crypto.randomUUID(),
      'script',
      request,
      expectedObservation
    )
    const running = this.controls.get(control.id)
    if (running) {
      if (running.fingerprint !== control.fingerprint)
        throw new AppError('SCRIPT_CALL_CONFLICT', '同一调用身份不能用于另一份输入')
      return running.pending
    }
    if (this.closed || this.active.size || this.controls.size)
      throw new AppError('SCRIPT_BUSY', '会话已关闭或已有活动脚本提交')
    const controller = new AbortController()
    const cancel = (): void => controller.abort(signal.reason)
    this.controlController = controller
    signal.addEventListener('abort', cancel, { once: true })
    const pending = this.dispatchSubmission(request, control, controller.signal, host)
    this.controls.set(control.id, { fingerprint: control.fingerprint, pending })
    try {
      return await pending
    } finally {
      this.controls.delete(control.id)
      this.controlController = undefined
      signal.removeEventListener('abort', cancel)
    }
  }

  private async dispatchSubmission(
    request: ScriptSubmission,
    control: ScriptControlIdentity,
    signal: AbortSignal,
    host: boolean
  ): Promise<ScriptSubmissionReceipt> {
    const saved = await this.programs.receipt(control)
    if (saved) return recoverScriptSubmission(saved, control)
    const observe = request.observe
      ? await this.prepareProgram(request.observe, control, signal, false)
      : undefined
    const { retainTurns = ScriptLeaseLimits.defaultTurns, ...program } = request.execute ?? {}
    const execute = request.execute
      ? await this.prepareProgram(
          program as CodeProgramRequest | ScriptReferenceProgram,
          control,
          signal,
          true
        )
      : undefined
    const prepared = [observe, execute].filter((item): item is PreparedScript => Boolean(item))
    const rejected = prepared.filter((item) => item.receipt.status === 'rejected')
    if (!isEmpty(rejected))
      return recoverScriptSubmission(
        (
          await this.programs.publish(
            rejected,
            control,
            {
              status: 'rejected',
              executed: false,
              observe: observe?.receipt.status === 'rejected' ? observe.receipt : undefined,
              execute: execute?.receipt.status === 'rejected' ? execute.receipt : undefined,
            },
            false,
            true,
            signal
          )
        ).receipt,
        control
      )
    const existingLease = host ? (await this.view.inspect())?.lease : undefined
    if (host && execute) await this.ensureView(signal)
    try {
      const receipt: ScriptSubmissionReceipt = {
        status: execute ? 'prepared' : 'completed',
        executed: false,
        observe: observe ? observe.receipt : undefined,
        execute: execute ? execute.receipt : undefined,
      }
      let published
      try {
        published = await this.programs.publish(
          prepared,
          control,
          receipt,
          Boolean(observe),
          false,
          signal
        )
      } catch (error) {
        signal.throwIfAborted()
        const failure = error as {
          code?: string
          message?: string
          currentRef?: LooseOptional<string>
        }
        if (!observe || !['SCRIPT_CONFLICT', 'SCRIPT_BUSY'].includes(failure.code ?? ''))
          throw error
        const ref = failure.currentRef ?? (await this.programs.state()).observation
        const rejected: ScriptControlReceipt = {
          status: 'rejected',
          executed: false,
          code: failure.code,
          message: failure.message,
          currentRef: ref,
          sourceRef: toOptional(ref),
        }
        return recoverScriptSubmission(
          (
            await this.programs.publish(
              [],
              control,
              { status: 'rejected', executed: false, observe: rejected },
              false,
              true,
              signal
            )
          ).receipt,
          control
        )
      }
      if (!published.claimed) return recoverScriptSubmission(published.receipt, control)
      if (!execute) return published.receipt
      const outcome = (await this.launch(
        { sourceRef: execute.receipt.sourceRef! },
        signal,
        'execute',
        retainTurns,
        control.id,
        execute.receipt.parentRef
      )) as ScriptExecutionReceipt
      const completed = await this.programs.finish(control, {
        ...receipt,
        status: 'completed',
        executed: true,
        execute: outcome,
      })
      if (host)
        await this.view.build({
          maxChars: this.dependencies.limits.projectionChars,
          visibleExecutionIds: (await this.programs.state()).leases.map((item) => item.executionId),
        })
      return completed
    } finally {
      if (host && execute && !existingLease) await this.view.end()
    }
  }

  private async ensureView(signal?: AbortSignal): Promise<void> {
    if (this.view && !(await this.view.inspect())?.lease) {
      const goal = (await this.context.inspect()).protected[0]
      if (!goal) throw new AppError('VALIDATION', '先登记用户目标')
      await this.view.begin(goal, signal)
    }
  }

  private async prepareProgram(
    requested: CodeProgramRequest | ScriptReferenceProgram | ScriptObservationEdit,
    control: ScriptControlIdentity,
    signal: AbortSignal,
    execute: boolean
  ): Promise<PreparedScript> {
    let program = requested
    const active = toNullable((await this.programs.state()).observation)
    const parentRef =
      'sourceRef' in program
        ? program.sourceRef
        : execute
          ? undefined
          : toOptional(control.expectedObservation)
    let candidate: Optional<CodeProgramRequest>
    let version: Optional<ScriptProgramVersion>
    try {
      if (!('source' in program) && !('sourceRef' in program)) {
        if (execute || !control.expectedObservation)
          throw new AppError('SCRIPT_REF', '当前没有可增量编辑的观察版本，请先提供 source')
        program = { ...program, sourceRef: control.expectedObservation }
      }
      candidate = await this.resolveProgram(program, signal)
      if (!execute) {
        if (active !== control.expectedObservation)
          throw AppError.withFields('SCRIPT_CONFLICT', '模型看到的观察版本已经变化', {
            currentRef: active,
          })
        if ('sourceRef' in program) {
          const base = await this.programs.version(program.sourceRef)
          const expected = base?.kind === 'draft' ? base.baseObservation : program.sourceRef
          if ((program.edits || base?.kind === 'draft') && expected !== active)
            throw AppError.withFields('SCRIPT_CONFLICT', '编辑底稿已不是当前观察版本', {
              currentRef: active,
            })
        }
      }
      const script = createKernelScriptSession({
        packages: this.dependencies.packages,
        allowedModules: this.dependencies.allowedModules(),
        runtime: this.dependencies.kernel,
        runner: this.dependencies.runner,
        sessionId: this.id,
        executionId: control.id,
        mode: execute ? 'execute' : 'observe',
      })
      if ('sourceRef' in program && program.edits) {
        const edited = script.edit(candidate, program.edits)
        if (!edited.ok) {
          const { code, message, ...fields } = edited
          throw AppError.withFields(code, message, fields)
        }
        candidate = edited.program
      }
      const check = script.check(candidate)
      if (!check.ok) {
        version = {
          sourceRef: crypto.randomUUID(),
          parentRef,
          baseObservation: control.expectedObservation,
          kind: 'draft',
        }
        const receipt: ScriptControlReceipt = {
          status: 'rejected',
          executed: false,
          code: execute ? 'SCRIPT_CHECK' : 'OBSERVATION_CHECK',
          message: '候选代码检查失败；使用 draftRef 继续修复',
          parentRef,
          currentRef: active,
          draftRef: version.sourceRef,
          diagnostics: check.diagnostics
            .slice(0, 32)
            .map((item) => ({ ...item, message: item.message.slice(0, 500) })),
        }
        return { program: candidate, version, receipt }
      }
      const baseline =
        active && !execute ? await this.resolveProgram({ sourceRef: active }, signal) : undefined
      const historicalSwitch =
        'sourceRef' in program && !program.edits && program.sourceRef !== active
      const unchanged = Boolean(
        !historicalSwitch &&
        baseline &&
        stableProgramJson(baseline) === stableProgramJson(candidate)
      )
      // 复用一次性源码和重跑观察都不增加编辑版本。
      const reuse =
        execute &&
        'sourceRef' in program &&
        stableProgramJson(await this.resolveProgram({ sourceRef: program.sourceRef }, signal)) ===
          stableProgramJson(candidate)
      const sourceRef = unchanged
        ? active!
        : reuse
          ? (program as ScriptReferenceProgram).sourceRef
          : crypto.randomUUID()
      version =
        unchanged || reuse
          ? undefined
          : {
              sourceRef,
              parentRef,
              baseObservation: control.expectedObservation,
              kind: execute ? 'execution' : 'observation',
            }
      const edits = 'sourceRef' in program ? program.edits : undefined
      const changes = edits
        ? Array.from(new Set(edits.map((item) => item.module)), (module) => ({
            module,
            edits: edits.filter((item) => item.module === module).length,
          }))
        : []
      return {
        program: version ? candidate : undefined,
        version,
        receipt: {
          status: execute ? 'prepared' : unchanged ? 'unchanged' : 'updated',
          sourceRef,
          parentRef,
          changes,
          executed: false,
          effective: !execute ? ('next-model-turn' as const) : undefined,
        },
      }
    } catch (error) {
      signal.throwIfAborted()
      const failure = error as {
        code?: string
        message?: string
        editIndex?: number
        currentRef?: LooseOptional<string>
      }
      // 定位失败没有完整候选；只引用可信的旧版本。无底稿时保存请求以供诊断。
      const ref = active ?? (candidate && parentRef ? parentRef : undefined)
      const fallback = ref ? undefined : { source: '/* 控制调用在执行前被拒绝。 */' }
      const fallbackVersion = fallback
        ? { sourceRef: crypto.randomUUID(), baseObservation: active, kind: 'draft' as const }
        : undefined
      return {
        program: fallback,
        version: fallbackVersion,
        receipt: {
          status: 'rejected',
          executed: false,
          code: failure.code ?? 'SCRIPT_REF',
          message: failure.message ?? String(error),
          editIndex: failure.editIndex,
          currentRef: failure.currentRef ?? active,
          sourceRef: ref ?? fallbackVersion?.sourceRef,
          parentRef: ref,
        },
      }
    }
  }

  private async validateDecision(executionId: string, signal: AbortSignal): Promise<void> {
    if (await this.childNeedsReconcile())
      throw new AppError('NEEDS_RECONCILE', '子任务仍有未知效果，宿主需先调用 reconcile 核对')
    const basis = this.decisions.get(executionId)
    if (!basis) return
    if (basis.missing?.length)
      throw AppError.withFields(
        'CONTEXT_REQUIRED',
        '决策必需的观察正文尚未完整投递，请先修复输出范围或预算',
        { effect: 'none' }
      )
    let reads = [...basis.reads]
    // 同一程序显式重新读取或自己的写回版本可以推进该资源的前提。
    for (const record of await this.dependencies.journal.list(this.id, executionId))
      if (record.receipt?.outcome === 'succeeded')
        for (const stamp of record.receipt.reads ?? []) {
          reads = reads.filter(
            (old) =>
              JSON.stringify([old.binding, old.resourceId]) !==
              JSON.stringify([stamp.binding, stamp.resourceId])
          )
          reads.push(stamp)
        }
    const validation = await this.dependencies.kernel.validateReads(this.id, reads, signal)
    if (validation.status === 'stale')
      throw AppError.withFields(
        'STALE_OBSERVATION',
        '本次行动依据的观察资源已经变化，当前写入尚未派发；请重新观察',
        { effect: 'none' }
      )
    if (validation.status === 'unverified')
      throw AppError.withFields(
        'OBSERVATION_UNVERIFIABLE',
        '原本可验证的观察资源现在无法核验，当前写入尚未派发',
        { effect: 'none' }
      )
  }

  private async prepareObservation(signal: AbortSignal): Promise<void> {
    if (this.backgroundFailure) throw this.backgroundFailure
    await this.dependencies.tool?.refresh(signal)
    this.contextPhase = 'work'
    this.observationResult = undefined
    this.observationImages = []
    const state = await this.programs.state()
    if (state.health?.status === 'paused' && state.health.sourceRef === state.observation) {
      this.observationResult = { sessionId: this.id, id: state.health.lastResult }
      return
    }
    if (state.observation) await this.launch({ sourceRef: state.observation }, signal, 'observe')
  }

  private async acknowledge(request: ModelTurnRequest, signal: AbortSignal): Promise<void> {
    const material = request.materials.findLast((item) => item.origin === 'runtime-view')
    if (material) {
      const frame = JSON.parse(material.text)
      this.dependencies.tool?.acknowledge?.(frame.partitions.runtime.modelTool)
      this.decision = frame.partitions.runtime.decision
      this.expectedObservation = toNullable(frame.partitions.observation.sourceRef)
      if (frame.frameId && request.mode !== 'maintenance') {
        await this.programs.consume(frame.frameId, signal)
        await this.memory.acknowledge(frame.frameId, signal)
        if (frame.partitions.runtime.stores)
          await this.dependencies.stores?.acknowledge(frame.partitions.runtime.stores)
      }
    }
  }

  private launch(
    program: CodeProgramRequest | ScriptReferenceProgram,
    signal: Optional<AbortSignal>,
    mode: 'execute' | 'observe',
    turns?: ScriptRetention,
    executionId: string = crypto.randomUUID(),
    parentRef?: string,
    basis?: LooseOptional<ModelView>,
    decision: Optional<ScriptDecisionBasis> = this.decision
  ): Promise<CodeSurfaceOutcome> {
    if (this.closed || this.active.has(executionId))
      return Promise.reject(new AppError('CLOSED', '会话已关闭或执行身份已占用'))
    const controller = new AbortController()
    const cancel = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const pending = this.resolveProgram(program, controller.signal).then((resolved) =>
      this.perform(
        resolved,
        controller.signal,
        mode,
        turns,
        'sourceRef' in program ? { sessionId: this.id, id: program.sourceRef } : undefined,
        executionId,
        parentRef,
        basis,
        decision
      )
    )
    this.active.set(executionId, { pending, controller })
    void pending
      .finally(() => {
        this.active.delete(executionId)
        signal?.removeEventListener('abort', cancel)
      })
      .catch(() => {
        Log.tag('ActRuntime').debug('RuntimeSession 已进入异常处理或降级分支')
      })
    return pending
  }

  private async waitProgress(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const pending = [...this.jobs.values(), ...this.finalizers]
    if (isEmpty(pending)) return
    let cancel = (): void => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason ?? new AppError('CANCELLED', '任务已取消'))
      signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      await Promise.race([...pending, aborted])
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  private async stopPrograms(): Promise<void> {
    for (const controller of this.batchControllers) controller.abort()
    for (const item of this.active.values()) item.controller.abort()
    await Promise.allSettled([
      ...this.jobs.values(),
      ...[...this.active.values()].map((item) => item.pending),
    ])
    await Promise.allSettled([...this.finalizers])
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    while (this.slots >= this.config.concurrency) {
      signal.throwIfAborted()
      let wake = (): void => {}
      await new Promise<void>((resolve, reject) => {
        wake = () => {
          this.waiters.delete(wake)
          signal.removeEventListener('abort', cancel)
          resolve()
        }
        const cancel = (): void => {
          this.waiters.delete(wake)
          signal.removeEventListener('abort', cancel)
          reject(signal.reason ?? new AppError('CANCELLED', '任务已取消'))
        }
        this.waiters.add(wake)
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
      })
    }
    signal.throwIfAborted()
    this.slots++
  }

  private async invokeBatch(
    input: ScriptProtocolSubmission,
    signal: AbortSignal,
    acceptedTurnId: string
  ): Promise<boolean> {
    const control = scriptControlIdentity(
      this.id,
      acceptedTurnId,
      'script-batch',
      input,
      this.expectedObservation
    )
    try {
      const [turnId, responseId] = acceptedTurnId.split(':')
      await this.context.append(
        {
          kind: 'audit',
          title: 'script:dispatch',
          body: JSON.stringify({ turnId, responseId, controlId: control.id }),
          sources: [
            { sessionId: this.id, id: turnId },
            { sessionId: this.id, id: responseId },
          ],
        },
        signal
      )
      if (this.jobs.size + input.executions.length > this.config.maxBlocks)
        throw new AppError('SCRIPT_QUEUE_LIMIT', '后台队列已达到本会话上限，先等待已有任务')
      const saved = await this.programs.receipt(control)
      if (saved) {
        recoverScriptSubmission(saved, control)
        return saved.status !== 'rejected'
      }
      const observe = isNull(input.observe)
        ? { receipt: { status: 'cleared' as const, executed: false } }
        : input.observe
          ? await this.prepareProgram(input.observe, control, signal, false)
          : undefined
      const basis = toNullable((await this.view.inspect())?.view)
      const decision = this.decision
      const executions: PreparedScript[] = []
      for (let index = 0; index < input.executions.length; index++) {
        const { retainTurns: _retain, ...program } = input.executions[index].program
        const child = scriptControlIdentity(
          this.id,
          `${acceptedTurnId}:${index}`,
          'execute',
          program,
          this.expectedObservation
        )
        const prepared = await this.prepareProgram(program, child, signal, true)
        executions.push({ ...prepared, receipt: { ...prepared.receipt, executionId: child.id } })
      }
      const all = [...(observe ? [observe] : []), ...executions]
      const rejected = all.filter((item) => item.receipt.status === 'rejected')
      const receipt: ScriptSubmissionReceipt = {
        status: !isEmpty(rejected) ? 'rejected' : !isEmpty(executions) ? 'prepared' : 'completed',
        executed: false,
        observe:
          observe && (isEmpty(rejected) || observe.receipt.status === 'rejected')
            ? observe.receipt
            : undefined,
        executions: executions
          .filter((item) => isEmpty(rejected) || item.receipt.status === 'rejected')
          .map((item) => item.receipt),
      }
      const published = await this.programs.publish(
        !isEmpty(rejected) ? rejected : all,
        control,
        receipt,
        isEmpty(rejected) && !isUndefined(observe),
        !isEmpty(rejected),
        signal
      )
      if (!published.claimed) {
        recoverScriptSubmission(published.receipt, control)
        return published.receipt.status !== 'rejected'
      }
      if (!isEmpty(rejected)) return false
      if (observe) this.expectedObservation = toNullable(observe.receipt.sourceRef)
      if (isEmpty(executions)) return true
      const controller = new AbortController()
      const cancel = (): void => controller.abort(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      this.batchControllers.add(controller)
      let failed = false
      const results: Array<ScriptControlReceipt | ScriptExecutionReceipt> = executions.map(
        (item) => item.receipt
      )
      const pending: Array<Promise<unknown>> = []
      for (let index = 0; index < executions.length; index++) {
        const item = executions[index]
        const executionId = item.receipt.executionId!
        const sourceRef = item.receipt.sourceRef!
        const job = { executionId, sourceRef, batchId: control.id }
        const run = async (): Promise<void> => {
          let acquired = false
          try {
            await this.acquireSlot(controller.signal)
            acquired = true
            await this.programs.job({ ...job, status: 'running' })
            const outcome = (await this.launch(
              { sourceRef },
              controller.signal,
              'execute',
              input.executions[index].program.retainTurns ?? ScriptLeaseLimits.defaultTurns,
              executionId,
              item.receipt.parentRef,
              basis,
              decision
            )) as ScriptExecutionReceipt
            results[index] = outcome
            const ok =
              outcome.checked && !outcome.result.failed && !outcome.result.unsettled?.length
            const unknown = (await this.dependencies.journal.list(this.id, executionId)).some(
              (record) => !record.receipt || record.receipt.effect === 'unknown'
            )
            await this.programs.job({
              ...job,
              status: unknown ? 'unknown' : ok ? 'succeeded' : 'failed',
              resultRef: outcome.resultRef,
            })
            if (!ok) {
              failed = true
              controller.abort(new AppError('CANCELLED', '本批程序失败'))
            }
          } catch (error) {
            Log.tag('ActRuntime').debug('RuntimeSession 已进入异常处理或降级分支')
            failed = true
            results[index] = {
              ...item.receipt,
              status: 'rejected',
              code: controller.signal.aborted ? 'CANCELLED' : 'SCRIPT_FAILED',
              message: error instanceof Error ? error.message : String(error),
            }
            const output = await this.context.append({
              kind: 'audit',
              title: `script:${executionId}:result`,
              body: JSON.stringify({ executionId, ...results[index] }),
              sources: [{ sessionId: this.id, id: sourceRef }],
            })
            await this.programs.add(
              output.ref,
              { sessionId: this.id, id: sourceRef },
              executionId,
              input.executions[index].program.retainTurns ?? ScriptLeaseLimits.defaultTurns
            )
            await this.programs.job({
              ...job,
              status: controller.signal.aborted ? 'cancelled' : 'failed',
              resultRef: output.ref.id,
            })
            controller.abort(error)
          } finally {
            if (acquired) {
              this.slots--
              for (const wake of [...this.waiters]) wake()
            }
          }
        }
        const promise = run()
        pending.push(promise)
        this.jobs.set(executionId, promise)
        void promise
          .finally(() => this.jobs.delete(executionId))
          .catch(() => {
            Log.tag('ActRuntime').debug('RuntimeSession 已进入异常处理或降级分支')
          })
        if (!input.executions[index].async) await promise
      }
      const finalized = Promise.allSettled(pending)
        .then(async (settled) => {
          const failure = settled.find((item) => item.status === 'rejected')
          if (failure?.status === 'rejected') throw failure.reason
          await this.programs.finish(control, {
            ...receipt,
            status: 'completed',
            executed: results.some((item) => 'checked' in item),
            executions: results,
          })
        })
        .finally(() => {
          signal.removeEventListener('abort', cancel)
          this.batchControllers.delete(controller)
        })
      this.finalizers.add(finalized)
      void finalized
        .catch((error) => {
          this.backgroundFailure = error
        })
        .finally(() => this.finalizers.delete(finalized))
      if (!input.executions.some((item) => item.async)) await finalized
      return !failed
    } catch (error) {
      if (signal.aborted) throw error
      const failure = error as { code?: string; message?: string; effect?: string }
      const executionId = crypto.randomUUID()
      const source = await this.context.append({
        kind: 'audit',
        title: `script:${executionId}`,
        body: JSON.stringify(input),
      })
      const result = await this.context.append({
        kind: 'audit',
        title: `script:${executionId}:result`,
        body: JSON.stringify({
          code: failure.code,
          message: failure.message,
          effect: failure.effect ?? 'none',
        }),
        sources: [source.ref],
      })
      await this.programs.add(result.ref, source.ref, executionId, ScriptLeaseLimits.defaultTurns)
      if (failure.effect === 'unknown') {
        await this.view.startStep(executionId, signal, true)
        await this.view.settle(
          [
            {
              id: executionId,
              executionId,
              operation: 'script.batch',
              outcome: 'unknown',
              effect: 'unknown',
              code: failure.code,
            },
          ],
          signal,
          { source: source.ref, result: result.ref }
        )
      }
      return false
    }
  }

  private async resolveProgram(
    program: CodeProgramRequest | ScriptReferenceProgram,
    signal: AbortSignal
  ): Promise<CodeProgramRequest> {
    signal.throwIfAborted()
    if ('source' in program) return program
    await this.dependencies.tool?.authorizeReference(
      { sessionId: this.id, id: program.sourceRef },
      signal
    )
    let content = await this.programs.readProgram(program.sourceRef)
    let text = content.text
    while (text.length < content.totalChars) {
      signal.throwIfAborted()
      content = await this.programs.readProgram(program.sourceRef, text.length)
      text += content.text
    }
    const saved = JSON.parse(text) as CodeProgramRequest
    if ('input' in program) Object.assign(saved, { input: program.input })
    if ('blobs' in program) Object.assign(saved, { blobs: program.blobs })
    return saved
  }

  private async perform(
    program: CodeProgramRequest,
    signal: AbortSignal,
    mode: 'execute' | 'observe' = 'execute',
    turns?: ScriptRetention,
    savedSource?: ContextRef,
    identity?: string,
    parentRef?: string,
    basis?: LooseOptional<ModelView>,
    decision?: ScriptDecisionBasis
  ): Promise<CodeSurfaceOutcome> {
    if (signal.aborted) throw new AppError('CANCELLED', '程序已取消')
    const executionId = identity ?? crypto.randomUUID()
    const source = savedSource
      ? { ref: savedSource }
      : await this.context.append(
          { kind: 'audit', title: `script:${executionId}`, body: JSON.stringify(program) },
          signal
        )
    if (mode !== 'observe') {
      await this.view?.startStep(executionId, signal, this.modelRunning, basis)
      if (decision) this.decisions.set(executionId, decision)
    }
    await this.context.append(
      {
        kind: 'audit',
        title: `script:execution:${executionId}`,
        body: JSON.stringify({ executionId, taskId: (await this.view.inspect())?.id, mode }),
        sources: [source.ref],
      },
      signal
    )
    let result: Optional<CodeSurfaceOutcome>
    let failure: unknown
    let resultRef: Optional<string>
    const scriptStarted = performance.now()
    let durationMs = 0
    try {
      const session = createKernelScriptSession({
        packages: this.dependencies.packages,
        allowedModules: this.dependencies.allowedModules(),
        runtime: this.dependencies.kernel,
        runner: this.dependencies.runner,
        sessionId: this.id,
        executionId,
        mode,
      })
      result = await session.run(program, signal)
    } catch (error) {
      failure = error
      if (mode !== 'observe' || signal.aborted) throw error
      return {
        checked: true,
        result: { failed: { code: 'PROGRAM_ERROR', message: String(error) } },
      }
    } finally {
      durationMs = performance.now() - scriptStarted
      await this.dependencies.settleModelTools?.(executionId)
      const attachments: ContextRef[] = []
      if (result?.checked)
        for (const image of result.attachments ?? [])
          attachments.push(
            (
              await this.context.append({
                kind: 'audit',
                title: `image:${executionId}`,
                body: JSON.stringify(image),
                sources: [source.ref],
              })
            ).ref
          )
      const persisted = result?.checked ? { ...result, attachments: undefined } : result
      const dependencies = await this.dependencies.journal.list(this.id, executionId)
      const reads = dependencies.flatMap((record) =>
        record.receipt?.outcome === 'succeeded' ? (record.receipt.reads ?? []) : []
      )
      const unverified = dependencies
        .filter(
          (record) =>
            record.receipt?.outcome === 'succeeded' &&
            !record.receipt.reads?.length &&
            (!isSystemMember(record.prepared.binding.moduleId) ||
              (LongTermMemoryModuleIds.includes(record.prepared.binding.moduleId) &&
                record.prepared.operation === 'recall'))
        )
        .map((record) => ({
          invocationId: record.prepared.id,
          moduleId: record.prepared.binding.moduleId,
          operation: record.prepared.operation,
        }))
      const observationFeedback =
        mode === 'observe'
          ? (await this.dependencies.journal.list(this.id, executionId))
              .filter(
                (record) =>
                  record.receipt?.effect !== 'none' || record.receipt?.outcome !== 'succeeded'
              )
              .map((record) => ({
                id: record.prepared.id,
                operation: `${record.prepared.binding.moduleId}.${record.prepared.operation}`,
                effect: record.receipt?.effect ?? 'unknown',
                outcome: record.receipt?.outcome ?? 'unknown',
                ...(record.receipt?.observation
                  ? {
                      protection: record.receipt.observation.protection,
                      completed: record.receipt.observation.completed,
                    }
                  : {}),
                code: record.receipt?.error ? record.receipt.error.code : undefined,
              }))
          : undefined
      const output = await this.context.append({
        kind: 'audit',
        title: `script:${executionId}:result`,
        body: JSON.stringify({
          executionId,
          mode,
          dependencies: { reads, unverified },
          ...(persisted ?? { error: String(failure) }),
          timing: { durationMs },
          attachments: !isEmpty(attachments) ? attachments : undefined,
          observationFeedback: observationFeedback?.length ? observationFeedback : undefined,
        }),
        sources: [source.ref],
      })
      resultRef = output.ref.id
      if (mode === 'observe') {
        this.observationResult = output.ref
        this.observationImages = result?.checked ? (result.attachments ?? []) : []
        const uncertain = dependencies.filter(
          (record) =>
            !record.receipt ||
            (record.receipt.effect !== 'none' &&
              !(record.receipt.outcome === 'succeeded' && record.receipt.observation?.completed))
        )
        const success = Boolean(
          !failure &&
          result?.checked &&
          !result.result.failed &&
          !result.output?.issues.length &&
          !observationFeedback?.some((item) => item.outcome !== 'succeeded') &&
          isEmpty(uncertain)
        )
        await this.programs.observeHealth(
          source.ref.id,
          output.ref.id,
          success,
          Boolean(!isEmpty(uncertain))
        )
        if (!isEmpty(uncertain))
          await this.view.recover(
            uncertain.map((record) => ({
              id: record.prepared.id,
              executionId,
              operation: `${record.prepared.binding.moduleId}.${record.prepared.operation}`,
              outcome: record.receipt?.outcome ?? 'unknown',
              effect: record.receipt?.effect ?? 'unknown',
              code: 'OBSERVATION_NEEDS_RECONCILE',
            }))
          )
      }
      if (turns) await this.programs.add(output.ref, source.ref, executionId, turns)
      this.decisions.delete(executionId)
      if (this.view && mode !== 'observe') {
        const records = await this.dependencies.journal.list(this.id, executionId)
        const feedback: ContextFeedback[] = records.map((record) => ({
          id: record.prepared.id,
          executionId,
          operation: `${record.prepared.binding.moduleId}.${record.prepared.operation}`,
          outcome: record.receipt?.outcome ?? 'unknown',
          effect: record.receipt?.effect ?? 'unknown',
          ...(record.receipt?.error
            ? {
                code: record.receipt.error.code,
                detail: record.receipt.error.message.slice(0, 1000),
              }
            : {}),
        }))
        const failed = Boolean(
          failure ||
          !result?.checked ||
          result.result.failed ||
          result.result.unsettled?.length ||
          feedback.some((item) => item.outcome !== 'succeeded')
        )
        const effect = feedback.some((item) => item.effect === 'unknown')
          ? 'unknown'
          : failed &&
              feedback.some((item) => item.effect === 'committed' || item.effect === 'partial')
            ? 'partial'
            : feedback.some((item) => item.effect === 'committed')
              ? 'committed'
              : 'none'
        feedback.push({
          id: executionId,
          executionId,
          operation: 'script.execute',
          outcome: signal.aborted ? 'cancelled' : failed ? 'failed' : 'succeeded',
          effect,
          ...(failed
            ? {
                code: signal.aborted ? 'CANCELLED' : 'SCRIPT_FAILED',
                detail: '程序结果与原文已保存，可按 lastStep 引用召回',
              }
            : {}),
        })
        await this.view.settle(feedback, undefined, {
          source: source.ref,
          result: output.ref,
          attachments: !isEmpty(attachments) ? attachments : undefined,
        })
      }
    }
    return {
      ...result!,
      sourceRef: source.ref.id,
      parentRef: toOptional(parentRef),
      executionId,
      resultRef: resultRef!,
    } as ScriptExecutionReceipt
  }

  private async currentChildren(): Promise<AgentJob[]> {
    const state = await this.dependencies.storage.load(this.id)
    const records = [
      ...new Map(
        (state?.records ?? [])
          .filter(
            (record) =>
              record.title.startsWith('act:child:') &&
              record.sequence > (state?.task?.startedSequence ?? 0)
          )
          .map((record) => [record.title, record])
      ).values(),
    ]
    return Promise.all(
      records.map(
        async (record) =>
          JSON.parse((await this.dependencies.storage.get(this.id, record.objectId))!) as AgentJob
      )
    )
  }

  private async childNeedsReconcile(): Promise<boolean> {
    for (const job of await this.currentChildren()) {
      if (
        ['running', 'waiting'].includes(job.status) &&
        !this.dependencies.agents?.pending(this.id)
      )
        return true
      const state = await this.dependencies.storage.load(job.sessionId)
      if (
        state?.task?.mandatory.some(
          (item) => item.effect === 'unknown' || item.outcome === 'unknown'
        )
      )
        return true
    }
    return false
  }

  public async reconcile(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (
      this.active.size ||
      this.modelRunning ||
      this.controls.size ||
      this.dependencies.agents?.pending(this.id)
    )
      throw new AppError('CONFLICT', '活动任务不能同时核对')
    for (const job of await this.currentChildren()) {
      await this.reconcileStored(job.sessionId, signal)
      const task = (await this.dependencies.storage.load(job.sessionId))?.task
      if (
        ['needs_reconcile', 'running', 'waiting'].includes(job.status) &&
        !task?.mandatory.some((item) => item.effect === 'unknown' || item.outcome === 'unknown')
      )
        await this.context.append(
          {
            kind: 'audit',
            title: `act:child:${job.id}`,
            body: JSON.stringify({ ...job, status: 'interrupted' }),
          },
          signal
        )
    }
    await this.reconcileStored(this.id, signal)
    this.backgroundFailure = undefined
  }

  private async reconcileStored(id: string, signal: AbortSignal): Promise<void> {
    const context =
      id === this.id
        ? this.context
        : createContextRuntime({ sessionId: id, storage: this.dependencies.storage })
    const view =
      id === this.id
        ? this.view
        : createContextView({
            sessionId: id,
            storage: this.dependencies.storage,
            context,
            sources: this.dependencies.contextOptions?.sources ?? [],
          })
    const programs =
      id === this.id ? this.programs : new ProgramContext(id, context, this.dependencies.storage)
    const task = await view.inspect()
    if (!task) return
    const snapshot = await this.dependencies.storage.load(id)
    const currentExecutions = new Set(task.mandatory.map((item) => item.executionId))
    for (const entry of snapshot?.records ?? [])
      if (entry.title.startsWith('script:execution:')) {
        const execution = JSON.parse((await this.dependencies.storage.get(id, entry.objectId))!)
        if (execution.taskId === task.id) currentExecutions.add(execution.executionId)
      }
    const records = (await this.dependencies.journal.list(id)).filter(
      (record) =>
        (!task.startedSequence || currentExecutions.has(record.prepared.executionId)) &&
        !(
          record.prepared.mode === 'observe' &&
          record.receipt?.outcome === 'succeeded' &&
          record.receipt.observation?.completed
        )
    )
    const feedback: ContextFeedback[] = []
    for (const record of records) {
      const checked =
        (await this.dependencies.kernel.reconcile(id, record.prepared.id, signal)) ?? record
      const resolved = checked.reconciliation
      feedback.push({
        id: checked.prepared.id,
        executionId: checked.prepared.executionId,
        operation: `${checked.prepared.binding.moduleId}.${checked.prepared.operation}`,
        outcome: resolved?.outcome ?? checked.receipt?.outcome ?? 'unknown',
        effect: resolved?.effect ?? checked.receipt?.effect ?? 'unknown',
        ...(resolved
          ? { code: 'RECONCILED', detail: resolved.evidence }
          : checked.receipt?.error
            ? {
                code: checked.receipt.error.code,
                detail: checked.receipt.error.message.slice(0, 1000),
              }
            : {}),
      })
    }
    for (const old of task.mandatory.filter((item) => item.operation === 'script.execute')) {
      const children = feedback.filter((item) => item.executionId === old.executionId)
      if (
        old.effect === 'unknown' &&
        !isEmpty(children) &&
        children.every((item) => item.effect !== 'unknown' && item.outcome !== 'unknown')
      )
        feedback.push({
          ...old,
          effect: children.some((item) => item.effect === 'committed' || item.effect === 'partial')
            ? 'partial'
            : 'none',
          code: 'RECONCILED',
          detail: '子操作效果已核对，原脚本的失败事实保持',
        })
    }
    // 恢复只核对日志与保存的结果，不从进程中断位置自动续跑。
    for (const job of (await programs.state()).jobs ?? []) {
      if (!['queued', 'running', 'unknown'].includes(job.status)) continue
      const operations = feedback.filter((item) => item.executionId === job.executionId)
      const unknown = operations.some(
        (item) => item.effect === 'unknown' || item.outcome === 'unknown'
      )
      const effect = unknown
        ? 'unknown'
        : operations.some((item) => ['committed', 'partial'].includes(item.effect))
          ? 'partial'
          : 'none'
      const record = (await this.dependencies.storage.load(id))?.records.findLast(
        (item) => item.title === `script:${job.executionId}:result`
      )
      const persisted = record ? await this.dependencies.storage.get(id, record.objectId) : null
      const result = persisted ? JSON.parse(persisted) : undefined
      const succeeded = Boolean(
        result?.checked &&
        !result.result?.failed &&
        !result.result?.unsettled?.length &&
        !unknown &&
        operations.every((item) => item.outcome === 'succeeded')
      )
      let resultRef = record?.ref.id
      if (!resultRef) {
        const output = await context.append({
          kind: 'audit',
          title: `script:${job.executionId}:result`,
          body: JSON.stringify({
            executionId: job.executionId,
            code: 'INTERRUPTED',
            effect,
            replayed: false,
          }),
          sources: [{ sessionId: id, id: job.sourceRef }],
        })
        await programs.add(
          output.ref,
          { sessionId: id, id: job.sourceRef },
          job.executionId,
          ScriptLeaseLimits.defaultTurns
        )
        resultRef = output.ref.id
      }
      feedback.push({
        id: job.executionId,
        executionId: job.executionId,
        operation: 'script.execute',
        outcome: succeeded
          ? 'succeeded'
          : job.status === 'queued' && isEmpty(operations)
            ? 'cancelled'
            : 'failed',
        effect,
        code: 'RECONCILED',
        detail: '已核对持久日志；中断脚本没有重跑',
      })
      await programs.job({
        ...job,
        resultRef,
        status: unknown
          ? 'unknown'
          : succeeded
            ? 'succeeded'
            : job.status === 'queued' && isEmpty(operations)
              ? 'cancelled'
              : 'failed',
      })
    }
    await view.recover(feedback)
  }

  public close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    const wasRunning = Boolean(this.active.size || this.modelRunning || this.controls.size)
    this.closed = true
    this.lifetime.abort(new AppError('CLOSED', '会话已关闭'))
    await Promise.allSettled([...this.hostOperations])
    const failures: unknown[] = []
    try {
      await this.agent?.close()
    } catch (error) {
      Log.tag('ActRuntime').debug('RuntimeSession 已进入异常处理或降级分支')
      failures.push(error)
    }
    try {
      this.controlController?.abort()
      await Promise.allSettled([...this.controls.values()].map((item) => item.pending))
      await this.stopPrograms()
    } catch (error) {
      Log.tag('ActRuntime').debug('RuntimeSession 已进入异常处理或降级分支')
      failures.push(error)
    }
    try {
      await this.view.end(wasRunning ? 'cancelled' : undefined)
    } catch (error) {
      Log.tag('ActRuntime').debug('RuntimeSession 已进入异常处理或降级分支')
      failures.push(error)
    }
    try {
      let offset: Nullable<number> = 0
      while (!isNull(offset)) {
        const page = this.dependencies.kernel.list({ offset })
        for (const module of page.items)
          this.dependencies.kernel.release(this.id, module.binding.moduleId)
        offset = page.nextOffset
      }
    } catch (error) {
      Log.tag('ActRuntime').debug('RuntimeSession 已进入异常处理或降级分支')
      failures.push(error)
    }
    this.dependencies.closed?.()
    if (!isEmpty(failures)) throw new AggregateError(failures, '会话关闭失败')
  }
}

/** 运行时为每个会话创建唯一句柄。 */
