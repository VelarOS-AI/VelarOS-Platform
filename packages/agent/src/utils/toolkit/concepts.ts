import type { ToolConceptRegistry } from '../../types/toolkit.js'

const GlobalToolConcepts = {
  boundedRead: '读取必须有界：提供范围、字节数、字符数上限，或显式选择无界读取。',
  pathSafety: '路径必须在已授权的资源根或宿主允许的文件系统边界内。',
  approvalRequired: '高风险或有副作用操作必须经过运行时审批策略。',
  destructiveAction: '删除、覆盖、执行命令或控制输入前必须确认作用范围。',
  artifactOutput: '产物应返回可追踪路径、格式和生成状态。',
  pagination: '列表型结果必须提供数量上限或分页参数。',
  schemaBoundExamples: '示例必须是可被工具 schema 解析的参数对象。',
} as const

/**
 * 登记一张工具概念表（概念 id → 写给模型看的中文约束句）。运行期原样返回入参，唯一作用是让 TS
 * 推出字面量 key 类型，这样后续 `createToolConceptLookup` 取值时写错概念名会在编译期就报错。
 */
function defineToolConcepts<TConcepts extends ToolConceptRegistry>(concepts: TConcepts): TConcepts {
  return concepts
}

/**
 * 基于一张概念表造一个取值函数：传概念 id 返回那句约束文案，id 必须是表里已登记的 key，
 * 拿不到就是编译期错误而不是运行期 undefined。工具描述拼装时用它把共用约束引进去。
 */
function createToolConceptLookup<TConcepts extends ToolConceptRegistry>(concepts: TConcepts) {
  return <TId extends keyof TConcepts & string>(id: TId): TConcepts[TId] => concepts[id]
}

const globalToolConcept = createToolConceptLookup(GlobalToolConcepts)

export {
  createToolConceptLookup,
  defineToolConcepts,
  globalToolConcept,
  GlobalToolConcepts,
}
