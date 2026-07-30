// 域：聊天面 → 内核会话通道的**跨层接缝**。宿主的一次"发消息/中断/回答/批准"落在这里，
// 经内核控制面（controller + 输入账本 + 运行协调器 + 后台 job 管理器）排队、去重、唤醒，
// 最终回调宿主注入的执行协调器真正跑一轮。
//
// ## 谁拥有什么（方向铁律）
//  - **内核侧**拥有输入账本（谁先谁后、能不能插队）、运行态（在跑没在跑）、后台 job 生命周期；
//  - **宿主侧**拥有一轮执行怎么跑、事件怎么渲染。桥自己**不持有业务状态**，只有一个 `pendingRuns`
//    队列——"已被账本接纳、等着被 drain 消费"的那批 run。
//  - `TRenderTarget` 对桥完全不透明：桥从不检查它，只原样透传。桥里出现任何对渲染目标的判断
//    都是越界，正确落点在宿主协调器。
//
// ## 时序：send 为什么是两段
// `send` 先 `admit`（写入账本、拿到单调 seq）再 `wake`（异步驱动 drain），顺序不可反——
// 反了表现为"发了消息但 AI 没反应"。`enqueue` 必须早于 `controller.send`，否则 wake 可能在
// run 入队前就跑到 drain、什么也没捞到；失败路径的 `removePending` 是这条早入队的对偶。
// `drain` 是**串行消费**：每次 shift 一条、跑完再取下一条，`promoteSteers` / `promoteNextQueued`
// 在每条之前重放一次，保证插话（steer）总是先于排队消息生效。
//
// ## sessionId 是全链路唯一键
// 本类**不做任何 id 映射**：账本键、pendingRuns 键、后台 job 注册键、宿主 source session 全是
// 同一个 `sessionId`。历史上这里有一层 scope key 映射，去掉后留下的恒等管道已在 Q2c 清除。
// 若将来真要引入"一个会话多个作用域"，加映射的正确落点是这里，而且要同时覆盖**四处**
// （send / cancel / 后台 job 闭包 / controller 回调），只改一处会让 job 与运行态互相看不见。
//
// ## 缺省即安全
// `inputStore` / `runCoordinator` / `policy` / `backgroundJobManager` 全部可注入、缺省用内存实现，
// 让 headless 与探针零装配即可跑；内存实现的语义与持久实现一致，缺省不改变行为、只改变持久性。

import type { ModelMessage } from 'ai'

import { isArray, isBlank, isEmpty,isPresent, isString, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  ChatSendRequest,
  ExecutionPendingInteractionKind,
  ExecutionPendingInteractionSnapshot,
  ExecutionProvideGuidanceRequest,
  ExecutionProvideInputRequest,
  ExecutionResolveConfirmationRequest,
  UserActionCardResult,
} from '@velaros-ai/core/types'

import type {
  KernelBackgroundJobManager,
  KernelBackgroundJobOutputSnapshot,
  WaitForKernelBackgroundJobsInput,
} from '../background-jobs'
import {
  InMemoryKernelBackgroundJobOutputStore,
  KernelBackgroundJobManager as DefaultKernelBackgroundJobManager,
} from '../background-jobs'
import type {
  KernelCancelResult,
  KernelControllerAnswerInput,
  KernelControllerApprovalInput,
  KernelControllerSendInput,
} from '../controller'
import { KernelSessionController } from '../controller'
import type { KernelRuntimeStatus } from '../policy'
import { KernelSessionPolicy } from '../policy'
import type { KernelSessionInputStore } from '../session-lane'
import { InMemoryKernelSessionInputStore, KernelSessionRunCoordinator } from '../session-lane'

/** 读取内核后台 job 输出的入参（宿主执行协调器消费）。 */
interface KernelChatBackgroundJobReadInput {
  jobId: string
  mode: 'incremental' | 'snapshot'
}

