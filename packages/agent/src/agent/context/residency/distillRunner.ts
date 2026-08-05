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
import { isEmpty, isNotNull, isRecord, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  buildDistillProduct,
  buildSkeletonFallbackProduct,
  type ContextDistiller,
  type ContextDistillProduct,
  type ContextDistillRequest,
  type ContextDistillTotals,
  createEmptyDistillTotals,
} from './distill'
import type { ContextGovernanceConfig } from './governanceConfig'

const log = logRuntime.tag('ContextDistillRunner')

/** 等应用的产物上限：产物本身占内存，且积压超过几个就说明 epoch 根本没在跑。 */
const DefaultMaxPendingProducts = 4

export interface ContextDistillRunnerOptions {
  /** 蒸馏器解析器（晚绑：registry 是宿主级单实例，比模型运行时先造出来）。 */
  resolveDistiller: () => Nullable<ContextDistiller>
  /** 会话标识（进端口的遥测上下文）。 */
  sessionId: Nullable<string>
  maxPendingProducts?: LooseOptional<number>
}

/** `TimerScope.withTimeout` 的超时中止（与端口自己抛的错分开记账：超时不是失败）。 */
function isTimeoutError(error: unknown): boolean {
  return isRecord(error) && isString(error.name) && error.name === 'TimeoutError'
}

export class ContextDistillRunner {
  private readonly timers = new TimerScope({ name: 'ContextDistillRunner' })
  private readonly queue: ContextDistillRequest[] = []
  private readonly pending: ContextDistillProduct[] = []
  private readonly counters: ContextDistillTotals = createEmptyDistillTotals()
  private running: Nullable<Promise<void>> = null
  private readonly maxPending: number

  public constructor(private readonly options: ContextDistillRunnerOptions) {
    this.maxPending = Math.max(1, Math.floor(options.maxPendingProducts ?? DefaultMaxPendingProducts))
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
        log.warn('蒸馏超时，回落 I1 骨架', { epoch: request.epoch, timeoutMs })
        this.settle(buildDistillProduct({ request, rawText: null, failure: 'timeout' }))
        return
      }

      log.warn('蒸馏调用失败，回落 I1 骨架', {
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
