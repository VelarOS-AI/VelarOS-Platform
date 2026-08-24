// Platform Kernel owns the host-neutral remote-node implementation.
// 域:在途调用簿——「每个调用恰好 settle 一次」的唯一实现处。
//
// 单独成文件是因为这条纪律最容易在连接层的噪声里被磨掉:出口只有 `settle()` 一个,它先从
// 簿里摘掉再回调。任何绕过它的 resolve/reject 都会留下幽灵条目,在下一次重连冲刷时被二次派发。
//
// 另一条同样重要的判据是 `dispatched`:调用写上线过没有。它是 `resultUnknown` 的唯一依据——
// 从没上线的调用失败了就是失败了,上过线却拿不到终态的,必须按「可能已半执行」上抛。
import { randomUUID } from 'node:crypto'

import {
  isNull,
  isPresent,
  isTrue,
  isUndefined,
  Log,
  toNullable,
} from '@velaros-ai/core'
import type { TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import type { ScopeRef } from '@velaros-ai/kernel/contracts/abi'
import type {
  RemoteNodeCancel,
  RemoteNodeError,
  RemoteNodeInvoke,
  RemoteNodeProgress,
  RemoteNodeResult,
} from '@velaros-ai/kernel/contracts/protocol'

import {
  RemoteNodeClientDeadlineGraceMs,
  RemoteNodeClientDefaultDeadlineMs,
  RemoteNodeClientError,
  type RemoteNodeClientErrorCode,
  RemoteNodeClientErrorCodes,
  type RemoteNodeInvokeRequest,
} from './contracts'

const log = Log.tag('RemoteNodeCalls')

interface PendingCall {
  readonly callId: string
  readonly request: RemoteNodeInvokeRequest
  readonly resolve: (output: unknown) => void
  readonly reject: (error: Error) => void
  readonly deadline: TimerLease
  readonly detach: () => void
  /** 首次派发时定型,重连后原样重放——Node 按 callId 幂等去重,回放已有结果。 */
  frame: Nullable<RemoteNodeInvoke>
  dispatched: boolean
}

/** 簿对连接层的两点依赖;其余一概不知道,便于单独推演。 */
export interface RemoteNodePendingCallsHost {
  /** 写一帧;`false` 表示这次没写出去,调用留在簿里等下一次冲刷。 */
  send(frame: RemoteNodeInvoke | RemoteNodeCancel): boolean
  /** 就绪时返回当前清单摘要,未就绪返回 `null`——调用继续排队,不当场失败。 */
  currentRevision(): Nullable<string>
}

export class RemoteNodePendingCalls {
  private readonly entries = new Map<string, PendingCall>()

  public constructor(
    private readonly timers: TimerScope,
    private readonly host: RemoteNodePendingCallsHost,
  ) {}

  public get dispatchedCount(): number {
    return [...this.entries.values()].filter((entry) => entry.dispatched).length
  }

  /**
   * 登记一次调用并尝试立刻派发。
   *
   * 未就绪不算失败:跨机链路上短暂断线是常态,让每次抖动都变成一次工具失败会把上层的重试
   * 逻辑逼疯。兜底由本调用自己的截止时间负责,计时从登记那一刻起算(覆盖等重连的时间)。
   */
  public track(
    request: RemoteNodeInvokeRequest,
    signal: LooseOptional<AbortSignal>,
  ): Promise<unknown> {
    const callId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.settle(callId, (pending) => {
          this.host.send({ type: 'cancel', callId, reason: 'Aborted by caller' })
          pending.reject(createAbortError())
        })
      }
      const deadline = this.timers.after(
        resolveDeadlineMs(request) + RemoteNodeClientDeadlineGraceMs,
        () => this.settleTimeout(callId),
        { label: 'remote-node.call-deadline', unref: true },
      )
      this.entries.set(callId, {
        callId,
        deadline,
        detach: () => signal?.removeEventListener('abort', onAbort),
        dispatched: false,
        frame: null,
        reject,
        request,
        resolve,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.dispatch(callId)
    })
  }

  /** 连接就绪后冲刷:排队的首次派发,已上线的按 callId 幂等重放。 */
  public flush(): void {
    for (const callId of [...this.entries.keys()]) this.dispatch(callId)
  }

  public settleResult(frame: RemoteNodeResult): void {
    this.settle(frame.callId, (pending) => {
      if (frame.status === 'success') {
        pending.resolve(frame.output)
        return
      }
      const denied = frame.status === 'denied'
      pending.reject(new RemoteNodeClientError({
        code: denied
          ? RemoteNodeClientErrorCodes.CallDenied
          : RemoteNodeClientErrorCodes.CallFailed,
        message: describeNodeError(
          frame.error,
          denied ? 'Remote node denied the call' : 'Remote node call failed',
        ),
        nodeError: frame.error,
        // 两者都是对端给出的终态判决,不存在"可能半执行"。
        resultUnknown: false,
        retryable: !denied && isTrue(frame.error?.retryable),
      }))
    })
  }

  public routeProgress(frame: RemoteNodeProgress): void {
    this.entries.get(frame.callId)?.request.onProgress?.(frame.event)
  }

  /**
   * 对端重启后的清账。
   *
   * 只判死已上线的调用:它们的结果永远不会再来,而且可能已在旧进程里跑掉一半。未上线的
   * 排队调用清掉 frame 重排即可——旧 frame 里的 manifestRevision 已经过期。
   */
  public failRestarted(): void {
    log.warn('Remote node restarted; in-flight calls are unrecoverable', {
      inFlight: this.dispatchedCount,
    })
    for (const entry of [...this.entries.values()]) {
      if (!entry.dispatched) {
        entry.frame = null
        continue
      }
      this.settle(entry.callId, (pending) => {
        pending.reject(new RemoteNodeClientError({
          code: RemoteNodeClientErrorCodes.NodeRestarted,
          message: `Remote node restarted while "${describeCall(pending)}" was in flight; the result is unknown`,
          resultUnknown: true,
          retryable: false,
        }))
      })
    }
  }

  /** 连接进入终态时清空全簿;上过线的一律标成结果未知。 */
  public failAll(code: RemoteNodeClientErrorCode, message: string): void {
    for (const entry of [...this.entries.values()]) {
      this.settle(entry.callId, (pending) => {
        pending.reject(new RemoteNodeClientError({
          code,
          message,
          resultUnknown: pending.dispatched,
          retryable: false,
        }))
      })
    }
  }

  private dispatch(callId: string): void {
    const pending = this.entries.get(callId)
    if (isUndefined(pending)) return
    const revision = this.host.currentRevision()
    if (isNull(revision)) return

    if (isNull(pending.frame)) {
      pending.frame = {
        type: 'invoke',
        callId,
        manifestRevision: revision,
        capabilityId: pending.request.capabilityId,
        operation: pending.request.operation,
        scope: toWireScope(pending.request.scope),
        input: pending.request.input,
        deadlineMs: resolveDeadlineMs(pending.request),
      }
    }
    if (this.host.send(pending.frame)) pending.dispatched = true
  }

  private settleTimeout(callId: string): void {
    this.settle(callId, (pending) => {
      // 走到这里说明 Node 侧看门狗也没出声,链路很可能已经哑了;仍尽力送一帧 cancel。
      this.host.send({
        type: 'cancel',
        callId,
        reason: 'Client deadline exceeded',
      })
      pending.reject(new RemoteNodeClientError({
        code: RemoteNodeClientErrorCodes.CallTimeout,
        message: `Remote node call "${describeCall(pending)}" exceeded the client deadline`,
        resultUnknown: pending.dispatched,
        retryable: false,
      }))
    })
  }

  /** 唯一出口:先摘簿、停表、摘中止监听,再回调。 */
  private settle(callId: string, apply: (pending: PendingCall) => void): void {
    const pending = this.entries.get(callId)
    if (isUndefined(pending)) return
    this.entries.delete(callId)
    pending.deadline.cancel()
    pending.detach()
    apply(pending)
  }
}

function describeCall(pending: PendingCall): string {
  return `${pending.request.capabilityId}.${pending.request.operation}`
}

function resolveDeadlineMs(request: RemoteNodeInvokeRequest): number {
  const requested = request.deadlineMs
  if (isUndefined(requested) || !Number.isFinite(requested) || requested <= 0) return RemoteNodeClientDefaultDeadlineMs
  return Math.round(requested)
}

/** ABI 的 `kind?: string` 与 wire 的 `kind: string | null` 在此对齐,只此一处。 */
function toWireScope(
  scope: LooseOptional<ScopeRef>,
): RemoteNodeInvoke['scope'] {
  if (!isPresent(scope)) return null
  return {
    id: scope.id,
    ownerModuleId: scope.ownerModuleId,
    kind: toNullable(scope.kind),
  }
}

function describeNodeError(
  error: Nullable<RemoteNodeError>,
  fallback: string,
): string {
  if (isNull(error)) return fallback
  return `${fallback}: ${error.message} (${error.code})`
}

export function createAbortError(): Error {
  return new DOMException('Remote node call aborted', 'AbortError')
}
