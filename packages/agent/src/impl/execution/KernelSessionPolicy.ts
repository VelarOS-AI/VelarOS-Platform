import type { KernelInputDelivery, KernelRuntimeStatus, KernelSessionInputKind, ResolveKernelRuntimeStatusInput } from '../../types/execution.js'
import { resolveKernelInputDelivery, resolveKernelRuntimeStatus } from '../../utils/execution/policy'

/**
 * 会话通道的准入与运行态策略：宿主可整体替换。
 *
 * 规则本身是纯函数（utils/execution/policy.ts），这里只把它们收成一个可注入的策略件，
 * 让宿主换掉「怎么投递、什么时候算可取消」时不必改会话通道本身。
 */
export class KernelSessionPolicy {
  /** 一条会话输入按种类决定投递方式：引导插队、其余排队。 */
  public resolveDelivery(input: { kind: KernelSessionInputKind }): KernelInputDelivery {
    return resolveKernelInputDelivery(input)
  }

  /** 把会话的在途状态归约成一份对外的运行态快照（含"能不能取消"的结论）。 */
  public resolveRuntimeStatus(input: ResolveKernelRuntimeStatusInput): KernelRuntimeStatus {
    return resolveKernelRuntimeStatus(input)
  }
}
