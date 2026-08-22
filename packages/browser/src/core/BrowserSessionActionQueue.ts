import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

/**
 * 单个动作允许独占一条会话队列的上限 —— **最后一道网，不是主超时**。
 *
 * 判据取「任何一条合法动作都跑不到这么久」：队列里最长的合法动作是页内等待
 * （`waitForSelector` / `waitForPage` 各自钳到 60s）与 `presentPage` 那条
 * 「等导航稳定 30s + loadUrl 30s」的串联，都在 65s 上下。150s 之外只可能是**死结**。
 *
 * 存在的理由是一次 brick 级事故（AGENT-12）：`webContents.executeJavaScript` 在渲染进程
 * 被脚本卡死 / 页面正在导航走时**永不 settle**，它占住队头，后面所有动作——包括
 * 后续的 `presentPage`、包括清理用的 `closeSession`——全都排在死结后面，
 * 14 分钟不返回，abort 也救不回来（信号只在排队闭包**内部**被检查，闭包压根没被调度），
 * 只有重启应用。**一个永不 settle 的 promise 不许换来一条永久瘫痪的会话。**
 */
const DefaultActionHoldCapMs = 150_000

export interface BrowserSessionActionOptions {
  /** 排队期间的取消信号：还没轮到就中止时立刻退出排队，不再执行动作。 */
  readonly signal?: AbortSignal
  /** 覆盖 {@link DefaultActionHoldCapMs}；只在调用方确知本动作更短/更长时才传。 */
  readonly holdCapMs?: number
  /** 超时正文里的动作名，便于把死结定位到具体调用点。 */
  readonly label?: string
}

/**
 * 队列名额 —— **把「动作 settle 了」与「名额释放了」拆成两件事**。
 *
 * 这正是本文件的核心判决：上一版拿动作自己的 promise 当队列链，于是
 * 「动作永不 settle」在结构上等价于「会话永久瘫痪」，没有任何一层能插手。
 * 名额独立之后，超时与中止都能在动作还挂着的时候把队伍放行。
 */
interface BrowserSessionQueueSlot {
  readonly released: Promise<void>
  readonly release: () => void
}

function createQueueSlot(): BrowserSessionQueueSlot {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return { released, release }
}

/**
 * 浏览器会话队列
 * - 同一 session 的所有 WebContents 操作串行执行，避免导航与快照/读取互相打断。
 * - 不同 session 仍可并发。
 * - **任何一个动作都不能永久占住队列**：见 {@link DefaultActionHoldCapMs} 与 {@link BrowserSessionQueueSlot}。
 */
class BrowserSessionActionQueue {
  /** 每个 session 一条 Promise 链；链上排的是**名额**，不是动作本身。 */
  private readonly writeQueues = new Map<string, Promise<unknown>>()

  /** 写操作：串行排队执行 */
  public run<T>(
    sessionId: string,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions = {}
  ): Promise<T> {
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve()
    const slot = createQueueSlot()
    // 前一个 action 即使失败，也不能阻断后续排队操作。
    // @arch-guard:suspend code-style/forbid-swallowed-errors 理由：这里 catch 的是**前驱**的链，不是调用方那条——前驱的错误已由 executeInTurn 原样抛给它自己的调用方。此处不吞，一次失败就会把整条链变成 rejected，后面所有排队者被连坐，那正是本次要消灭的死结。
    const tail = previous.catch(() => undefined).then(() => slot.released)
    this.writeQueues.set(sessionId, tail)
    void tail.then(() => {
      if (this.writeQueues.get(sessionId) === tail) {
        // 只有自己仍是队尾时才清理，避免清掉后来追加的操作。
        this.writeQueues.delete(sessionId)
      }
    })

    return this.executeInTurn(previous, slot, action, options)
  }

  /**
   * 只读操作仍会访问共享 WebContents，需要跟导航/点击保持顺序。
   *
   * 当前实现与 run 行为完全一致；保留独立方法是给未来扩展（如读写锁、并行读）留接口。
   * 现阶段不要把它当成“可以并发”的标志。
   */
  public runReadOnly<T>(
    sessionId: string,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions = {}
  ): Promise<T> {
    return this.run(sessionId, action, options)
  }

  /**
   * 丢掉这条会话现有的排队链，**下一次 `run` 立刻开跑**。
   *
   * 拆卸路径（`closeSession`）必须走它：清理绝不能排在死结后面，否则「会话卡住 → 关不掉 →
   * 重开还是那条卡住的队列」，只剩重启应用一条路。已经在排队的旧动作不受影响，
   * 它们仍按原链等待，并各自被名额上限兜底。
   */
  public clear(sessionId: string): void {
    this.writeQueues.delete(sessionId)
  }

  public clearAll(): void {
    this.writeQueues.clear()
  }

  private async executeInTurn<T>(
    previous: Promise<unknown>,
    slot: BrowserSessionQueueSlot,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions
  ): Promise<T> {
    try {
      await this.awaitTurn(previous, options.signal)
    } catch (error) {
      // 没轮到就被中止：立刻退出排队。不放名额的话，一次中止会让整条队伍陪着它一起等。
      slot.release()
      throw error
    }
    return this.runWithHoldCap(slot, action, options)
  }

  /**
   * 等前一个名额，**同时听中止信号**。
   *
   * 上一版没有这一格，于是 `abortSignal?.throwIfAborted()` 全写在排队闭包**内部**——
   * 队头死结时闭包永远不被调度，信号永远没人检查，中止对卡住的会话完全无效。
   */
  private async awaitTurn(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    // @arch-guard:suspend code-style/forbid-swallowed-errors 理由：同 run()——等的是**前驱**的名额，前驱的错误归它自己的调用方；这里只关心「轮到我了没有」，成败无关。
    const settled = previous.catch(() => undefined)
    if (!signal) {
      await settled
      return
    }
    signal.throwIfAborted()

    let onAbort: () => void = () => undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new AppError('CANCELLED', '浏览器会话动作已取消。'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([settled, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async runWithHoldCap<T>(
    slot: BrowserSessionQueueSlot,
    action: () => Promise<T>,
    options: BrowserSessionActionOptions
  ): Promise<T> {
    const holdCapMs = options.holdCapMs ?? DefaultActionHoldCapMs
    const label = options.label ?? 'browser-session-action'
    const timers = new TimerScope({ name: 'BrowserSessionActionQueue' })
    try {
      // 超时后动作本体仍挂在原地（没有办法强杀一个 Electron 的 executeJavaScript），
      // 但**名额会在 finally 里还回去**——队伍继续走，会话不再是死的。
      return await timers.withTimeout(holdCapMs, () => action(), {
        label,
        timeoutMessage: `浏览器会话动作 ${label} 超过 ${holdCapMs}ms 未返回，判定为死结并放行队列。`,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new AppError(
          'TIMEOUT',
          `浏览器页面在 ${holdCapMs}ms 内没有响应 ${label}：页面可能已崩溃或被脚本卡死。` +
            '这次操作没有结果，但会话已经放行，可以继续执行后续操作。',
          error
        )
      }
      throw error
    } finally {
      slot.release()
      timers.dispose()
    }
  }
}

export { BrowserSessionActionQueue }
