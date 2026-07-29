// 域：SessionStore 引擎的注入端口与追加输入类型（宪章 §3 会话层 / §6 entry 类型学 / §12.6 缺席值单一）。
//
// 引擎不直读 app 路径：账本文件位置一律经注入的 `SessionLedgerLocator` 解析（宪章 §1「数据根单写者」
// 是 host 部署不变量，账本层只认端口）。id / createdAt / 告警回落全部可注入，property 电池借此驱动
// 确定性时钟与序号工厂。
import type { SessionEntry } from '@velaros-ai/agent-protocol'

/** 引擎负责分配、追加输入不得携带的基字段。 */
type EngineAssignedField = 'id' | 'parentId' | 'createdAt'

/** 判别联合上的分配式 Omit：逐变体去字段后重新联合，保住判别字段 `type` 的收窄能力。 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * 追加输入：{@link SessionEntry} 去掉引擎负责分配的基字段（id/parentId/createdAt 由账本层填写）。
 *
 * 调用方只声明「这是哪一类 entry + 该类的负载」，树形指针与身份由引擎在串行写内原子分配，避免调用方
 * 各自拼 parentId 造成竞态分叉。
 */
export type SessionEntryDraft = DistributiveOmit<SessionEntry, EngineAssignedField>

/** 数据根 port：把 sessionId 解析成账本文件的绝对路径。引擎只认此端口，不直读 app 路径。 */
export interface SessionLedgerLocator {
  resolveLedgerPath(sessionId: string): string
}

/** 非致命恢复事件回落（尾行截断 / 开档修复等）。缺席时事件仅进账本 handle 的内存 warnings。 */
export type SessionLedgerWarn = (message: string, detail: Record<string, unknown>) => void

/** SessionStore 引擎装配依赖。除 locator 外均可缺省；缺省用系统时钟 / randomUUID / 无回落。 */
export interface SessionStoreDeps {
  locator: SessionLedgerLocator
  now?: () => number
  nextEntryId?: () => string
  warn?: SessionLedgerWarn
}