/** 取消内核后台 job 的入参。 */
interface KernelChatBackgroundJobCancelInput {
  jobId: string
}

/**
 * 一轮聊天执行的运行选项：桥把后台 job 生命周期以闭包形式递给宿主执行协调器。
 * 是本桥与注入的 {@link KernelChatExecutionCoordinator} 之间的端口契约。
 */
interface KernelChatRunOptions {
  awaitPendingBackgroundJobs?: () => Promise<boolean>
  readBackgroundJobOutput?: (
    input: KernelChatBackgroundJobReadInput
  ) => Promise<Nullable<KernelBackgroundJobOutputSnapshot>>
  waitBackgroundJobs?: (
    input: WaitForKernelBackgroundJobsInput
  ) => Promise<KernelBackgroundJobOutputSnapshot[]>
  cancelBackgroundJob?: (
    input: KernelChatBackgroundJobCancelInput
  ) => Promise<Nullable<KernelBackgroundJobOutputSnapshot>>
}

/**
 * 宿主执行协调器窄接口：桥只需要 `run` 一个动词。
 * `TRenderTarget` 是传输/渲染目标句柄，对桥完全不透明——桥从不检查它，只原样透传给宿主。
 */
interface KernelChatExecutionCoordinator<TRenderTarget> {
  run(
    renderTarget: TRenderTarget,
    payload: ChatSendRequest,
    options?: KernelChatRunOptions
  ): Promise<void>
}

/** 宿主执行服务窄接口：桥消费的 source-session 生命周期动词。 */
interface KernelChatExecutionService {
  abortSourceSession(sourceSessionId: string): boolean
  provideGuidanceForSourceSession(
    request: { sessionId: string; message: ModelMessage },
    authorization?: { assertCurrent(): void }
  ): Promise<void>
  provideInputForSourceSession(request: ExecutionProvideInputRequest): void
  resolveConfirmationForSourceSession(request: ExecutionResolveConfirmationRequest): void
  hasPendingInteractionForSourceSession(
    sessionId: string,
    kind: ExecutionPendingInteractionKind
  ): boolean
  getPendingInteractionForSourceSession(
    sessionId: string,
    kind: ExecutionPendingInteractionKind
  ): Nullable<ExecutionPendingInteractionSnapshot>
  isRunningForSourceSession(sessionId: string): boolean
}

interface PendingKernelChatRun<TRenderTarget> {
  renderTarget: TRenderTarget
  payload: ChatSendRequest
}

interface KernelSessionAuthorization {
  assertCurrent(): void
}

const DefaultKernelBackgroundJobStalledAfterMs = 120_000

interface ChatKernelSessionBridgeOptions<TRenderTarget> {
  executionService: KernelChatExecutionService
  executionCoordinator: KernelChatExecutionCoordinator<TRenderTarget>
  inputStore?: KernelSessionInputStore
  runCoordinator?: KernelSessionRunCoordinator
  policy?: KernelSessionPolicy
  backgroundJobManager?: KernelBackgroundJobManager
}

class ChatKernelSessionBridge<TRenderTarget = unknown> {
  private readonly log = Log.tag('ChatKernelSessionBridge')
  private readonly inputStore: KernelSessionInputStore
  private readonly runCoordinator: KernelSessionRunCoordinator
  private readonly controller: KernelSessionController<UserActionCardResult[]>
  private readonly policy: KernelSessionPolicy
  private readonly backgroundJobManager: KernelBackgroundJobManager
  private readonly pendingRuns = new Map<string, Array<PendingKernelChatRun<TRenderTarget>>>()
  private nextInputId = 1

