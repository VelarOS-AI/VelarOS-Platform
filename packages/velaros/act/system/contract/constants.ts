/** 会话目标能力身份。 */
export const GoalModuleId='velaros:system-goal' as const
/** 可写已有对象、不能创建空间的合同投影。 */
export const StoreWriteModuleId='velaros:system-store-write' as const
/** 共享状态的写入合同身份。 */
export const StoreModuleId='velaros:system-store' as const
/** 对象只读、订阅可维护的同一状态成员投影。 */
export const StoreReadModuleId='velaros:system-store-read' as const
/** 主线可委托整理的工作记忆能力身份。 */
export const MemoryModuleId='velaros:system-memory' as const
/** 单一职责工具的本地记忆能力身份，与主线共用实现。 */
export const LocalMemoryModuleId='velaros:system-memory-local' as const
/** 主线装配长期记忆时的合同身份，工作记忆仍使用同一实现。 */
export const PersistentMemoryModuleId='velaros:system-memory-persistent' as const
/** 能力发现身份。 */
export const ModulesModuleId='velaros:modules' as const
/** 整理会话的固定快照只读能力。 */
export const ContextMaterialsModuleId='velaros:context-materials' as const
/** 笔记来源数量上限。 */
export const WorkspaceLimits=Object.freeze({
 /** 每份笔记的最大来源数。 */
 sources:64
})
/** 执行结果可见租约。 */
export const ScriptLeaseLimits=Object.freeze({
 /** 默认成功业务回合数。 */
 defaultTurns:2,
 /** 有限续租回合上限。 */
 maxTurns:32,
 /** 默认结果展示字符数。 */
 resultChars:12_000
})
/** 自管理操作合同代际。 */
export const SystemContract=Object.freeze({
 /** 对外合同版本。 */
 schemaRevision:'21',
 /** 实例代次。 */
 generation:1
})
/** 主线和业务子任务的规范系统包。 */
export const SystemPackage=Object.freeze({specifier:'velaros:system',exports:Object.freeze({modules:ModulesModuleId,goal:GoalModuleId,memory:MemoryModuleId,store:StoreModuleId})})
/** 没有整理委托能力时的同一系统包投影。 */
export const LocalSystemPackage=Object.freeze({specifier:'velaros:system',exports:Object.freeze({modules:ModulesModuleId,goal:GoalModuleId,memory:LocalMemoryModuleId,store:StoreModuleId})})
/** 主线接入宿主长期记忆作用域后的系统包。 */
export const PersistentSystemPackage=Object.freeze({specifier:'velaros:system',exports:Object.freeze({modules:ModulesModuleId,goal:GoalModuleId,memory:PersistentMemoryModuleId,store:StoreModuleId})})
/** 系统能力目录的分页约定。 */
export const SystemCatalogLimits=Object.freeze({
 /** 默认目录页大小。 */
 page:20,
 /** 目录单页上限。 */
 maxPage:64
})

/** 长期记忆召回的返回条数，完整原文继续由原存储提供。 */
export const MemoryRecallLimits=Object.freeze({
 /** 默认一页条数。 */
 page:8,
 /** 单页最多条数。 */
 maxPage:32
})

/** 每帧只附带少量空间目录，完整目录由模型按需分页。 */
export const StoreProjectionLimits=Object.freeze({
 /** 材料默认分页字符数。 */
 materialChars:8000,
 /** 材料单页字符硬上限。 */
 maxMaterialChars:32000,
 /** 自动目录页的最大空间数。 */
 directory:4,
 /** 稳定引用的默认字符预算；真实请求可分配更小额度。 */
 activeChars:8000,
 /** 稳定引用中用途说明的字符上限。 */
 descriptionChars:160
})
