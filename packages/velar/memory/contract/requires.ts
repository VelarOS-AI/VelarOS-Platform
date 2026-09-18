/**
 * 注入面：宿主必须或可以塞进来的东西，一个注入点一个接口。
 *
 * 记忆对宿主零假设——目录在哪、SQLite 谁开、嵌入模型是谁、`velar:memory` 的空间端口由谁实现，
 * 全部经这里的口子传进来。别处不留钩子，也不给测试留钩子。
 */

import type BetterSqlite3 from 'better-sqlite3'

import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'

import type { MemoryHostScope, MemoryHostScopeInput } from '../types/host.js'
import type {
  MemoryBackendAwaitable,
  MemoryBackendCapabilities,
  MemoryBackendCaptureBatchOptions,
  MemoryBackendDescriptor,
  MemoryBackendStats,
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryDerivedIndexRebuildResult,
  MemoryDerivedIndexVersion,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryScopeId,
  MemorySessionLineageContext,
  MemorySourceEligibilityResult,
  MemoryTreeDiagnostics,
  MemoryVectorIndexRecord,
} from '../types/memory.js'

import type { MemoryTreeDomainApi } from './provides.js'

/** 宿主已打开的 SQLite 连接。记忆包自己不开库、不关库。 */
export type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

/** 宿主已打开的 SQLite 连接解析端口：树档每次用库时问它要一个连接。 */
export type MemoryDatabaseProvider = () => SQLiteDatabase

/** 记忆树运行时只依赖数据库；不携带知识库的嵌入配置。 */
export interface MemoryTreeRuntimeProviders {
  /** 宿主打开 SQLite 后给的连接解析器。 */
  databaseProvider: MemoryDatabaseProvider
}

/**
 * 一个可插拔的记忆后端（扩展点）。
 *
 * 权威层必须声明 `capture`、`recall`、`inspect`、`archive` 四个动词；`dream` 与 `govern`
 * 是按能力声明的扩展。这里用归档而非擦除，是因为现有实现只退出普通召回而不删除内容。
 * 市场装的后端实现它，经能力令牌注册进内核。
 */
export interface MemoryStoreBackend {
  /** 后端自述：id、角色、显示名、声明的动词。 */
  readonly descriptor: MemoryBackendDescriptor

  /** capture：单条证据入库。 */
  capture(input: MemoryEvidenceInput): MemoryBackendAwaitable<MemoryCaptureResult>

  /**
   * capture：批量证据入库。
   *
   * **双写接缝**：装了派生索引后，权威后端先落地，派生索引再消费落地**结果**（记录才带得动
   * 权威层分配的指针）；派生写失败只记诊断，不回滚权威写入——派生物可重建，为一个索引回滚
   * 用户刚说的话是本末倒置。
   */
  captureBatch(
    inputs: readonly MemoryEvidenceInput[],
    options?: MemoryBackendCaptureBatchOptions,
  ): MemoryBackendAwaitable<MemoryCaptureBatchResult>

  /**
   * recall：按查询召回。
   *
   * **并联接缝**：语义命中拿到的是指针，回权威后端 `getItem` 取全文；索引永远只持有指针与向量、
   * 不持有内容副本（否则「删索引」就变成了删内容）。权威层认不出的指针即孤儿，当场剔除并清理。
   */
  recall(
    query: string,
    options?: MemoryRecallOptions,
  ): MemoryBackendAwaitable<MemoryRecallItem[]>

  /** recall/inspect：按 id 读单条。 */
  getItem(id: string): MemoryBackendAwaitable<Nullable<MemoryRecallItem>>

  /** inspect：后端无关的健康读数。 */
  inspect(): MemoryBackendAwaitable<MemoryBackendStats>

  /**
   * archive：让一条记忆退出普通召回。
   *
   * 语义就是**归档**，不是物理删除——权威内容是用户资产。方法在类型上可选，是因为派生索引与
   * 本接口共用形状；**权威层必须实现它**。
   */
  archive?(id: string): MemoryBackendAwaitable<MemoryForgetResult>

  /** dream：后台整理。无整理管线的后端不实现该动词。 */
  dream?(options: MemoryDreamRunOptions): MemoryBackendAwaitable<MemoryDreamRunResult>