  constructor(private readonly options: ChatKernelSessionBridgeOptions<TRenderTarget>) {
    this.inputStore = options.inputStore ?? new InMemoryKernelSessionInputStore()
    this.runCoordinator = options.runCoordinator ?? new KernelSessionRunCoordinator()
    this.policy = options.policy ?? new KernelSessionPolicy()
    this.backgroundJobManager =
      options.backgroundJobManager ??
      new DefaultKernelBackgroundJobManager({
        stalledAfterMs: DefaultKernelBackgroundJobStalledAfterMs,
        outputStore: new InMemoryKernelBackgroundJobOutputStore(),
      })
    this.controller = this.createController()
  }

  public async send(renderTarget: TRenderTarget, payload: ChatSendRequest): Promise<void> {
    const scopeId = payload.sessionId
    const input = this.buildSendInput(payload, scopeId)
    if (!isPresent(input)) {
      void this.runExecutionCoordinator(renderTarget, payload)
      return
    }

    const run: PendingKernelChatRun<TRenderTarget> = { renderTarget, payload }
    this.enqueue(scopeId, run)
    try {
      await this.controller.send(input)
    } catch (error) {
      this.removePending(scopeId, run)
      throw error
    }
  }

  public async cancel(input: string | { sessionId: string }): Promise<KernelCancelResult> {
    return this.controller.cancel({ sessionId: isString(input) ? input : input.sessionId })
  }

  public async provideGuidance(
    payload: ExecutionProvideGuidanceRequest,
    message: ModelMessage,
    authorization?: KernelSessionAuthorization
  ): Promise<void> {
    const content = payload.message.textBlocks.join('\n').trim()
    const input = {
      id: payload.message.messageId ?? this.createInputId(payload.sessionId),
      sessionId: payload.sessionId,
      role: 'user' as const,
      content,
      delivery: this.policy.resolveDelivery({ kind: 'guidance' }),
      metadata: {
        source: 'chat-guidance',
        runId: toNullable(payload.message.runId),
        turnId: toNullable(payload.message.turnId),
      },
    }
    if (!authorization) {
      await this.controller.steer(input)
      await this.options.executionService.provideGuidanceForSourceSession({
        sessionId: payload.sessionId,
        message,
      })
      return
    }

    authorization.assertCurrent()
    const admitted = await this.inputStore.admit(input)
    try {
      authorization.assertCurrent()
      await this.inputStore.promoteSteers(input.sessionId, {
        cutoffSeq: admitted.seq,
        inputId: admitted.id,
      })
      authorization.assertCurrent()
      await this.options.executionService.provideGuidanceForSourceSession(
        { sessionId: payload.sessionId, message },
        authorization
      )
      authorization.assertCurrent()
    } catch (error) {
      try {
        await this.inputStore.cancel(input.sessionId, admitted.id)
      } catch (cancelError) {
        this.log.error('失效 Hook 引导输入吊销失败', AppError.from(cancelError))
      }
      throw error
    }
  }

  public async answer(payload: ExecutionProvideInputRequest): Promise<void> {
    await this.controller.answer({ ...payload } satisfies KernelControllerAnswerInput)
  }

  public async approve(payload: ExecutionResolveConfirmationRequest): Promise<void> {
    await this.controller.approve({
      sessionId: payload.sessionId,
      approved: payload.approved,
      rejectionMessage: payload.rejectionMessage,
      approvalPayload: payload.userActionCardResults,
    } satisfies KernelControllerApprovalInput<UserActionCardResult[]>)
  }

  public async runtimeStatus(sessionId: string): Promise<KernelRuntimeStatus> {
    return this.controller.runtimeStatus({ sessionId })
  }

  public pendingInteraction(
    sessionId: string,
    kind: ExecutionPendingInteractionKind
  ): Nullable<ExecutionPendingInteractionSnapshot> {
    return this.options.executionService.getPendingInteractionForSourceSession(sessionId, kind)
  }

