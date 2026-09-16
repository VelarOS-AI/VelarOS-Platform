import { isFunction, toNullable, truncate } from '@velaros-ai/core'
import type { AppError } from '@velaros-ai/core/error'

import type { ApprovalPort } from '../../contract/requires.js'
import type { AgentEvent, UserActionCard } from '../../types/agent.js'
import type { DangerousConfirmationStatusSink, SubAgentRetryState, SubAgentToolContext, WorkerStatusArgs } from '../../types/delegation.js'
import type { ExecutionEventBusContract } from '../../types/records.js'
import type { UnattendedApprovalEscalationHooks } from '../../types/toolkit.js'

import { resolveSubAgentTypeKey } from './dispatch-plan'
import { formatSubAgentHighRiskConfirmationStatus } from './result-format'

/**
 * 「某次执行里的某条线程」的取消标记键。
 *
 * 取消可能早于 worker 真正启动（用户点取消时它还卡在并发闸排队），所以标记先按这个键记下来，
 * worker 注册后立刻自查并消费——两个 NUL 分隔的段拼一起，保证两段里的普通字符怎么组合都不会撞键。
 */
export function buildSubAgentAsyncThreadKey(executionKey: string, threadId: string): string {
  return `${executionKey}\u0000${threadId}`
}

/**
 * 把父执行与 worker 自己的中断信号并成一个：任一边中断，复合信号就中断。
 *
 * 用原生 `AbortSignal.any()` 而不是手挂 `addEventListener`：原生复合信号**弱引用**持有源信号，
 * 复合信号被回收时监听自动摘除，不会往长命的父执行信号上每派发一次就净增一个从不摘除的监听器。
 * 没有 worker 信号时原样返回父信号，不白包一层。
 */
export function combineAbortSignals(
  parentSignal: AbortSignal,
  workerSignal?: AbortSignal
): AbortSignal {
  if (!workerSignal) return parentSignal
  return AbortSignal.any([parentSignal, workerSignal])
}

/**
 * 在 worker 的事件总线上挂一层旁路探针：顺手记进展摘要，顺手标记「这次跑出过可见输出 / 用过工具」。
 *
 * 重试策略靠这两个标记判「断线时能不能安全重跑」——已经吐给用户或已经动过手的，不敢原样重来。
 * 总线不支持挂探针时原样返回，调用方不需要分支。
 */
export function attachSubAgentWorkerProbes(
  workerEvents: ExecutionEventBusContract,
  retryState: SubAgentRetryState,
  progressDigest: { record: (event: AgentEvent) => void }
): ExecutionEventBusContract {
  if (!isFunction(workerEvents.withAgentTap)) return workerEvents

  return workerEvents.withAgentTap((event: AgentEvent) => {
    progressDigest.record(event)

    if (event.type === 'text-delta' && event.text) {
      retryState.hasVisibleOutput = true
      return
    }

    if (event.type === 'reasoning-delta' && event.text) {
      retryState.hasVisibleOutput = true
      return
    }

    if (event.type === 'tool-progress' && event.chunk) {
      retryState.hasVisibleOutput = true
    }

    if (
      event.type === 'tool-start' ||
      event.type === 'tool-progress' ||
      event.type === 'tool-done'
    ) {
      retryState.hasToolUse = true
    }
  })
}

/**
 * 子 Agent 卡在高风险确认时，投影到它自己线程上的一张只读告知卡。
 *
 * 真正的授权在父线程的卡片上处理，这张只说明「它现在为什么不动」，所以不阻塞、只有一个「知道了」按钮。
 */
export function buildDangerousConfirmationWorkerCard(
  activationId: string,
  summary: string,
  timestamp: number
): UserActionCard {
  return {
    id: `${activationId}:dangerous-confirmation:${timestamp}`,
    title: '等待父线程确认危险指令',
    description: `${summary}\n请在父线程授权卡片中处理；这里仅同步子 Agent 当前阻塞原因。`,
    tone: 'warning',
    icon: 'danger',
    blocking: false,
    actions: [
      {
        kind: 'acknowledge',
        label: '知道了',
        completedLabel: '已知晓',
        icon: 'confirm',
        disableAfterClick: true,
      },
    ],
    createdAt: timestamp,
  }
}

/** 网络重试时推给界面的一行状态：第几次重试 / 共几次，外加截断到 120 字的原因。`attempt` 从 0 起算。 */
export function formatSubAgentTransientRetryStatus(
  error: AppError,
  attempt: number,
  maxAttempts: number
): string {
  return [
    `网络连接失败，正在重试子 Agent（${attempt + 1}/${maxAttempts}）`,
    truncate(error.message, 120),
  ].join('：')
}

/**
 * 这个错误算不算「被中断」而不是「失败」。
 *
 * 重试、路由降级、模型健康度反馈三处都必须先问它：把用户按下的停止喂进 `markFailure`，
 * 会把一个好好的 provider 判成不可用。父上下文已经中断也一律算中断，不管错误码是什么。
 */
