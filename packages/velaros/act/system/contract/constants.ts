/** 会话目标能力身份。 */
export const GoalModuleId = 'velaros:system-goal' as const
/** 可写已有对象、不能创建空间的合同投影。 */
export const StoreWriteModuleId = 'velaros:system-store-write' as const
/** 共享状态的写入合同身份。 */
export const StoreModuleId = 'velaros:system-store' as const
/** 对象只读、订阅可维护的同一状态成员投影。 */
export const StoreReadModuleId = 'velaros:system-store-read' as const
/** 主线可委托整理的工作记忆能力身份。 */
export const MemoryModuleId = 'velaros:system-memory' as const
/** 单一职责工具的本地记忆能力身份，与主线共用实现。 */
export const LocalMemoryModuleId = 'velaros:system-memory-local' as const
/** 主线装配长期记忆时的合同身份，工作记忆仍使用同一实现。 */
export const PersistentMemoryModuleId = 'velaros:system-memory-persistent' as const
/** 装配了长期记忆、却没有整理模型时的合同身份：少了 organize。 */
export const PersistentLocalMemoryModuleId = 'velaros:system-memory-persistent-local' as const
/** 带长期记忆（recall/save/remove）的两种合同身份。 */
export const LongTermMemoryModuleIds: readonly string[] = Object.freeze([
  PersistentMemoryModuleId,
  PersistentLocalMemoryModuleId,
])
/** 能力发现身份。 */
export const ModulesModuleId = 'velaros:modules' as const
/** 整理会话的固定快照只读能力。 */
export const ContextMaterialsModuleId = 'velaros:context-materials' as const
/** 工作笔记与材料目录对外承诺的上限：memory 成员声明里写的就是这些数（两边一致由验收核对）。 */
export const WorkspaceLimits = Object.freeze({
  /** 每份笔记的最大来源数。 */
  sources: 64,
  /** 笔记 key 最多多少字符。 */
  keyChars: 96,
  /** 笔记标题最多多少字符。 */
  titleChars: 200,
  /** 笔记正文最多多少字符。 */
  bodyChars: 60_000,
  /** 笔记与材料目录一页最多多少项。 */
  maxPage: 64,
})
/** 会话目标对外承诺的上限：goal 成员声明里写的就是这些数（两边一致由验收核对）。 */
export const GoalLimits = Object.freeze({
  /** 目标描述最多多少字符。 */
  objectiveChars: 8000,
  /** 状态变化的依据最多多少字符。 */
  reasonChars: 4000,
})
/** 安排整理的上限：memory.organize 声明里写的就是这些数（两边一致由验收核对）。 */
export const OrganizeLimits = Object.freeze({
  /** focus 最多多少字符。 */
  focusChars: 3000,
  /** 最多保留多少条原文引用。 */
  preserve: 64,
})
/** 整理补丁的上限：velaros:context-materials 的 submit 声明里写的就是这些数（两边一致由验收核对）。 */
export const ContextPatchLimits = Object.freeze({
  /** 整理说明最多多少字符。 */
  summaryChars: 3000,
  /** 未解决事项最多多少条。 */
  unresolved: 32,
  /** 每条未解决事项最多多少字符。 */
  unresolvedChars: 1000,
  /** notes、inputs、releaseResults、releaseStoreRefs 与观察摘要各最多多少项。 */
  items: 64,
  /** 整份补丁的 JSON 最多多少字符。 */
  patchChars: 60_000,
  /** 一段展示摘要（观察块或笔记）最多多少字符。 */
  textChars: 12_000,
  /** 近期记录窗口最大多少条。 */
  recentRecords: 64,
})
/** 执行结果可见租约。 */
export const ScriptLeaseLimits = Object.freeze({
  /** 默认成功业务回合数。 */
  defaultTurns: 2,
  /** 有限续租回合上限。 */
  maxTurns: 32,
  /** 默认结果展示字符数。 */
  resultChars: 12_000,
})
/** 自管理能力的挂载代际；合同版本由各自生成的模型面给出。 */
export const SystemContract = Object.freeze({
  /** 实例代次。 */
  generation: 1,
})
/** 模型导入自管理能力用的系统包名。 */
export const SystemPackageSpecifier = 'velaros:system' as const
/**
 * velaros:system 的成员，以及每个成员可能挂的模块身份。同一会话里一个成员只挂一个：按装配与会话授权取表里第一个可用的。
 * 这些身份都不作为业务能力单独列出。
 */
export const SystemMembers: Readonly<
  Record<'modules' | 'goal' | 'memory' | 'store', readonly string[]>
> = Object.freeze({
  modules: Object.freeze([ModulesModuleId]),
  goal: Object.freeze([GoalModuleId]),
  memory: Object.freeze([
    PersistentMemoryModuleId,
    PersistentLocalMemoryModuleId,
    MemoryModuleId,
    LocalMemoryModuleId,
  ]),
  store: Object.freeze([StoreModuleId, StoreWriteModuleId, StoreReadModuleId]),
})
/** 系统能力目录的分页约定。 */
export const SystemCatalogLimits = Object.freeze({
  /** 默认目录页大小。 */
  page: 20,
  /** 目录单页上限。 */
  maxPage: 64,
})

/** 长期记忆召回的返回条数，完整原文继续由原存储提供。 */
export const MemoryRecallLimits = Object.freeze({
  /** 默认一页条数。 */
  page: 8,
  /** 单页最多条数。 */
  maxPage: 32,
})

/** 每帧只附带少量空间目录，完整目录由模型按需分页。 */
export const StoreProjectionLimits = Object.freeze({
  /** 材料默认分页字符数。 */
  materialChars: 8000,
  /** 材料单页字符硬上限。 */
  maxMaterialChars: 32000,
  /** 自动目录页的最大空间数。 */
  directory: 4,
  /** 稳定引用的默认字符预算；真实请求可分配更小额度。 */
  activeChars: 8000,
  /** 稳定引用中用途说明的字符上限。 */
  descriptionChars: 160,
})