  private createController(): KernelSessionController<UserActionCardResult[]> {
    return new KernelSessionController<UserActionCardResult[]>({
      admit: async (input) => {
        const admitted = await this.inputStore.admit({
          id: input.id,
          sessionId: input.sessionId,
          role: input.role,
          content: input.content,
          delivery: input.delivery ?? this.policy.resolveDelivery({ kind: 'chat-send' }),
          metadata: input.metadata,
        })
        return {
          inputId: admitted.id,
          sessionId: admitted.sessionId,
          seq: admitted.seq,
        }
      },
      wake: async (target) => {
        void this.runCoordinator
          .wake(
            target.sessionId,
            async ({ sessionId }) => {
              await this.drain(sessionId)
            },
            target.seq
          )
          .catch((error) => {
            this.log.error('kernel session drain failed', AppError.from(error))
          })
      },
      steer: async (input) => {
        await this.inputStore.promoteSteers(input.sessionId)
      },
      answer: async (input) => {
        this.options.executionService.provideInputForSourceSession({
          sessionId: input.sessionId,
          answer: input.answer,
        })
      },
      approve: async (input) => {
        this.options.executionService.resolveConfirmationForSourceSession({
          sessionId: input.sessionId,
          approved: input.approved,
          rejectionMessage: input.rejectionMessage,
          userActionCardResults: input.approvalPayload,
        })
      },
      runtimeStatus: async (target) => {
        const queuedInputs = await this.inputStore.countPending(target.sessionId)
        return this.policy.resolveRuntimeStatus({
          hasPendingConfirmation:
            this.options.executionService.hasPendingInteractionForSourceSession(
              target.sessionId,
              'confirmation'
            ),
          hasPendingInput: this.options.executionService.hasPendingInteractionForSourceSession(
            target.sessionId,
            'input'
          ),
          running:
            this.runCoordinator.isRunning(target.sessionId) ||
            this.options.executionService.isRunningForSourceSession(target.sessionId),
          cancelRequested: false,
          queuedInputs,
          backgroundJobs: this.backgroundJobManager.runningForSession(target.sessionId).length,
        })
      },
      cancel: async (target) => {
        this.runCoordinator.interrupt(target.sessionId)
        this.clearPending(target.sessionId)
        this.backgroundJobManager.cancelSession(target.sessionId)
        const aborted = this.options.executionService.abortSourceSession(target.sessionId)
        try {
          await this.inputStore.cancel(target.sessionId)
        } finally {
          await this.runCoordinator.awaitIdle(target.sessionId)
          await this.inputStore.dropSession(target.sessionId)
          this.backgroundJobManager.dropSession(target.sessionId)
        }
        return {
          aborted,
        }
      },
    })
  }

  private buildSendInput(
    payload: ChatSendRequest,
    scopeId: string
  ): Nullable<KernelControllerSendInput> {
    if (!isArray(payload.messages)) return null

    const latestUserMessage = this.findLatestUserMessage(payload.messages)
    if (!isPresent(latestUserMessage)) return null

    const content = latestUserMessage.textBlocks.join('\n').trim()
    if (isBlank(content)) return null

    return {
      id: latestUserMessage.messageId ?? this.createInputId(scopeId),
      sessionId: scopeId,
      role: 'user',
      content,
      metadata: {
        source: 'chat-send',
        runId: toNullable(latestUserMessage.runId),
        turnId: toNullable(latestUserMessage.turnId),
      },
    }
  }

  private createInputId(sessionId: string): string {
    const inputId = `${sessionId}:input:${this.nextInputId}`
    this.nextInputId += 1
    return inputId
  }

