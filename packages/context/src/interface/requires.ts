import type { ContextCompletionResult } from '../contract/context.js'
import type { ContextObjectCollection,ContextObjectCollectionResult,ContextRecordPage,ContextRecordQuery,ContextState } from '../contract/context.js'
import type { ContextPlannerDecision, ContextPlannerInput, ContextReadStamp, ContextSourceCapabilities, ContextSourceHit, ContextSourceRead, ContextTarget, ContextTaskScope, ContextTime, ContextViewForm, ContextViewLimits, ModelView } from '../contract/context.js'
import type {StoreChanges,StoreCreate,StoreDescriptor,StoreDirectory,StoreEvent,StoreEventAck,StoreEventPage,StoreMutation,StoreObject,StorePage,StorePublish,StoreSubscription,StoreWatch} from '../contract/store.js'

import type { ContextRuntime } from './provides.js'
/** 唯一持久化端口；比较并交换必须跨实例原子执行。 */
export interface ContextStorage {
  /** 持久结构化对象和可恢复变更流；适配器支持时装配 system.store。 */
  readonly stores?:StoreStorage
  /** 读取会话元数据，未建立时返回 null。 */
  load(sessionId: string): Promise<Nullable<ContextState>>
  /** 原子提交；version 不符返回 false，IO 故障抛错。 */
  compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState): Promise<boolean>
  /** 保存正文并返回不可变对象 id；必须先持久化再返回。 */
  put(sessionId: string, text: string): Promise<string>
  /** 读取所属会话的原始正文；不存在返回 null。 */
  get(sessionId: string, objectId: string): Promise<Nullable<string>>
  /** 可选索引查询；未提供时调用方沿用完整元数据读取。 */
  records?(sessionId:string,query:ContextRecordQuery):Promise<ContextRecordPage>
  /** 宿主显式执行的孤立对象回收；不会移除任何已归档记录。 */
  collect?(sessionId:string,options:ContextObjectCollection):Promise<ContextObjectCollectionResult>
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
  verify(view: ModelView, signal: AbortSignal): Promise<Omit<ContextCompletionResult,'completed'>>
}

/** 环境来源变化通知，订阅失败不影响源事实。 */
export interface TurnContextAppendBus {
 /** 订阅所有环境来源变化。 */
 subscribe(listener:TurnContextAppendListener):()=>void
 /** 发布来源已经变化的通知。 */
 emit(sessionId:string,sourceId:string):void
}
/** 宿主监听环境变更。 */
export type TurnContextAppendListener=(sessionId:string,sourceId:string)=>void
/** 有界环境账本的实例配置。 */
export interface TurnContextLedgerOptions {
 /** 每个会话保留的最大事件数。 */
 readonly maxEntries?:number
 /** 来源同时保留的最大会话数。 */
 readonly maxSessions?:number
 /** 是否通知可见来源的订阅方。 */
 readonly notifyRenderer?:boolean
 /** 宿主的实例广播总线。 */
 readonly appendHub?:TurnContextAppendBus
}

/** 与上下文共用可靠存储的持久共享空间，所有提交必须跨连接原子执行。 */
export interface StoreStorage {
 /** 持久发布单条消息，调用重试不会重复发布。 */
 publish(input:StorePublish):Promise<StoreEvent>
 /** 替换主题订阅；省略 after 从当前消息头开始，相同声明保留进度。 */
 subscribe(store:string,consumer:string,topics:readonly string[],operationId:string,after?:number):Promise<StoreSubscription>
 /** 按订阅与实时权限读取消息，delivery 只读尚未投递部分。 */
 messages(store:string,consumer:string,read:readonly string[],query?:{after?:number;limit?:number;pending?:boolean;delivery?:boolean}):Promise<Nullable<StoreEventPage>>
 /** 接受模型帧后确认投递游标，不表示业务处理完成。 */
 delivered(store:string,consumer:string,revision:number,through:number):Promise<void>
 /** 确认精确消息身份，拒绝越权和窗口外身份。 */
 acknowledgeEvents(store:string,consumer:string,read:readonly string[],ids:readonly string[],operationId:string):Promise<StoreEventAck>
 /** 等待消息头变化，支持跨进程持久轮询和取消。 */
 waitEvents(store:string,after:number,signal:AbortSignal):Promise<void>

 /** 创建有稳定身份的空间并原子保存创建回执；相同调用返回同一空间。 */
 create(input:StoreCreate):Promise<StoreDescriptor>
 /** 按拥有者或宿主授予的标识过滤后分页，不泄漏其他目录。 */
 directory(scope:string,owner:string,ids:readonly string[],after?:string,limit?:number):Promise<StoreDirectory>
 /** 读取当前宿主边界内的空间元数据。 */
 describe(scope:string,id:string):Promise<Nullable<StoreDescriptor>>
 /** 核对创建调用是否持久化。 */
 creation(scope:string,owner:string,operationId:string):Promise<Nullable<StoreDescriptor>>
 /** 宿主归档空间并拒绝后续模型访问，原数据与回执保留。 */
 archive(scope:string,id:string):Promise<void>
 /** 读取当前对象或墓碑，未创建时为 null。 */
 get(store:string,key:string):Promise<Nullable<StoreObject>>
 /** 只列出授权前缀内的对象元数据。 */
 list(store:string,query:{readonly read:readonly string[];readonly prefix?:string;readonly after?:string;readonly limit?:number}):Promise<StorePage>
 /** 向已创建的活动空间原子写入对象、变更和幂等回执；版本冲突不产生效果。 */
 commit(input:StoreMutation):Promise<StoreObject>
 /** 按实际调用身份核对已提交写入。 */
 receipt(store:string,operationId:string):Promise<Nullable<StoreObject | StoreWatch | StoreEvent | StoreSubscription | StoreEventAck>>
 /** 在已创建的活动空间替换消费者关注集合；首次设置从当前提交位置开始。 */
 watch(store:string,consumer:string,keys:readonly string[],prefixes:readonly string[],operationId:string):Promise<StoreWatch>
 /** 读取当前订阅的变更页，不推进消费位置。 */
 changes(store:string,consumer:string,read:readonly string[],limit?:number):Promise<Nullable<StoreChanges>>
 /** 仅确认实际投递帧覆盖的位置；旧订阅代次不推进新订阅。 */
 acknowledge(store:string,consumer:string,revision:number,through:number):Promise<void>
 /** 等待空间提交变化；跨连接使用有界轮询，取消时释放等待资源。 */
 wait(store:string,after:number,signal:AbortSignal):Promise<void>
}