  /** govern：按来源（会话）批量改变证据可用性。 */
  governSourceEligibility?(
    sourceId: string,
    state: MemoryEvidenceEligibilityState,
  ): MemoryBackendAwaitable<MemorySourceEligibilityResult>

  /** govern：按单条证据改变可用性。 */
  governEvidenceEligibility?(
    evidenceId: string,
    state: MemoryEvidenceEligibilityState,
  ): MemoryBackendAwaitable<MemoryEvidenceEligibilityResult>
}

/**
 * 权威层全量枚举端口 —— **刻意不进窄端口的六动词面**。
 *
 * 重建需要「把权威层从头读一遍」，但那是**派生层的需求**，不是记忆产品的动词面：给窄端口加一个
 * `listAll` 会让每个未来后端都被迫实现一个只有索引才用的方法。因此它是一个独立端口，由权威层
 * 结构上满足，或由宿主注入。
 */
export interface MemoryAuthorityEnumeration {
  /** 权威层全部条目。允许同步/异步可迭代，实现按自己的读盘节奏分批产出。 */
  listAll(): AsyncIterable<MemoryRecallItem> | Iterable<MemoryRecallItem>
}

/**
 * 一个派生索引后端（扩展点）。
 *
 * 「派生索引」不是第二个记忆库，是权威层的一层**可摘的加速器**：只持指针不持内容，schema 或
 * 嵌入模型变了就全量重建而不是写迁移器，卸载就是 `dropIndex()`。`role` 在类型上钉死为
 * `derived-index`——角色是解析期的安全判据，可写成 `authority` 的派生索引等于给自己开后门。
 */
export interface MemoryDerivedIndexBackend extends MemoryStoreBackend {
  /** 后端自述；角色钉死为派生索引。 */
  readonly descriptor: MemoryBackendDescriptor & { readonly role: 'derived-index' }
  /** 当前索引的版本戳（形状版本 + 嵌入模型身份）。 */
  readonly indexVersion: MemoryDerivedIndexVersion

  /**
   * 索引是否已过期（落盘版本戳 ≠ 当前版本戳，含「从没建过」）。
   *
   * 过期不等于损坏：过期索引仍可召回，只是该重建了。把判定与动作分开，宿主才能自己决定重建时机，
   * 而不是被后端在召回路径上突然拖去跑一次全量嵌入。
   */
  isStale(): boolean

  /**
   * 双写的第二写：消费权威层 capture 的**结果**。
   *
   * 吃已落地的记录而不是原始入参，因为指针只有权威层能分配。返回实际写入条数。
   */
  indexEvidence(records: readonly MemoryEvidenceRecord[]): Promise<number>

  /** 从权威层全量重建（先清空后灌入，孤儿因此自然消失）。幂等。 */
  rebuild(source: MemoryAuthorityEnumeration): Promise<MemoryDerivedIndexRebuildResult>

  /** 剔除指定指针（权威层已没有的孤儿；`archive` 的批量形式）。返回实际剔除数。 */
  removePointers(ids: readonly string[]): Promise<number>

  /** 卸载：删光派生数据。签名上就够不着权威层，「清理索引的数据」在类型上不可能碰到用户的记忆内容。 */
  dropIndex(): Promise<void>
}

/**
 * `memory-files` 的文件系统端口。
 *
 * 包内**零宿主假设**：目录路径全部由宿主注入，文件读写本身也走这个窄端口——探针据此用纯内存实现
 * 直驱，不落一个真实文件。端口刻意只有六个必备方法：没有 stat/watch/权限，多一个方法就多一条把
 * 后端绑死在某个文件系统语义上的绳子。
 */
