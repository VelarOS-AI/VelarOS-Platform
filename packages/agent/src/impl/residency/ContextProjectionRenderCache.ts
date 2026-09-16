import type { ContextProjectionRenderCache as ContextProjectionRenderCacheContract, ContextRecord, ContextResidency } from '../../types/residency.js'

/**
 * 投影渲染长度的复用缓存实体。
 *
 * 投影与度量是纯函数（`src/utils/residency/projection.ts`），状态不能留在那里；这个类就是那份状态的家：
 * 谁想跨次投影复用渲染结果，谁持有一份并把它传进 `projectContextLedger` / `measureLedgerProjection`。
 * 键按记录对象身份弱引用，账本重建、记录被丢弃后缓存条目自动消失，不需要显式失效。
 *
 * 命中的前提是 P1（记录一旦入账永不改写）：同一条记录在同一驻留态下的渲染字节恒定。
 */
export interface ContextProjectionRenderCacheApi extends ContextProjectionRenderCacheContract {}

export class ContextProjectionRenderCache implements ContextProjectionRenderCacheApi {
  /** 记录对象 → 各驻留态下已量过的字符数；弱引用，记录出账即随之释放。 */
  private readonly renderedCharsByRecord = new WeakMap<ContextRecord, Map<ContextResidency, number>>()

  public get(record: ContextRecord, residency: ContextResidency): Optional<number> {
    return this.renderedCharsByRecord.get(record)?.get(residency)
  }

  public set(record: ContextRecord, residency: ContextResidency, chars: number): void {
    const cached = this.renderedCharsByRecord.get(record)
    if (cached) cached.set(residency, chars)
    else this.renderedCharsByRecord.set(record, new Map([[residency, chars]]))
  }
}