  private findLatestUserMessage(
    messages: ChatSendRequest['messages']
  ): Nullable<ChatSendRequest['messages'][number]> {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'user') return message
    }
    return null
  }

  private enqueue(sessionId: string, run: PendingKernelChatRun<TRenderTarget>): void {
    const queue = this.pendingRuns.get(sessionId) ?? []
    queue.push(run)
    this.pendingRuns.set(sessionId, queue)
  }

  private shift(sessionId: string): Nullable<PendingKernelChatRun<TRenderTarget>> {
    const queue = this.pendingRuns.get(sessionId)
    if (!queue || isEmpty(queue)) return null

    const run = toNullable(queue.shift())
    if (isEmpty(queue)) {
      this.pendingRuns.delete(sessionId)
    }
    return run
  }

  private clearPending(sessionId: string): void {
    this.pendingRuns.delete(sessionId)
  }

  private removePending(sessionId: string, run: PendingKernelChatRun<TRenderTarget>): void {
    const queue = this.pendingRuns.get(sessionId)
    if (!queue) return

    const index = queue.indexOf(run)
    if (index === -1) return

    queue.splice(index, 1)
    if (isEmpty(queue)) {
      this.pendingRuns.delete(sessionId)
    }
  }

  private async drain(sessionId: string): Promise<void> {
    try {
      while (true) {
        const run = this.shift(sessionId)
        if (!isPresent(run)) return

        await this.inputStore.promoteSteers(sessionId)
        await this.inputStore.promoteNextQueued(sessionId)
        await this.runExecutionCoordinator(run.renderTarget, run.payload)
      }
    } finally {
      await this.inputStore.dropSession(sessionId)
      this.backgroundJobManager.pruneTerminalJobs()
    }
  }

  private async runExecutionCoordinator(
    renderTarget: TRenderTarget,
    payload: ChatSendRequest
  ): Promise<void> {
    try {
      const options = this.buildExecutionRunOptions(payload.sessionId)
      await this.options.executionCoordinator.run(renderTarget, payload, options)
    } catch (error) {
      this.log.error('聊天执行异步失败', AppError.from(error))
    }
  }

  /**
   * 后台 job 生命周期闭包：**注册键与查询键必须是同一个 sessionId**。
   *
   * 子 agent 的后台 job 由 SubAgentDispatcher 以 `parentCtx.sessionId`（= AgentRunner config.sessionId
   * = 原始 request.sessionId）注册。这里读/等/取消一律用同一个 `sessionId` 参数，两者错开一次的症状是
   * job 对 read/wait/drain/隐式等待**全部不可见**——不报错，只是永远查不到。
   */
  private buildExecutionRunOptions(sessionId: string): KernelChatRunOptions {
    // 停滞/完成/失败/取消通知全部走 task.lifecycle 账本，由 turn-context 双投递点
    // （pre-send chips / mid-run note）恰好一次送达；不再有 run-start internalFollowUps 特例。
    this.backgroundJobManager.recordStalledJobs({ sessionId })
    const options: KernelChatRunOptions = {
      // 隐式等待：模型想收尾时若本会话仍有后台子 agent 在跑，阻塞等它们完成（waitForSession 对
      // 当下仍在运行的 job 会阻塞，返回其快照；无在跑 job 时立即返回 []）。返回是否等过 → 决定是否续跑。
      awaitPendingBackgroundJobs: async () => {
        const snapshots = await this.backgroundJobManager.waitForSession(sessionId, {})
        return snapshots.length > 0
      },
      readBackgroundJobOutput: async (input) => {
        const reader =
          input.mode === 'snapshot'
            ? this.backgroundJobManager.snapshotOutputForSession.bind(this.backgroundJobManager)
            : this.backgroundJobManager.readOutputForSession.bind(this.backgroundJobManager)
        return reader(sessionId, input.jobId)
      },
      waitBackgroundJobs: async (input) =>
        this.backgroundJobManager.waitForSession(sessionId, input),
      cancelBackgroundJob: async (input) => {
        const job = this.backgroundJobManager.cancelForSession(sessionId, input.jobId)
        if (!job) return null
        return this.backgroundJobManager.snapshotOutputForSession(sessionId, job.id)
      },
    }
    return options
  }

}

export { ChatKernelSessionBridge }
export type {
  ChatKernelSessionBridgeOptions,
  KernelChatExecutionCoordinator,
  KernelChatExecutionService,
  KernelChatRunOptions,
}
