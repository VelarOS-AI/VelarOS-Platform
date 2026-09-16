// Platform Kernel 统一持有与宿主无关的远程节点实现。
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
  isTrue,
  isUndefined,
  Log,
} from '@velaros-ai/core'
import type { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { RemoteNodeClientErrorCode } from '../../contract/constants'
import { RemoteNodeClientErrorCodes } from '../../contract/constants'
import type { RemoteNodePendingCall } from '../../types/remote'
import { type RemoteNodeInvokeRequest } from '../../types/remote-client'
import { RemoteNodeClientError } from '../../utils/errors'
import {
  describeRemoteNodeCall,
  describeRemoteNodeError,
  resolveRemoteNodeDeadlineMs,
  toRemoteNodeWireScope,
} from '../../utils/remote/calls'
import { KernelTuning } from '../../utils/tuning'
import type {
  RemoteNodeCancel,
  RemoteNodeInvoke,
  RemoteNodeProgress,
  RemoteNodeResult,
} from '../../utils/wire/remote-node'

const log = Log.tag('RemoteNodeCalls')

/** 簿对连接层的两点依赖;其余一概不知道,便于单独推演。 */
export interface RemoteNodePendingCallsHost {
  /** 写一帧;`false` 表示这次没写出去,调用留在簿里等下一次冲刷。 */
  send(frame: RemoteNodeInvoke | RemoteNodeCancel): boolean
  /** 就绪时返回当前清单摘要,未就绪返回 `null`——调用继续排队,不当场失败。 */
  currentRevision(): Nullable<string>
}

/**
 * 在途调用簿。
 *
 * 一条连接一本;它看守「每个调用恰好 settle 一次」这条纪律,并把「上过线没有」
 * 记成 `resultUnknown` 的唯一依据。
 */
export interface RemoteNodePendingCallsApi {
  /** 已经写上线的调用数;只用于诊断与日志。 */
  readonly dispatchedCount: number
  /** 登记一次调用并尝试立刻派发,兑现能力输出;超时、中止与对端终态都从这里结算。 */
  track(
    request: RemoteNodeInvokeRequest,
    signal: LooseOptional<AbortSignal>,
  ): Promise<unknown>
  /** 连接就绪后冲刷:排队的首次派发,已上线的按 callId 幂等重放。 */
  flush(): void
  /** 收一帧终态:成功兑现输出,否则按 denied / failed 分档拒绝;未知 callId 静默。 */
  settleResult(frame: RemoteNodeResult): void
  /** 把一帧进度派给对应调用的 `onProgress`;未知 callId 静默丢弃。 */
  routeProgress(frame: RemoteNodeProgress): void
  /** 对端重启后清账:已上线的按「结果未知」判死,未上线的清掉旧帧重排。 */
  failRestarted(): void
  /** 连接进入终态时清空全簿;上过线的一律标成结果未知。 */
  failAll(code: RemoteNodeClientErrorCode | string, message: string): void
}

export class RemoteNodePendingCalls implements RemoteNodePendingCallsApi {
  private readonly entries = new Map<string, RemoteNodePendingCall>()

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
          this.host.send({ type: 'cancel', callId, reason: '调用方主动中止' })
          pending.reject(createAbortError())
        })
      }
      const deadline = this.timers.after(
        resolveRemoteNodeDeadlineMs(request) + KernelTuning.remoteClientDeadlineGraceMs,
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
        message: describeRemoteNodeError(
          frame.error,
          denied ? '远程节点拒绝了这次调用' : '远程节点调用失败',
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
          message: `"${describeRemoteNodeCall(pending.request)}" 还在途时远程节点重启了，结果未知`,
          resultUnknown: true,
          retryable: false,
        }))
      })
    }
  }

  /** 连接进入终态时清空全簿;上过线的一律标成结果未知。 */
  public failAll(code: RemoteNodeClientErrorCode | string, message: string): void {
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
        scope: toRemoteNodeWireScope(pending.request.scope),
        input: pending.request.input,
        deadlineMs: resolveRemoteNodeDeadlineMs(pending.request),
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
        reason: '超过客户端侧的截止时间',
      })
      pending.reject(new RemoteNodeClientError({
        code: RemoteNodeClientErrorCodes.CallTimeout,
        message: `远程节点调用 "${describeRemoteNodeCall(pending.request)}" 超过了客户端侧的截止时间`,
        resultUnknown: pending.dispatched,
        retryable: false,
      }))
    })
  }

  /** 唯一出口:先摘簿、停表、摘中止监听,再回调。 */
  private settle(callId: string, apply: (pending: RemoteNodePendingCall) => void): void {
    const pending = this.entries.get(callId)
    if (isUndefined(pending)) return
    this.entries.delete(callId)
    pending.deadline.cancel()
    pending.detach()
    apply(pending)
  }
}


/** 一次调用被中止时交回调用方的错误;名字按 DOM 约定叫 `AbortError`,上层按它判断。 */
export function createAbortError(): Error {
  return new DOMException('Remote node call aborted', 'AbortError')
}