export interface MemoryFilesIo {
  /** 拼接路径片段；平台差异由实现自持。 */
  join(...segments: readonly string[]): string
  /** 递归创建目录；已存在时静默成功。 */
  ensureDirectory(directory: string): void
  /** 列出目录下的**文件名**（非递归，不含子目录）；目录不存在时返回空数组。 */
  listFiles(directory: string): readonly string[]
  /** 读文本；文件不存在返回 null（不抛）。 */
  readTextFile(path: string): Nullable<string>
  /** 写文本；父目录缺失时自行创建。实现应尽量做到「写完即完整」。 */
  writeTextFile(path: string, content: string): void
  /** 删文件；不存在时静默成功。 */
  deleteFile(path: string): void
  /**
   * `path` 解开符号链接之后是不是确实落在 `root` 之内（含 root 本身）。
   *
   * 后端在读写每一个条目之前问这一句：路径文本判定挡得住 `../`，挡不住条目目录里一个指向
   * `~/.aws/credentials` 的符号链接。缺席时后端只用文本判定（内存实现没有符号链接可解）。
   */
  isInsideDirectory?(path: string, root: string): boolean
}

/**
 * 嵌入端口 —— **BYOK 语义**：包内不认识任何 provider、不发一次网络请求、不读一个 API key。
 *
 * `identity` 进版本戳：换模型 = 索引作废 = 重建。因此它必须包含真正决定向量语义的一切
 * （provider + 模型 + 维度），而不只是一个模型名。
 */
export interface MemoryEmbedder {
  /** 嵌入模型身份，如 `openai:text-embedding-3-small:1536`。 */
  readonly identity: string
  /** 向量维度。 */
  readonly dimensions: number
  /** 批量嵌入。返回顺序必须与入参一一对应；长度不符视为实现故障。 */
  embed(texts: readonly string[]): Promise<ReadonlyArray<readonly number[]>>
}

/**
 * 向量索引的持久化端口。
 *
 * 同步接口是刻意的：检索要把全部向量拿在手里做暴力余弦，实现天然是「首次读盘后常驻内存 + 写穿」。
 * 异步签名只会让每个调用点多一个 `await` 而买不到任何东西。
 */
export interface MemoryVectorIndexStore {
  /** 落盘的版本戳；从没建过返回 null。 */
  readVersion(): Nullable<string>
  /** 写入版本戳（重建收尾时调）。 */
  writeVersion(version: string): void
  /** 全部记录（检索用）。 */
  list(): readonly MemoryVectorIndexRecord[]
  /** 按 id 覆盖写入若干条记录。 */
  upsert(records: readonly MemoryVectorIndexRecord[]): void
  /** 按 id 剔除若干条记录，返回实际剔除数。 */
  remove(ids: readonly string[]): number
  /** 清空派生数据（重建的第一步 / 卸载的全部）。 */
  clear(): void
}

/**
 * 空间端口：`velar:memory` 的四个操作在运行时能向空间要什么，写作 `ctx.memory`。全仓唯一权威。
 *
 * 空间拿它的记忆后端实现（与自动采集落在同一个后端上）；操作只经这一个口子读写记忆，不认识后端形态。
 * 端口里只有操作真会调的方法，门禁按操作文件核对。
 */
export interface MemorySpacePort {
  /** 当前记忆后端是谁、支持哪些动词。操作据此决定 availability 与要不要回 treeVersion，不做 `instanceof` 探测。 */
  describeBackend: () => MemoryBackendCapabilities
  /** 写入一条证据。 */
  captureEvidence: (
    input: MemoryEvidenceInput
  ) => Promise<MemoryCaptureResult> | MemoryCaptureResult
  /** 按查询召回当前作用域可见的记忆。 */
  recall: (
    query: string,
    options?: MemoryRecallOptions
  ) => Promise<MemoryRecallItem[]> | MemoryRecallItem[]
  /** 按 `recall` 返回的 id 读单条记忆。命名不带 Claim：树档之外没有 Claim 这个概念。 */
  getMemory: (
    memoryId: string
  ) => Promise<Nullable<MemoryRecallItem>> | Nullable<MemoryRecallItem>
  /** 读诊断读数；操作只用其中的 `treeVersion`，且只在后端有整理管线时读。 */
  getDiagnostics: (
  ) => Promise<MemoryTreeDiagnostics> | MemoryTreeDiagnostics
  /** 归档一条记忆：退出普通召回，内容不删（窄端口 `archive` 动词，后端可缺席）。 */
  archiveMemory: (
    memoryId: string
  ) => Promise<MemoryForgetResult> | MemoryForgetResult
}

