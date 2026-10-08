import type { ContextRuntime } from '../impl/SessionContext.js'
import type {
  ContextCompletionBinding,
  ContextCompletionResult,
  ContextDeliveryRequirement,
  ContextVerificationCheck,
  ContextVerificationCost,
  ContextVerificationFingerprint,
} from '../types/context.js'
import type {
  ContextMetadata,
  ContextObjectCollection,
  ContextObjectCollectionResult,
  ContextRecord,
  ContextRecordPage,
  ContextRecordQuery,
  ContextRecordSelection,
  ContextRecordSnapshot,
  ContextState,
} from '../types/context.js'
import type {
  ContextReadStamp,
  ContextSourceCapabilities,
  ContextSourceHit,
  ContextSourceRead,
  ContextTarget,
  ContextTaskScope,
  ContextTime,
  ContextViewForm,
  ContextViewLimits,
  ModelView,
} from '../types/context.js'
import type {
  StoreChanges,
  StoreCreate,
  StoreDescriptor,
  StoreDirectory,
  StoreEvent,
  StoreEventAck,
  StoreEventPage,
  StoreMutation,
  StoreObject,
  StorePage,
  StorePublish,
  StoreSubscription,
  StoreWatch,
} from '../types/store.js'

/** 数据库无关的唯一持久化端口；适配器负责事务、一致性、持久化和连接生命周期。 */
export interface ContextStorage {
  /** 本地适配器可登记本实例的进程所有者；其他存储沿用有限租约。 */
  readonly leaseOwner?: string
  /** 仅在同一宿主上能证明所有者已退出时返回 false；未知必须保留租约。 */
  leaseOwnerActive?(owner: string): Optional<boolean>
  /** 原子签发会话内唯一的 8 位十六进制身份；已签发身份在回收和重启后仍占用。省略时由同存储实例的签发器防冲突。 */
  allocateReferenceId?(sessionId: string): Promise<string>
  /** 同一持久命名空间内的共享对象与消息端口；省略时不发现 system.store，不能回退到另一份隐式存储。 */
  readonly stores?: StoreStorage
  /** 一致读取完整状态及有序记录；未建立时返回 null，返回值不与存储共享可变内存。 */
  load(sessionId: string): Promise<Nullable<ContextState>>
  /** 可选小快照：只返回元数据，与 load 使用同一 version；不包含 records，返回值与数据库隔离。 */
  loadMetadata?(sessionId: string): Promise<Nullable<ContextMetadata>>
  /** 可选一致索引快照：元数据和多组记录选择在同一版本读取；空选择只读元数据，不存在返回 null。 */
  selectSnapshot?(
    sessionId: string,
    selections: readonly ContextRecordSelection[]
  ): Promise<Nullable<ContextRecordSnapshot>>
  /** 可选增量 CAS：保留历史目录，原子替换元数据并追加新目录项，存储分配递增序号；与完整 CAS/appendRecord 共用版本。非空 objectId 必须存在，重复 ref 拒绝；空 objectId 仅表示无正文索引。 */
  compareAndSwapMetadata?(
    sessionId: string,
    expectedVersion: number,
    state: ContextMetadata,
    append?: ReadonlyArray<Omit<ContextRecord, 'sequence'>>
  ): Promise<boolean>
  /** 跨实例原子提交状态和记录，version 必须为 expectedVersion+1；未建会话版本为 0。冲突只返回 false，IO 故障抛错；缺失正文不得发布，失败不得部分提交。 */
  compareAndSwap(sessionId: string, expectedVersion: number, state: ContextState): Promise<boolean>
  /** 可选原子追加：事务内验证正文与同会话来源，分配递增 sequence 并推进状态 version，保留其他元数据；重复 ref 拒绝，失败不发布。省略时使用完整 CAS。 */
  appendRecord?(sessionId: string, record: Omit<ContextRecord, 'sequence'>): Promise<ContextRecord>
  /** 在会话内先持久化不可变正文再返回不透明 id；上层不解析 id 或假设它是路径、哈希或数据库主键。 */
  put(sessionId: string, text: string): Promise<string>
  /** 读取所属会话的原始正文；跨会话或不存在时返回 null，IO 故障不得伪装成缺失。 */
  get(sessionId: string, objectId: string): Promise<Nullable<string>>
  /** 可选索引：按 sequence 升序、after 排他、title/refId 精确过滤；语义等同于 load，未提供时调用方读取完整状态。 */
  records?(sessionId: string, query: ContextRecordQuery): Promise<ContextRecordPage>
  /** 可选孤立正文回收：事务内核对版本与引用，保留写入宽限期；默认预演，不移除记录引用的正文或共享 store。 */
  collect?(
    sessionId: string,
    options: ContextObjectCollection
  ): Promise<ContextObjectCollectionResult>
  /** 幂等释放本适配器的连接和等待资源，不删除数据；连接池适配器只释放自己的租约，不关闭其他 Runtime 的连接。 */
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
  search(
    scope: ContextTaskScope,
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly ContextSourceHit[]>
  /** 物化真实正文并返回资源级版本；禁止将模型生成文本当作源。 */
  read(
    scope: ContextTaskScope,
    target: ContextTarget,
    form: ContextViewForm,
    time: ContextTime,
    maxBytes: number,
    signal: AbortSignal
  ): Promise<ContextSourceRead>
  /** 返回当前版本验证结果；observed-only 源返回 unknown。 */
  validate(
    scope: ContextTaskScope,
    stamp: ContextReadStamp,
    signal: AbortSignal
  ): Promise<'current' | 'changed' | 'unknown'>
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
  readonly executionDetails?: boolean
  /** 当前仍有可见租约的执行，未知效果始终保留。 */
  readonly visibleExecutionIds?: readonly string[]
  /** 完整视图最大字符数；真正 token 门由 ProviderRequestCompiler 执行。 */
  readonly maxChars: number
}

/** 领域验收器只声明其实际检查的结果。 */
export interface ContextCompletionPort {
  /** 验收前固定必需交付项；同 id 的当前核查证明必须覆盖列出的全部产物。 */
  requirements?(
    view: ModelView,
    signal: AbortSignal
  ): readonly ContextDeliveryRequirement[] | Promise<readonly ContextDeliveryRequirement[]>
  /** 校验当前证据对应的结果；没有此端口时交付保持 unverified。 */
  verify(
    view: ModelView,
    signal: AbortSignal,
    checks?: ContextVerificationContext
  ): Promise<Omit<ContextCompletionResult, 'completed'>>
}

/** 宿主声明的核查；scope 是精确判据/参数身份，probe 必须原子读取全部有效依赖。 */
export interface ContextVerificationSpec {
  /** 当前验收器中的稳定检查身份。 */
  readonly id: string
  /** 精确业务判据及参数范围，不能只用说明文本代替。 */
  readonly scope: string
  /** 提供判据的领域核查器身份。 */
  readonly verifierId: string
  /** 核查逻辑或依赖变化时递增的判据版本。 */
  readonly verifierVersion: string
  /** 原子读取授权代次、全部产物和可识别 ABA 的变化代次；覆盖未知时返回 unknown。 */
  probe(signal: AbortSignal): Promise<ContextVerificationFingerprint>
}

/** 领域执行器的实际检查结果；complete 表示声明范围是否全部检查。 */
export interface ContextVerificationExecution extends ContextVerificationCheck {
  /** 本次真实执行是否检查了声明范围的全部要求。 */
  readonly complete: boolean
  /** 本次检查产生的真实收费身份与覆盖；零费用需明确报告空的完整清单。 */
  readonly cost?: ContextVerificationCost
}

/** 当前任务的核查 helper；只复用通过且完整、前后可信快照一致的检查。 */
export interface ContextVerificationContext {
  /** 前后探测匹配时复用原完整通过证明，否则真实执行并持久记录尝试。 */
  check(
    spec: ContextVerificationSpec,
    execute: (signal: AbortSignal) => Promise<ContextVerificationExecution>
  ): Promise<ContextVerificationCheck>
}

/** 宿主准备同一存储上的收尾记录；只有领域验收通过后才调用，不产生外部效果。 */
export interface ContextCompletionCommitPort {
  /** 核查开始时的宿主对象身份，用于将失败报告也归到原对象。 */
  readonly binding: ContextCompletionBinding
  /** 按一致快照核对宿主对象，正文先保存，记录与任务完成一起 CAS；竞争时可以再次调用。 */
  prepare(signal: AbortSignal): Promise<{
    readonly version: number
    readonly records: ReadonlyArray<Omit<ContextRecord, 'sequence'>>
  }>
}

/** 环境来源变化通知，订阅失败不影响源事实。 */
export interface TurnContextAppendBus {
  /** 订阅所有环境来源变化。 */
  subscribe(listener: TurnContextAppendListener): () => void
  /** 发布来源已经变化的通知。 */
  emit(sessionId: string, sourceId: string): void
}
/** 宿主监听环境变更。 */
export type TurnContextAppendListener = (sessionId: string, sourceId: string) => void
/** 有界环境账本的实例配置。 */
export interface TurnContextLedgerOptions {
  /** 每个会话保留的最大事件数。 */
  readonly maxEntries?: number
  /** 来源同时保留的最大会话数。 */
  readonly maxSessions?: number
  /** 是否通知可见来源的订阅方。 */
  readonly notifyRenderer?: boolean
  /** 宿主的实例广播总线。 */
  readonly appendHub?: TurnContextAppendBus
}

/** 数据库无关的共享空间端口；适配器负责跨连接原子提交对象、序号、附带消息及幂等回执，返回值与存储隔离。 */
export interface StoreStorage {
  /** 持久发布单条消息，调用重试不会重复发布。 */
  publish(input: StorePublish): Promise<StoreEvent>
  /** 替换主题订阅；省略 after 从当前消息头开始，相同声明保留进度。 */
  subscribe(
    store: string,
    consumer: string,
    topics: readonly string[],
    operationId: string,
    after?: number
  ): Promise<StoreSubscription>
  /** 按订阅与实时权限读取消息，delivery 只读尚未投递部分。 */
  messages(
    store: string,
    consumer: string,
    read: readonly string[],
    query?: { after?: number; limit?: number; pending?: boolean; delivery?: boolean }
  ): Promise<Nullable<StoreEventPage>>
  /** 接受模型帧后确认投递游标，不表示业务处理完成。 */
  delivered(store: string, consumer: string, revision: number, through: number): Promise<void>
  /** 确认精确消息身份，拒绝越权和窗口外身份。 */
  acknowledgeEvents(
    store: string,
    consumer: string,
    read: readonly string[],
    ids: readonly string[],
    operationId: string
  ): Promise<StoreEventAck>
  /** 等待持久消息头超过 after；通知仅为唤醒提示，支持跨实例、取消和所属存储关闭，无通知丢失造成的永久阻塞。 */
  waitEvents(store: string, after: number, signal: AbortSignal): Promise<void>

