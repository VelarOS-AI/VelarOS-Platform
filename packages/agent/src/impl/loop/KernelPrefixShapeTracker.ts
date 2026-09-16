
import type { KernelPrefixShape, KernelPrefixShapePhase } from '../../types/loop.js'
import { buildKernelPrefixShape, compareKernelPrefixShape, recordKernelPrefixShapeDiagnostic, resolvePrefixShapeTrackerKey } from '../../utils/loop/kernel-prefix-shape-tracker'

/** 记一次前缀形状要给的东西：账本按「哪条会话 + 哪条链路 + 哪个模型」分格，外加这次算出的形状。 */
export interface KernelPrefixShapeTrackerRecordInput {
  /**
   * 这次请求属于哪条会话。缺席或等于无身份兜底值时整条记录不入账——兜底键是所有无身份会话共用的
   * 那一格，按它索引会把不同会话的前缀混成一条，报出根本不存在的漂移。
   */
  sessionId?: LooseOptional<string>
  /** 哪条链路（`stream` 主面 / `query` 子 Agent 面）；两条链路各记各的，不互相污染。 */
  phase: KernelPrefixShapePhase
  /** 本次请求实际用的模型 id；换模型等于换一本账，因为前缀缓存本来就不跨模型。 */
  model: string
  /** 本次请求算出的前缀形状（system / tools / 历史改写指纹的哈希）。 */
  current: KernelPrefixShape
}

/** 记完一次的回执：拿它去和上一次比，就能判断本轮前缀是否变了、变在哪。 */
export interface KernelPrefixShapeTrackerRecord {
  /** 刚记进账本的这一份形状（就是入参里的 current）。 */
  current: KernelPrefixShape
  /** 同一把键上一次记的形状；首次记录或无身份会话时缺席，此时诊断一律判「没变」。 */
  previous?: KernelPrefixShape
}

/**
 * 前缀形状账本：只为回答一句话——「这一轮的稳定前缀跟上一轮还是同一份吗」。
 *
 * 谁持有：`StreamTurn` 与 `QueryTurn` 各一个实例（跟着 turn helper 活，进程内内存，不落盘）。
 * 什么时候调：请求编译完、发给 provider 之前调 `record()`，把回执交给
 * `recordKernelPrefixShapeDiagnostic` 写进本回合的 provider 账本；`cache-prefix-shape` 诊断里的
 * 「前缀变了 / 变在 system 还是 tools」全靠它给的 previous。
 * 只是诊断，不影响发送：无论变没变都照发，记账失败也不该阻断一轮请求（本类不抛错）。
 */
export interface KernelPrefixShapeTrackerApi {
  /**
   * 记一次并返回 {current, previous}。同一把键（会话 + 链路 + 模型）后记的覆盖先记的；
   * 会话无身份时不入账，只把 current 原样回传（于是诊断判「没有上一份」而不是误报漂移）。
   */
  record(input: KernelPrefixShapeTrackerRecordInput): KernelPrefixShapeTrackerRecord
  /** 丢账：给 key 三件套就只丢那一格，不给就整本清空。会话结束或要重头比对时用。 */
  clear(input?: Omit<KernelPrefixShapeTrackerRecordInput, 'current'>): void
}

class KernelPrefixShapeTracker implements KernelPrefixShapeTrackerApi {
  private readonly shapes = new Map<string, KernelPrefixShape>()

  public record(input: KernelPrefixShapeTrackerRecordInput): KernelPrefixShapeTrackerRecord {
    const key = resolvePrefixShapeTrackerKey(input)
    if (!key) return { current: input.current }

    const previous = this.shapes.get(key)
    this.shapes.set(key, input.current)
    return previous ? { current: input.current, previous } : { current: input.current }
  }

  public clear(input?: Omit<KernelPrefixShapeTrackerRecordInput, 'current'>): void {
    if (!input) {
      this.shapes.clear()
      return
    }

    const key = resolvePrefixShapeTrackerKey(input)
    if (key) this.shapes.delete(key)
  }
}

export {
  buildKernelPrefixShape,
  compareKernelPrefixShape,
  KernelPrefixShapeTracker,
  recordKernelPrefixShapeDiagnostic,
}
