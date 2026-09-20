import type { ContextState } from '../contract/context.js'
import type { ContextPlannerDecision, ContextPlannerInput, ContextReadStamp, ContextSourceCapabilities, ContextSourceHit, ContextSourceRead, ContextTarget, ContextTaskScope, ContextTime, ContextViewForm, ContextViewLimits, ModelView } from '../contract/context.js'

import type { ContextRuntime } from './provides.js'
/** 唯一持久化端口；比较并交换必须跨实例原子执行。 */
export interface ContextStorage {
  /** 读取会话元数据，未建立时返回 null。 */
  load(sessionId: string): Promise<ContextState | null>
  /** 原子提交；version 不符返回 false，IO 故障抛错。 */
  compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState): Promise<boolean>
  /** 保存正文并返回不可变对象 id；必须先持久化再返回。 */
  put(sessionId: string, text: string): Promise<string>
  /** 读取所属会话的原始正文；不存在返回 null。 */
  get(sessionId: string, objectId: string): Promise<string | null>
  /** 关闭持久化资源。 */
  close(): Promise<void>
}
/** 上下文运行时的依赖。 */
export interface ContextRuntimeOptions {
  /** 绑定的会话标识。 */
  readonly sessionId: string
  /** 宿主提供的可靠存储。 */
  readonly storage: ContextStorage
}
/** 本地存储的配置。 */
export interface LocalContextStorageOptions {
  /** SQLite 数据文件的绝对路径；目录由宿主提供。 */
  readonly path: string
}

/** 领域适配器提供只读证据；每个方法必须落实当前空间范围和内容发布规则。 */
export interface ContextSourcePort {
  /** 登记后的稳定数据源名称。 */
  readonly id: string
  /** 真实一致性保证。 */
  readonly capabilities: ContextSourceCapabilities
  /** 检查目标当前是否允许进入该任务的模型工作区，发布前再次调用。 */
  authorize(scope: ContextTaskScope, target: ContextTarget, signal: AbortSignal): Promise<boolean>
  /** 有界检索，预览必须符合与正文相同的空间规则。 */
  search(scope: ContextTaskScope, query: string, limit: number, signal: AbortSignal): Promise<readonly ContextSourceHit[]>
  /** 物化真实正文并返回资源级版本；禁止将模型生成文本当作源。 */
  read(scope: ContextTaskScope, target: ContextTarget, form: ContextViewForm, time: ContextTime, maxBytes: number, signal: AbortSignal): Promise<ContextSourceRead>
  /** 返回当前版本验证结果；observed-only 源返回 unknown。 */
  validate(scope: ContextTaskScope, stamp: ContextReadStamp, signal: AbortSignal): Promise<'current' | 'changed' | 'unknown'>
}

/** 上下文模型只能返回有限决策，不能得到世界操作端口。 */
export interface ContextPlannerPort {
  /** 通过共享模型发送和任务计费入口调用；不在此端口直连 provider。 */
  decide(input: ContextPlannerInput, signal: AbortSignal): Promise<ContextPlannerDecision>
}

/** 单会话证据视图的装配依赖。 */
export interface ContextViewOptions {
  /** 当前会话，引用无法跨这个边界解析。 */
  readonly sessionId: string
  /** 与原始记录和 Kernel 日志相同的持久存储。 */
  readonly storage: ContextStorage
  /** 与主循环相同的原始记录入口。 */
  readonly context: ContextRuntime
  /** 当前空间装配的只读数据源。 */
  readonly sources: readonly ContextSourcePort[]
  /** 有限预算覆盖；省略字段使用默认值。 */
  readonly limits?: Partial<ContextViewLimits>
}

/** 一次物化的依赖，生命周期由任务租约限定。 */
export interface ContextBuildOptions {
  /** 执行正文由租约投影提供时只保留未决效果，避免重复累计历史。 */
  readonly executionDetails?:boolean
  /** 当前仍有可见租约的执行，未知效果始终保留。 */
  readonly visibleExecutionIds?:readonly string[]
  /** 只有语义请求可以调用此策略。 */
  readonly planner?: ContextPlannerPort
  /** 完整视图最大字符数；真正 token 门由 ProviderRequestCompiler 执行。 */
  readonly maxChars: number
}

/** 领域验收器只声明其实际检查的结果。 */
export interface ContextCompletionPort {
  /** 校验当前证据对应的结果；没有此端口时交付保持 unverified。 */
  verify(view: ModelView, signal: AbortSignal): Promise<{ readonly verified: boolean; readonly reason: string }>
}