export function isSubAgentAbortError(error: AppError, parentCtx: SubAgentToolContext): boolean {
  return parentCtx.abortSignal.aborted || error.code === 'EXECUTION_ABORTED'
}

/**
 * 发一条 worker 线程状态事件（pending / running / completed / failed / aborted / awaiting_confirmation）。
 *
 * 事件必须走**父总线**（`args.request.events`）：worker 自己的子总线只透传文本增量、重连与工具完成，
 * 线程状态会被它的处理器丢掉，走错总线的后果是界面上那条子 Agent 卡永远停在上一个状态。
 */
export function emitSubAgentWorkerStatus(args: WorkerStatusArgs): void {
  const { threadId, activationId, title, agentName, status, summary, error, result } = args
  args.request.events.emitWorkerThread({
    kind: 'worker-thread',
    event: 'status',
    ...{ threadId, activationId, title, agentName, status, summary, error, result },
    taskId: args.executionKey,
    roleId: args.typeConfig.roleId,
    phase: args.typeConfig.workerPhase,
    timestamp: Date.now(),
    input: args.request.input.prompt,
    subagentType: resolveSubAgentTypeKey(args.typeConfig),
    customAgentName: toNullable(args.typeConfig.customAgentName),
    mode: args.dispatchMode,
    model: toNullable(args.resolvedModel ?? args.request.input.model),
  })
}

/**
 * 子 Agent 卡在高风险确认时，往它的线程上补发一张只读告知卡（同样走父总线）。
 *
 * 真正的授权在父线程那张卡上处理，这条只解释「它为什么不动了」，所以状态固定为 awaiting_confirmation。
 */
export function emitSubAgentDangerousConfirmationCard(
  args: Omit<WorkerStatusArgs, 'status' | 'summary' | 'error' | 'result'> & {
    summary: string
  }
): void {
  const timestamp = Date.now()
  args.request.events.emitWorkerThread({
    kind: 'worker-thread',
    event: 'chat-event',
    threadId: args.threadId,
    activationId: args.activationId,
    taskId: args.executionKey,
    title: args.title,
    agentName: args.agentName,
    roleId: args.typeConfig.roleId,
    phase: args.typeConfig.workerPhase,
    status: 'awaiting_confirmation',
    timestamp,
    input: args.request.input.prompt,
    summary: args.summary,
    subagentType: resolveSubAgentTypeKey(args.typeConfig),
    customAgentName: toNullable(args.typeConfig.customAgentName),
    mode: args.dispatchMode,
    model: toNullable(args.resolvedModel ?? args.request.input.model),
    chatEvent: {
      type: 'notice',
      kind: 'user-action-card',
      payload: buildDangerousConfirmationWorkerCard(
        args.activationId,
        args.summary,
        timestamp
      ),
    },
  })
}

/**
 * 给子 Agent 造一份「自主运行」的工具上下文：确认一律委托父任务的审批端口，等待状态投影回子线程。
 *
 * 父上下文没有执行面（没人能审批）时原样返回，子 Agent 就按宿主既有策略跑。
 * 审批端口的构造交给调用方传进来（`createPort`），本函数只负责把它接回上下文的 execution / approval 两个面——
 * 这两个字段必须指向同一个对象，否则「谁批的」和「谁在等」会分叉成两本账。
 */
export function buildAutonomousSubAgentParentCtx(
  parentCtx: SubAgentToolContext,
  createPort: (
    delegate: NonNullable<SubAgentToolContext['execution']>,
    hooks: UnattendedApprovalEscalationHooks
  ) => ApprovalPort,
  onDangerousConfirmation?: DangerousConfirmationStatusSink,
  requester?: { agentId: string; label?: string }
): SubAgentToolContext {
  const execution = parentCtx.execution
  if (!execution) return parentCtx
  // 审批与旧 execution 门统一委托父任务，工具能力启用不参与此判定。
  const approvalPort = createPort(execution, {
    onEscalationPending: (message) =>
      onDangerousConfirmation?.(
        'awaiting_confirmation',
        formatSubAgentHighRiskConfirmationStatus(message)
      ),
    onEscalationResolved: () =>
      onDangerousConfirmation?.('running', '高风险操作确认已返回，子 Agent 继续处理。'),
  })
  const shared: NonNullable<SubAgentToolContext['execution']> = {
    ...execution,
    awaitConfirmation: (message, signal, options) =>
      approvalPort.awaitConfirmation(message, signal, { ...options, requester }),
    awaitConfirmationDecision: (message, signal, options) =>
      approvalPort.awaitConfirmationDecision(message, signal, { ...options, requester }),
  }
  return {
    ...parentCtx,
    execution: shared,
    approval: shared,
  }
}