/**
 * 每次调用拿到的上下文。空间每次分发 `velar:memory` 的调用时装好：作用域与会话是**这一次调用**的，不能缓存。
 */
export interface MemoryOperationContext {
  /** 本次调用的中止信号，每个操作第一步就检查它。 */
  abortSignal: AbortSignal
  /** 当前会话 id，写进证据的来源。 */
  sessionId: string
  /** 当前空间派生出的作用域 id；缺席表示宿主没有作用域概念。 */
  memoryScope?: LooseOptional<MemoryScopeId>
  /** 宿主归一好的会话谱系（分支与被排除的消息）。 */
  sessionLineage?: LooseOptional<MemorySessionLineageContext>
  /** 空间端口，全部读写都经它。 */
  memory: MemorySpacePort
}

/**
 * 解析后端所需的**最窄**注册表面。
 *
 * `KernelModuleHost` 结构上就满足它——适配器因此既不持有整个 host，也不需要为测试造一个假 host。
 */
export interface MemoryStoreCapabilityRegistry {
  /** 按能力令牌取服务；没注册返回 undefined（「没装就没有」，不抛）。 */
  getOptionalService<TService extends object>(
    token: CapabilityToken<TService>,
  ): TService | undefined
}

/** 注册进内核服务表的服务形状：一层薄包装，便于将来加后端级元数据。 */
export interface MemoryStoreCapabilityService {
  /** 这个令牌背后的记忆后端。 */
  readonly backend: MemoryStoreBackend
}

/** 把一个后端包成内核模块要什么。 */
export interface CreateMemoryStoreKernelModuleOptions {
  /** 要注册的后端。 */
  readonly backend: MemoryStoreBackend
  /** 模块 id；缺省 = 能力 id，保证同一后端档在两个注册表里同名可追。 */
  readonly moduleId?: string
  /** 模块版本；缺省取常量表的缺省版本。 */
  readonly moduleVersion?: string
  /** 能力令牌版本；缺省取常量表的缺省版本。 */
  readonly capabilityVersion?: string
  /** 内核模块 API 版本；缺省取内核当前版本。 */
  readonly apiVersion?: number
}

/** 解析权威层后端要什么。 */
export interface ResolveMemoryStoreBackendInput {
  /** 宿主的服务注册表。 */
  readonly registry: MemoryStoreCapabilityRegistry
  /** 后端 id 优先序；首个已注册且合格的胜出。 */
  readonly preference: readonly string[]
  /** 能力令牌版本；缺省取常量表的缺省版本。 */
  readonly capabilityVersion?: string
}

/**
 * 宿主空闲信号端口。
 *
 * 后台整理调度器判定「设备是否适合后台整理」需要三个宿主运行态读数：系统空闲时长、是否电池供电、
 * 是否有前台聚焦窗口。记忆适配器本体必须与宿主无关，因此这些读数经窄接口注入，具体平台实现留在
 * 产品宿主适配层。该端口无状态、无生命周期。
 */
export interface MemoryHostIdleSignalPort {
  /** 系统连续空闲秒数。读取失败由调用方兜底为 0。 */
  getIdleSeconds(): number
  /** 设备当前是否电池供电。 */
  isOnBatteryPower(): boolean
  /** 产品宿主是否存在聚焦的前台界面。 */
  isAppFocused(): boolean
}

/** 宿主把自己的上下文映射到记忆作用域的解析器：这条接缝上只有宿主知道「当前是哪个空间」。 */
export type MemoryHostScopeResolver = (input: MemoryHostScopeInput) => MemoryHostScope

/**
 * 记忆采集/召回/整理的宿主配置读数端口。
 *
 * 三个策略服务原先各自在 Composition 内联接线宿主配置；组装入口把这些读数收成单一端口，
 * 由 mount 内部分派到各服务需要的选项形状——kernel 侧只声明「记忆要读哪些开关」，不知道
 * 记忆内部把它们喂给了 capture 还是 dream。
 */
