/**
 * I2 蒸馏调度器（上下文治理 v2 · §4B 第三档器械的异步那一半）。
 *
 * ## 为什么必须异步
 * v1 把语义压缩内联进回合循环：模型要说话，先等一次摘要调用回来——用户端表现为"卡在那里想"，
 * 这是 v1 的死因之一。v2 里回合永远不等蒸馏：epoch 同步跑完 I0+I1 就返回，蒸馏在**回合之外**
 * 跑，产物排队等下一个 epoch 边界才应用。慢一个 epoch 落地是设计，不是妥协——每 epoch 恰好一次
 * 缓存重建（P4）本来就要求降级批量落在边界上。
 *
 * ## 成本护栏（三条，全在配置里）
 *  - **并发 1**：同一会话任何时刻最多一次在飞的蒸馏调用；多出来的请求排队，队列也受
 *    `maxSegmentsPerEpoch` 限制（每 epoch 规划几段）。
 *  - **输入字符上限**：段落在规划期就切好（`maxInputChars`，沿用 v1 的 48K）。
 *  - **超时**：`timeoutMs` 到点即判超时并回落骨架。走 `TimerScope.withTimeout`（内部是"发信号 +
 *    竞速"）而不是只发 AbortSignal——端口实现不一定认信号，不能把治理挂在别人的礼貌上。
 *
 * ## 失败方向
 * 拒收 / 超时 / 端口抛错**一律产出回落骨架产物**，绝不"什么都不给"：段落是在规划期就被判定
 * 非折不可的（机械器械没达标），这时候空手而归等于让压力原样留到下一轮。
 */
import { isEmpty, isNotNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ContextDistiller, ContextDistillProduct, ContextDistillRequest, ContextDistillTotals, ContextGovernanceConfig } from '../../types/residency.js'
import { isTimeoutError } from '../../utils/residency/context-distill-runner'
import { buildDistillProduct, buildSkeletonFallbackProduct, createEmptyDistillTotals } from '../../utils/residency/distill'
import { AgentTuning } from '../../utils/tuning'

/** 建 `ContextDistillRunner` 时一次性交的三项：怎么拿到蒸馏器、这个 runner 属于哪个会话、积压上限。 */
export interface ContextDistillRunnerOptions {
  /** 蒸馏器解析器（晚绑：registry 是宿主级单实例，比模型运行时先造出来）。 */
  resolveDistiller: () => Nullable<ContextDistiller>
  /** 会话标识（进端口的遥测上下文）。 */
  sessionId: Nullable<string>
  /** 最多攒几个等应用的产物，缺省 4（小数向下取整，至少 1）；产物本身占内存，而积压超过几个就说明 epoch 根本没在跑，超限时丢最旧的那些。 */
  maxPendingProducts?: LooseOptional<number>
}

/**
 * 异步蒸馏调度这一面：把非折不可的段落排进队列、在回合之外一次跑一个、产物攒着等下一个 epoch 边界来取。
 *
 * 实现是 `ContextDistillRunner`，每个治理会话持一个；队列、在飞状态、待应用产物和计数全在内存里。
 * 回合**永远不等**它：`schedule` 立即返回，慢一个 epoch 落地是设计。同一会话并发恒为 1。
 * 失败方向固定是「一律产出回落骨架」——拒收、超时、端口抛错都照样给一份产物，绝不空手而归，
 * 因为段落在规划期就已经被判定非折不可，什么都不给等于把压力原样留到下一轮。
 */
export interface ContextDistillRunnerApi {
  /** 最多能攒几个待应用产物（构造时定死，至少 1）；超过就从最旧的开始丢。 */
  readonly maxPendingProducts: number
  /** 现在有没有在飞的或排着队的请求；这是并发 1 的判据，规划期据它决定还要不要再排。 */
  readonly busy: boolean
  /** 当前攒了几个待应用产物，等下一个 epoch 边界被 `takePending` 取走。 */
  readonly pendingCount: number
  /** 现在到底有没有可用的蒸馏器（模型运行时可能还没造好或被换掉）；规划期先问它，没有就别排队。 */
  hasDistiller(): boolean
  /** 取一份计数快照：请求过多少、接受/拒收/超时/失败各多少、因过代被丢弃多少。返回的是拷贝，随便存。 */
  totals(): ContextDistillTotals
  /** 把一批段落排进队列并启动跑动，**不 await**（回合永远不等蒸馏）；requests 为空时直接返回。已经在跑时只入队，跑完自然接上。 */
  schedule(requests: readonly ContextDistillRequest[], config: ContextGovernanceConfig): void
  /** epoch 边界上取走待应用产物：只给 `generation` 对得上的那些，对不上的直接丢弃并计入 staleDropped——账本整本重建后记录 id 会重新发号，把上一代的摘要贴到这一代记录上比不摘要更糟。取完队列清空。 */
  takePending(generation: number): ContextDistillProduct[]
  /** 丢掉全部在途状态（账本重建、会话失效时调）：清队列、清待应用产物并计入 staleDropped；已经在飞的那一次仍会跑完，它的产物会落到清空后的队列里。 */
  reset(): void
  /** 等到队列跑空为止。只给测试和 headless 实验用，产品路径永远不 await 它。 */
  settled(): Promise<void>
}

