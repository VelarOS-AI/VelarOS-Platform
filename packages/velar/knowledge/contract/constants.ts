/**
 * 约定的常量表（对外合同的一部分）：知识来源类型与写进声明给模型看的上限。
 * 上限是模型在声明里看到的数字（两边一致由验收核对），操作按它们核对入参；不 import 任何东西、不用 Node 专属类型，
 * 整个文件随 `./knowledge/contracts` 入口出单元。
 */

/** 知识来源类型的取值表：search 的 sourceKinds 按它核对，声明里的 KnowledgeSourceKind 与它一致。 */
export const KnowledgeSourceKinds = Object.freeze(['markdown', 'text', 'json', 'config', 'code'] as const)

/** search 入参的对外上限。 */
export const KnowledgeSearchLimits = Object.freeze({
  /** 没给 limit 时要几条命中。 */
  defaultResults: 8,
  /** 一次最多要几条命中：知识库引擎一次最多排这么多，再多是误用。 */
  results: 50,
  /** 一次最多几条路径提示。 */
  pathHints: 20,
  /** 一次最多几条符号提示。 */
  symbolHints: 20,
  /** 一次最多把范围限定在几个文档上。 */
  documentIds: 100,
} as const)
