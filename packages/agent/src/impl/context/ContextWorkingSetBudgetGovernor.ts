import type { ContextLedgerEntry, ContextWorkingSetBudgetAllocation, ContextWorkingSetBudgetGovernorInput, ContextWorkingSetZoneId } from '../../types/context.js'
import { allocateContextWorkingSetBudget, annotateContextWorkingSetBudgetLedger, resolveContextWorkingSetZoneCharBudget } from '../../utils/context/context-working-set-budget-governor'

/**
 * 上下文分区预算的分配件：按本轮账本把可用窗口折成各分区的额度与超额，宿主可整体替换。
 *
 * 分配规则本身是纯函数（utils/context/context-working-set-budget-governor.ts），这里只把它们收成
 * 一件可注入的东西，让宿主换掉「谁保底多少、能借多少」时不必改编译请求与降级阶梯那两条主链。
 * 纯计算，不落任何状态：同一份输入永远得到同一份分配。
 */
export interface ContextWorkingSetBudgetGovernorApi {
  /**
   * 算出本轮各分区的预算快照：保底、软上限、借用后的有效上限、实占与超额，外加全局的可用窗口与总超额。
   * 账本里认不出的分区直接跳过；输入缺项按缺省口径回落，不抛错。
   */
  allocate(input: ContextWorkingSetBudgetGovernorInput): ContextWorkingSetBudgetAllocation
  /**
   * 把分配结果抄回账本每一条上（保底 / 软上限 / 有效上限 / 实占 / 超额），让单条账目自己就能解释所在分区的额度。
   * 返回新数组，传进来的账本不变。
   */
  annotateLedger<TEntry extends ContextLedgerEntry>(
    ledger: readonly TEntry[],
    allocation: ContextWorkingSetBudgetAllocation
  ): TEntry[]
  /** 把某个分区的有效上限折成字符预算，供按字符裁剪的地方（工具描述预算、溢出降级的收窄档）直接用。 */
  resolveZoneCharBudget(
    allocation: ContextWorkingSetBudgetAllocation,
    zone: ContextWorkingSetZoneId
  ): number
}

export class ContextWorkingSetBudgetGovernor implements ContextWorkingSetBudgetGovernorApi {
  public allocate(input: ContextWorkingSetBudgetGovernorInput): ContextWorkingSetBudgetAllocation {
    return allocateContextWorkingSetBudget(input)
  }

  public annotateLedger<TEntry extends ContextLedgerEntry>(
    ledger: readonly TEntry[],
    allocation: ContextWorkingSetBudgetAllocation
  ): TEntry[] {
    return annotateContextWorkingSetBudgetLedger(ledger, allocation)
  }

  public resolveZoneCharBudget(
    allocation: ContextWorkingSetBudgetAllocation,
    zone: ContextWorkingSetZoneId
  ): number {
    return resolveContextWorkingSetZoneCharBudget(allocation, zone)
  }
}