export class ContextDistillRunner implements ContextDistillRunnerApi {
  private readonly log = logRuntime.tag('ContextDistillRunner')
  private readonly timers = new TimerScope({ name: 'ContextDistillRunner' })
  private readonly queue: ContextDistillRequest[] = []
  private readonly pending: ContextDistillProduct[] = []
  private readonly counters: ContextDistillTotals = createEmptyDistillTotals()
  private running: Nullable<Promise<void>> = null
  private readonly maxPending: number

  public constructor(private readonly options: ContextDistillRunnerOptions) {
    this.maxPending = Math.max(1, Math.floor(options.maxPendingProducts ?? AgentTuning.residency.maxPendingDistillProducts))
  }

  public get maxPendingProducts(): number {
    return this.maxPending
  }

  /** 是否有在飞或排队的请求（并发 1 的判据）。 */
  public get busy(): boolean {
    return isNotNull(this.running) || !isEmpty(this.queue)
  }

  public get pendingCount(): number {
    return this.pending.length
  }

  public hasDistiller(): boolean {
    return isNotNull(this.options.resolveDistiller())
  }

  public totals(): ContextDistillTotals {
    return { ...this.counters }
  }

  /** 排队并启动（不 await：回合永远不等蒸馏）。 */
  public schedule(requests: readonly ContextDistillRequest[], config: ContextGovernanceConfig): void {
    if (isEmpty(requests)) return

    for (const request of requests) {
      this.queue.push(request)
      this.counters.requested += 1
    }
    this.pump(config)
  }

  /**
   * 取走待应用产物（epoch 边界调用）。
   *
   * `generation` 不匹配的产物**直接丢弃**：账本一旦整本重建，记录 id 会被重新发号，同一个 id
   * 指向的已经是另一条消息——把上一代的摘要贴到这一代的记录上是张冠李戴，比不摘要糟得多。
   */
  public takePending(generation: number): ContextDistillProduct[] {
    const fresh: ContextDistillProduct[] = []
    for (const product of this.pending) {
      if (product.generation === generation) fresh.push(product)
      else this.counters.staleDropped += 1
    }
    this.pending.length = 0
    return fresh
  }

  /** 丢弃全部在途状态（账本重建 / 会话失效）。 */
  public reset(): void {
    this.queue.length = 0
    this.counters.staleDropped += this.pending.length
    this.pending.length = 0
  }

  /** 等到队列清空（测试与 headless 实验用；产品路径永不 await 它）。 */
  public async settled(): Promise<void> {
    while (this.running) await this.running
  }

  private pump(config: ContextGovernanceConfig): void {
    if (this.running || isEmpty(this.queue)) return

    const request = this.queue.shift()
    if (!request) return

    this.running = this.runOne(request, config).finally(() => {
      this.running = null
      this.pump(config)
    })
  }

  private async runOne(
    request: ContextDistillRequest,
    config: ContextGovernanceConfig
  ): Promise<void> {
    const distiller = this.options.resolveDistiller()
    if (!distiller) {
      // 规划期查过一次，跑到这里才没了 = 模型运行时被换掉。段落仍非折不可，回落骨架。
      this.settle(buildSkeletonFallbackProduct(request, 'error'))
      return
    }

    const timeoutMs = Math.max(1, config.distillation.timeoutMs)
    try {
      // `withTimeout` 内部就是"发信号 + 竞速"：端口不一定认 AbortSignal，治理不能挂在别人的礼貌上。
      const outcome = await this.timers.withTimeout(timeoutMs, (signal) =>
        distiller({
          members: request.members,
          goalHint: request.goalHint,
          targetChars: request.targetChars,
          maxInputChars: config.distillation.maxInputChars,
          requiredAnchors: request.requiredAnchors,
          mode: config.instruments.distill,
          sessionId: this.options.sessionId,
          signal,
        })
      )
      this.settle(buildDistillProduct({ request, rawText: outcome }))
    } catch (error) {
      if (isTimeoutError(error)) {
        this.log.warn('蒸馏超时，回落 I1 骨架', { epoch: request.epoch, timeoutMs })
        this.settle(buildDistillProduct({ request, rawText: null, failure: 'timeout' }))
        return
      }

      this.log.warn('蒸馏调用失败，回落 I1 骨架', {
        epoch: request.epoch,
        error: AppError.getMessage(error),
      })
      this.settle(buildDistillProduct({ request, rawText: null, failure: 'error' }))
    }
  }

  private settle(product: ContextDistillProduct): void {
    if (product.instrument === 'distill') this.counters.accepted += 1
    else if (product.rejection === 'timeout') this.counters.timedOut += 1
    else if (product.rejection === 'error') this.counters.failed += 1
    else this.counters.rejected += 1

    this.pending.push(product)
    // 积压超限时丢最旧的：产物越老越可能跨代作废，留新的更划算。
    if (this.pending.length > this.maxPending) {
      this.pending.splice(0, this.pending.length - this.maxPending)
      this.counters.staleDropped += 1
    }
  }
}