  /** 创建有稳定身份的空间并原子保存创建回执；相同调用返回同一空间。 */
  create(input: StoreCreate): Promise<StoreDescriptor>
  /** 按拥有者或宿主授予的标识过滤后分页，不泄漏其他目录。 */
  directory(
    scope: string,
    owner: string,
    ids: readonly string[],
    after?: string,
    limit?: number
  ): Promise<StoreDirectory>
  /** 读取当前宿主边界内的空间元数据。 */
  describe(scope: string, id: string): Promise<Nullable<StoreDescriptor>>
  /** 核对创建调用是否持久化。 */
  creation(scope: string, owner: string, operationId: string): Promise<Nullable<StoreDescriptor>>
  /** 宿主归档空间并拒绝后续模型访问，原数据与回执保留。 */
  archive(scope: string, id: string): Promise<void>
  /** 读取当前对象或墓碑，未创建时为 null。 */
  get(store: string, key: string): Promise<Nullable<StoreObject>>
  /** 只列出授权前缀内的对象元数据。 */
  list(
    store: string,
    query: {
      readonly read: readonly string[]
      readonly prefix?: string
      readonly after?: string
      readonly limit?: number
    }
  ): Promise<StorePage>
  /** 向已创建的活动空间原子写入对象、变更和幂等回执；版本冲突不产生效果。 */
  commit(input: StoreMutation): Promise<StoreObject>
  /** 按实际调用身份核对已提交写入。 */
  receipt(
    store: string,
    operationId: string
  ): Promise<Nullable<StoreObject | StoreWatch | StoreEvent | StoreSubscription | StoreEventAck>>
  /** 在已创建的活动空间替换消费者关注集合；首次设置从当前提交位置开始。 */
  watch(
    store: string,
    consumer: string,
    keys: readonly string[],
    prefixes: readonly string[],
    operationId: string
  ): Promise<StoreWatch>
  /** 读取当前订阅的变更页，不推进消费位置。 */
  changes(
    store: string,
    consumer: string,
    read: readonly string[],
    limit?: number
  ): Promise<Nullable<StoreChanges>>
  /** 仅确认实际投递帧覆盖的位置；旧订阅代次不推进新订阅。 */
  acknowledge(store: string, consumer: string, revision: number, through: number): Promise<void>
  /** 等待持久提交头超过 after；通知或有界轮询均可，取消及所属存储关闭时立即释放等待资源。 */
  wait(store: string, after: number, signal: AbortSignal): Promise<void>
}