export interface MemoryAdapterConfigPort {
  /** 自动记忆总开关（采集 + 召回 + 整理的顶层门）。 */
  isEnabled: () => boolean
  /** 后台生长开关（即时整理与空闲整理的门）。 */
  isBackgroundGrowthEnabled: () => boolean
  /** 是否允许电池供电下也跑积压整理。 */
  allowBatteryGrowth: () => boolean
  /** 普通召回无果时是否自动降级深层召回。 */
  isAutomaticDeepRecallEnabled: () => boolean
  /** 聊天消息采集开关。 */
  isChatCaptureEnabled: () => boolean
  /** 工作区工具观测采集开关。 */
  isWorkspaceCaptureEnabled: () => boolean
  /** Computer Use 观测采集开关。 */
  isComputerUseCaptureEnabled: () => boolean
  /** 执行生命周期采集开关。 */
  isExecutionCaptureEnabled: () => boolean
  /** 单条会话的采集豁免；缺席 = 不豁免（与四个类别开关并列求合取）。 */
  isSessionCaptureAllowed?: (sessionId: string) => boolean
  /** 单条会话的召回豁免；缺席 = 不豁免。 */
  isSessionRecallAllowed?: (sessionId: string) => boolean
}

/** 宿主把自己的产品上下文映射到记忆作用域的那一格读数。 */
export interface MemoryAdapterHostContextPort {
  /** 上下文 → 作用域的解析器。 */
  resolveScope: MemoryHostScopeResolver
  /** 回合上下文注入允许出现在哪些空间。 */
  turnContextScopes: readonly string[]
  /** 环境上下文块的起始标签；用于把环境块从证据正文里剔掉。 */
  environmentContextBlockOpenTag?: string
}

/**
 * 后端解析端口（kernel-contract §15.7 裁决二）。
 *
 * 宿主把进程内 `KernelModuleHost`（结构上满足 `MemoryStoreCapabilityRegistry`）与后端优先序
 * 递进来，适配器经 `velaros.memory.store.<id>` token 解析出该用哪个后端。
 * 显式提供 tree 时，未解析到后端会使用该树；独立后端宿主缺少权威层则明确拒绝装配。
 */
export interface MemoryAdapterStorePort {
  /** 宿主的服务注册表。 */
  readonly registry: MemoryStoreCapabilityRegistry
  /** 后端 id 优先序，首个已注册的胜出（如 `['files', 'tree']`）。 */
  readonly preference: readonly string[]
  /** 能力令牌版本；缺省取常量表的缺省版本。 */
  readonly capabilityVersion?: string
}

/** 树档的生命周期是宿主的显式选择，与选中的权威层后端无关。 */
export interface MemoryAdapterTreePort {
  /** 宿主已打开的记忆树领域服务。 */
  domain: MemoryTreeDomainApi
  /** 空闲/电池/前台读数端口，后台整理调度器用。 */
  idleSignal: MemoryHostIdleSignalPort
}

/** 装配一次记忆适配器要什么。 */
export interface MemoryAdapterMountInput {
  /** 已完成权威层/派生索引装配的后端，与 store 解析端口互斥。 */
  backend?: MemoryStoreBackend
  /** 树治理的显式接入；缺席时不创建预热 / 整理 / 空闲信号生命周期。 */
  tree?: MemoryAdapterTreePort
  /** 宿主配置读数端口。 */
  config: MemoryAdapterConfigPort
  /** 宿主上下文端口。 */
  hostContext: MemoryAdapterHostContextPort
  /** 经能力令牌解析后端；未选中时仅允许回落显式提供的 tree。 */
  store?: MemoryAdapterStorePort
}

/** 装配入参的历史名字；等同 {@link MemoryAdapterMountInput}。 */
export type MountMemoryAdapterInput = MemoryAdapterMountInput

/**
 * 树后端实际消费的领域方法集合。
 *
 * 刻意用 `Pick` 而不是整个树领域服务：窄端口只应该够着自己要转发的动词，预热 / 树版本 /
 * 完整性校验属于树档自己的治理面，仍由树治理门面直接持有。
 */
export type MemoryTreeStoreDomain = Pick<
  MemoryTreeDomainApi,
  | 'captureEvidence'
  | 'captureEvidenceBatch'
  | 'recall'
  | 'getClaim'
  | 'getDiagnostics'
  | 'forgetClaim'
  | 'runDream'
  | 'setEvidenceEligibility'
  | 'setSessionEvidenceEligibility'
>
