type ToolConceptRegistry = Record<string, string>

const GlobalToolConcepts = {
  boundedRead: '读取必须有界：提供范围、字节数、字符数上限，或显式选择无界读取。',
  pathSafety: '路径必须在已授权的工作区或宿主允许的文件系统边界内。',
  approvalRequired: '高风险或有副作用操作必须经过运行时审批策略。',
  destructiveAction: '删除、覆盖、执行命令或控制输入前必须确认作用范围。',
  artifactOutput: '产物应返回可追踪路径、格式和生成状态。',
  pagination: '列表型结果必须提供数量上限或分页参数。',
  schemaBoundExamples: '示例必须是可被工具 schema 解析的参数对象。',
} as const

function defineToolConcepts<TConcepts extends ToolConceptRegistry>(concepts: TConcepts): TConcepts {
  return concepts
}

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
export type { ToolConceptRegistry }
