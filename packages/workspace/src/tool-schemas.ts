/**
 * 工作区工具的 schema 单一事实来源。
 *
 * 这里集中定义面向模型的编辑、后置条件、批处理与目标定位 schema。
 * 之所以放在普通模块而非工具定义文件：普通模块可以对外导出，供消费端
 * （例如桌面端主进程工具层）直接复用，避免两份 schema 漂移；工具定义文件
 * 受架构门禁约束，只能在末尾做单一聚合导出，无法承担被外部引用的 schema 库职责。
 *
 * 描述文本统一面向模型阅读，使用中文。
 */
import { z } from 'zod'

import { isArray, isEmpty,isNonBlankString, isNumber, isString } from '@velaros-ai/core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { WorkspaceKernelToolNames as wsTool } from './workspace-tool-names.js'

export const rangeSchema = z.object({
  startLine: z.number().optional().describe(
    parameterDescription({
      description: '窗口起始行，按 1-based 行号计算。',
    })
  ),
  endLine: z.number().optional().describe(
    parameterDescription({
      description: '窗口结束行，按 1-based 行号计算。',
    })
  ),
  startColumn: z.number().optional().describe(
    parameterDescription({
      description: '起始行上的 1-based UTF-16 列号。',
    })
  ),
  endColumn: z.number().optional().describe(
    parameterDescription({
      description: '结束行上的 1-based UTF-16 列号。',
    })
  ),
  startOffset: z.number().optional().describe(
    parameterDescription({
      description: '窗口起始的字符串 offset。',
    })
  ),
  endOffset: z.number().optional().describe(
    parameterDescription({
      description: '窗口结束的字符串 offset。',
    })
  ),
})
export const trustSourceSchema = z.enum(['system', 'user', 'workspace', 'tool', 'external']).describe(
  parameterDescription({
    description: '内容来源类别。',
  })
)
export const trustLevelSchema = z.enum(['trusted', 'untrusted']).describe(
  parameterDescription({
    description: '内容是否按不可信项目文本处理。',
  })
)
/** 与 types/common.TrustLabel 对齐；供 read/resolve 等工具输入复用。 */
export const trustLabelSchema = z.strictObject({
  source: trustSourceSchema,
  trust: trustLevelSchema,
}).describe(
  parameterDescription({
    description: '调用方传入的信任上下文标签。',
  })
)
export const editConstraintsSchema = z.object({
  maxChangedLines: z.number().optional().describe(
    parameterDescription({
      description: '单个编辑 intent 的变更行数约束提示；默认 core 只执行事务级上限，插件可选择更细粒度执行。',
    })
  ),
  allowFullFileRewrite: z.boolean().optional().describe(
    parameterDescription({
      description: '是否允许整文件级重写的约束提示；默认 core 依赖策略和具体 patch 策略处理。',
    })
  ),
  expectedMatches: z.number().optional().describe(
    parameterDescription({
      description: '锚点或目标片段期望匹配的次数。',
    })
  ),
  onlyModifyTarget: z.boolean().optional().describe(
    parameterDescription({
      description: '是否限制补丁只修改已解析目标范围的约束提示；默认 core 不单独执行该字段。',
    })
  ),
}).describe(
  parameterDescription({
    description: '单个编辑 intent 的约束。',
  })
)
export const readRangeSchema = z.strictObject({
  startLine: z.number().int().positive().optional().describe(
    parameterDescription({
      description: '窗口起始行，按 1-based 行号计算。',
    })
  ),
  endLine: z.number().int().positive().optional().describe(
    parameterDescription({
      description: '窗口结束行，按 1-based 行号计算。',
    })
  ),
}).describe(
  parameterDescription({
    description: '有界行窗口；read 只接受行号窗口。',
  })
)
export const operationRequiredPathSchema = z.string().describe(
  parameterDescription({
    description: '工作区相对文件路径。',
  })
)
export const operationOptionalPathSchema = z.string().optional().describe(
  parameterDescription({
    description: '工作区相对文件路径；未提供 targetId 时通常必填。',
  })
)
export const workspacePathItemSchema = z.string().describe(
  parameterDescription({
    description: '单个工作区相对路径。',
  })
)
function looksLikeJsonEncodedArrayString(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']')
}
const workspaceReadPathItemSchema = workspacePathItemSchema.refine(
  (value) => !looksLikeJsonEncodedArrayString(value),
  { message: '多个 path 请直接传数组，不要传 JSON 字符串数组。' }
)
export const globPatternItemSchema = z.string().describe(
  parameterDescription({
    description: '单个 glob 匹配模式。',
  })
)
export const textAnchorRequirementSchema = z.string().describe(
  parameterDescription({
    description: '匹配窗口内必须出现的文本片段。',
  })
)
export const importNamedBindingSchema = z.string().describe(
  parameterDescription({
    description: '单个 named import 名称。',
  })
)
export const validationCheckIdSchema = z.string().describe(
  parameterDescription({
    description: '单个 workspace 校验器 id。',
  })
)
// prepare/amend/commit 共用同一份 evidenceId 字段说明（单一事实来源，避免三处内联同文案漂移）。
// 注意用工厂返回「全新 schema 实例」：若复用同一对象引用，z.toJSONSchema 会把它抽成 $ref/$defs，
// 改变 bundle 结构与体积；这里每次调用生成独立实例，输出与原内联写法逐字一致。
export const evidenceIdParam = () =>
  z.string().optional().describe(
    parameterDescription({
      description: 'evidence 构建阶段返回的 evidence id；默认 core 仅透传给输入流水线。',
    })
  )
// prepare/commit 共用同一份 baseRevision 防护字段说明。
export const baseRevisionGuardParam = () =>
  z.string().optional().describe(
    parameterDescription({
      description: '没有 targetId 自带 revision 时使用的 revision 防护。',
    })
  )
export const taskConstraintItemSchema = z.string().describe(
  parameterDescription({
    description: '单条用户限制条件。',
  })
)
export const taskSuccessCriterionItemSchema = z.string().describe(
  parameterDescription({
    description: '单条任务完成标准。',
  })
)
export const batchDependencyIdSchema = z.string().describe(
  parameterDescription({
    description: '当前批处理任务依赖的任务 id。',
  })
)
export const sheetNameItemSchema = z.string().describe(
  parameterDescription({
    description: '单个工作表名称。',
  })
)
export const cellRangeItemSchema = z.string().describe(
  parameterDescription({
    description: '单个单元格范围，例如 A1:C10。',
  })
)
export const changedLineLimitNumberSchema = z.number().describe(
  parameterDescription({
    description: '允许修改的最大行数。',
  })
)
export const changedLineLimitStringSchema = z.string().describe(
  parameterDescription({
    description: '可解析为数字的最大行数。',
  })
)
export const symbolSelectorSchema = z.object({
  kind: z.string().optional().describe(
    parameterDescription({
      description: '符号类型，例如 function、class、method；省略时只按名称匹配。',
    })
  ),
  name: z.string().describe(
    parameterDescription({
      description: '符号名称。',
    })
  ),
  container: z.string().optional().describe(
    parameterDescription({
      description: '符号所在容器名称，用于区分同名成员。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JS/TS 符号选择器；优先使用已解析 targetId，只有无法提前解析 target 时再传 symbol。',
  })
)
export const targetHintSchema = z.object({
  symbol: symbolSelectorSchema.optional(),
  exactSnippet: z.string().optional().describe(
    parameterDescription({
      description: '要定位的精确文本片段；应能在文件内唯一匹配。',
    })
  ),
  anchors: z.object({
    before: z.string().optional().describe(
      parameterDescription({
        description: '目标之前的文本锚点。',
      })
    ),
    after: z.string().optional().describe(
      parameterDescription({
        description: '目标之后的文本锚点。',
      })
    ),
    mustContain: z.array(textAnchorRequirementSchema).optional().describe(
      parameterDescription({
        description: '匹配窗口内必须包含的文本片段。',
      })
    ),
  }).optional().describe(
    parameterDescription({
      description: '没有符号信息时用文本锚点定位范围。',
    })
  ),
  lineHint: z.object({
    startLine: z.number().int().positive().describe(
      parameterDescription({
        description: '起始行（1-based）。',
      })
    ),
    endLine: z.number().int().positive().describe(
      parameterDescription({
        description: '结束行（1-based）。',
      })
    ),
  }).optional().describe(
    parameterDescription({
      description: '已知大致行范围时的行号提示。',
    })
  ),
}).describe(
  parameterDescription({
    description: '目标定位提示；按需提供 symbol、exactSnippet、anchors、lineHint 中的一个或多个。',
    usage: ['JS/TS 优先用 symbol 或 exactSnippet；无法符号定位时用 anchors 或 lineHint。'],
  })
)
export const insertPositionSchema = z.enum(['before', 'after']).describe(
  parameterDescription({
    description: '插入位置：before 表示目标之前，after 表示目标之后。',
  })
)
export const jsonPatchItemSchema = z.object({
  op: z.enum(['add', 'remove', 'replace']).describe(
    parameterDescription({
      description: 'JSON patch 操作。',
    })
  ),
  path: z.string().describe(
    parameterDescription({
      description: 'JSON Pointer 路径，例如 /enabled 或 /items/0/name。',
    })
  ),
  value: z.unknown().optional().describe(
    parameterDescription({
      description: 'add 或 replace 写入的值；remove 时通常省略。',
    })
  ),
}).describe(
  parameterDescription({
    description: '单条 JSON patch。',
  })
)
export const replaceTextOperationSchema = z.looseObject({
  type: z.literal('replace_text').describe(
    parameterDescription({
      description: '替换文本。',
    })
  ),
  path: operationOptionalPathSchema,
  oldText: z.string().optional().describe(
    parameterDescription({
      description: '要替换的精确旧文本；除非 constraints.expectedMatches 另有指定，否则应唯一匹配。',
      notes: ['省略 oldText 时必须通过 targetId 提供目标范围。'],
    })
  ),
  newText: z.string().describe(
    parameterDescription({
      description: '替换后的新文本。',
    })
  ),
  anchors: z.object({
    before: z.string().optional().describe(
      parameterDescription({
        description: '辅助定位的前置锚点。',
      })
    ),
    after: z.string().optional().describe(
      parameterDescription({
        description: '辅助定位的后置锚点。',
      })
    ),
    mustContain: z.array(textAnchorRequirementSchema).optional().describe(
      parameterDescription({
        description: '匹配窗口内必须包含的文本片段。',
      })
    ),
  }).optional().describe(
    parameterDescription({
      description: '辅助定位锚点。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文本替换操作结构。',
  })
)
export const insertTextOperationSchema = z.looseObject({
  type: z.literal('insert_text').describe(
    parameterDescription({
      description: '在已解析目标范围前后插入文本。',
    })
  ),
  path: operationOptionalPathSchema,
  position: insertPositionSchema,
  text: z.string().describe(
    parameterDescription({
      description: '要插入的文本。',
    })
  ),
}).describe(
  parameterDescription({
    description: '基于已解析目标范围的插入操作结构；通常配合 targetId 使用。',
  })
)
export const insertTextAtAnchorOperationSchema = z.looseObject({
  type: z.literal('insert_text_at_anchor').describe(
    parameterDescription({
      description: '按字面量锚点插入文本。',
    })
  ),
  path: operationRequiredPathSchema,
  anchorText: z.string().describe(
    parameterDescription({
      description: '用于定位插入点的字面量文本锚点。',
    })
  ),
  position: insertPositionSchema,
  text: z.string().describe(
    parameterDescription({
      description: '要插入的文本。',
    })
  ),
  expectedMatches: z.number().optional().describe(
    parameterDescription({
      description: 'anchorText 期望匹配次数，默认 1。',
    })
  ),
  skipIfAlreadyPresent: z.boolean().optional().describe(
    parameterDescription({
      description: '若文件已包含 text，是否跳过插入并生成 no-op 补丁。',
    })
  ),
}).describe(
  parameterDescription({
    description: '基于字面量锚点的插入操作结构。',
  })
)
export const appendTextOperationSchema = z.looseObject({
  type: z.literal('append_text').describe(
    parameterDescription({
      description: '追加文本到文件末尾。',
    })
  ),
  path: operationRequiredPathSchema,
  text: z.string().describe(
    parameterDescription({
      description: '要追加的文本。',
    })
  ),
  skipIfAlreadyPresent: z.boolean().optional().describe(
    parameterDescription({
      description: '若文件已包含 text，是否跳过追加并生成 no-op 补丁。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文件末尾追加操作结构。',
  })
)
export const prependTextOperationSchema = z.looseObject({
  type: z.literal('prepend_text').describe(
    parameterDescription({
      description: '插入文本到文件开头。',
    })
  ),
  path: operationRequiredPathSchema,
  text: z.string().describe(
    parameterDescription({
      description: '要插入到文件开头的文本。',
    })
  ),
  skipIfAlreadyPresent: z.boolean().optional().describe(
    parameterDescription({
      description: '若文件已包含 text，是否跳过插入并生成 no-op 补丁。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文件开头插入操作结构。',
  })
)
export const deleteTextOperationSchema = z.looseObject({
  type: z.literal('delete_text').describe(
    parameterDescription({
      description: '删除文本。',
    })
  ),
  path: operationOptionalPathSchema,
  oldText: z.string().optional().describe(
    parameterDescription({
      description: '要删除的精确旧文本；省略时必须通过 targetId 提供目标范围。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文本删除操作结构。',
  })
)
export const createFileOperationSchema = z.looseObject({
  type: z.literal('create_file').describe(
    parameterDescription({
      description: '创建文件。',
    })
  ),
  path: operationRequiredPathSchema,
  content: z.string().describe(
    parameterDescription({
      description: '新文件内容。',
    })
  ),
  overwrite: z.boolean().optional().describe(
    parameterDescription({
      description: '目标文件已存在时是否允许覆盖。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文件创建操作结构。',
  })
)
export const deleteFileOperationSchema = z.looseObject({
  type: z.literal('delete_file').describe(
    parameterDescription({
      description: '删除文件。',
    })
  ),
  path: operationRequiredPathSchema,
}).describe(
  parameterDescription({
    description: '文件删除操作结构。',
  })
)
export const renameFileOperationSchema = z.looseObject({
  type: z.literal('rename_file').describe(
    parameterDescription({
      description: '重命名文件。',
    })
  ),
  from: operationRequiredPathSchema.describe(
    parameterDescription({
      description: '原工作区相对路径。',
    })
  ),
  to: operationRequiredPathSchema.describe(
    parameterDescription({
      description: '新工作区相对路径。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文件重命名操作结构。',
  })
)
export const replaceSymbolOperationSchema = z.looseObject({
  type: z.literal('replace_symbol').describe(
    parameterDescription({
      description: '替换 JS/TS 符号。',
    })
  ),
  path: operationOptionalPathSchema,
  symbol: symbolSelectorSchema.optional(),
  replacement: z.string().describe(
    parameterDescription({
      description: '替换后的符号文本；mode 为 body 时表示新的函数体内容。',
    })
  ),
  mode: z.enum(['whole', 'body']).optional().describe(
    parameterDescription({
      description: '替换范围：whole 替换整个符号，body 只替换函数或方法体。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JS/TS 符号替换操作结构；优先配合已解析 targetId 使用。',
  })
)
export const insertAroundSymbolOperationSchema = z.looseObject({
  type: z.literal('insert_around_symbol').describe(
    parameterDescription({
      description: '在 JS/TS 符号前后插入文本。',
    })
  ),
  path: operationOptionalPathSchema,
  symbol: symbolSelectorSchema.optional(),
  position: insertPositionSchema,
  text: z.string().describe(
    parameterDescription({
      description: '要插入的文本。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JS/TS 符号相邻插入操作结构；优先配合已解析 targetId 使用。',
  })
)
export const insertBeforeSymbolOperationSchema = z.looseObject({
  type: z.literal('insert_before_symbol').describe(
    parameterDescription({
      description: '在已解析 JS/TS 符号前插入文本。',
    })
  ),
  path: operationOptionalPathSchema,
  symbol: symbolSelectorSchema.optional(),
  text: z.string().describe(
    parameterDescription({
      description: '要插入的文本。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JS/TS 符号前置插入操作结构；需要 targetId 或可唯一解析的 symbol。',
  })
)
export const insertAfterSymbolOperationSchema = z.looseObject({
  type: z.literal('insert_after_symbol').describe(
    parameterDescription({
      description: '在已解析 JS/TS 符号后插入文本。',
    })
  ),
  path: operationOptionalPathSchema,
  symbol: symbolSelectorSchema.optional(),
  text: z.string().describe(
    parameterDescription({
      description: '要插入的文本。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JS/TS 符号后置插入操作结构；需要 targetId 或可唯一解析的 symbol。',
  })
)
export const addImportOperationSchema = z.looseObject({
  type: z.literal('add_import').describe(
    parameterDescription({
      description: '添加或合并 JS/TS import。',
    })
  ),
  path: operationOptionalPathSchema,
  importStatement: z.string().optional().describe(
    parameterDescription({
      description: '完整 import 语句；提供后优先使用。',
    })
  ),
  module: z.string().optional().describe(
    parameterDescription({
      description: '模块 specifier，例如 react 或 ./foo。',
    })
  ),
  named: z.array(importNamedBindingSchema).optional().describe(
    parameterDescription({
      description: 'named imports 列表。',
    })
  ),
  defaultImport: z.string().optional().describe(
    parameterDescription({
      description: '默认导入名称。',
    })
  ),
  namespaceImport: z.string().optional().describe(
    parameterDescription({
      description: 'namespace import 名称。',
    })
  ),
  sideEffectOnly: z.boolean().optional().describe(
    parameterDescription({
      description: '是否生成仅副作用 import。',
    })
  ),
  dedupe: z.boolean().optional().describe(
    parameterDescription({
      description: '是否跳过已存在的同语句 import，默认会去重。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JS/TS import 添加或合并操作结构；使用 importStatement，或使用 module 搭配 named/defaultImport/namespaceImport/sideEffectOnly。',
  })
)
export const removeImportOperationSchema = z.looseObject({
  type: z.literal('remove_import').describe(
    parameterDescription({
      description: '移除 JS/TS import。',
    })
  ),
  path: operationOptionalPathSchema,
  importStatement: z.string().optional().describe(
    parameterDescription({
      description: '要移除的完整 import 语句。',
    })
  ),
  moduleSpecifier: z.string().optional().describe(
    parameterDescription({
      description: '要移除的 import 模块 specifier。',
    })
  ),
  module: z.string().optional().describe(
    parameterDescription({
      description: 'moduleSpecifier 的别名。',
    })
  ),
  name: z.string().optional().describe(
    parameterDescription({
      description: '只移除某个 named import；省略时移除匹配的整条 import。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JS/TS import 移除操作结构。',
  })
)
export const jsonPatchOperationSchema = z.looseObject({
  type: z.literal('json_patch').describe(
    parameterDescription({
      description: '修改 JSON 文件。',
    })
  ),
  path: operationOptionalPathSchema,
  patches: z.array(jsonPatchItemSchema).describe(
    parameterDescription({
      description: '要按顺序应用的 JSON patch 列表。',
    })
  ),
}).describe(
  parameterDescription({
    description: 'JSON 修改操作结构。',
  })
)
export const customEditOperationSchema = z.looseObject({
  type: z.literal('custom').describe(
    parameterDescription({
      description: '交给自定义编辑策略处理。',
    })
  ),
  adapterId: z.string().optional().describe(
    parameterDescription({
      description: '目标自定义 adapter 或策略 id。',
    })
  ),
  payload: z.unknown().describe(
    parameterDescription({
      description: '自定义编辑策略定义的载荷。',
    })
  ),
}).describe(
  parameterDescription({
    description: '自定义编辑操作结构。',
  })
)
/** 编辑操作判别联合（单一事实来源，供包侧与消费端共享）。 */
export const editOperationUnion = z.discriminatedUnion('type', [
  replaceTextOperationSchema,
  insertTextOperationSchema,
  insertTextAtAnchorOperationSchema,
  appendTextOperationSchema,
  prependTextOperationSchema,
  deleteTextOperationSchema,
  createFileOperationSchema,
  deleteFileOperationSchema,
  renameFileOperationSchema,
  replaceSymbolOperationSchema,
  insertAroundSymbolOperationSchema,
  insertBeforeSymbolOperationSchema,
  insertAfterSymbolOperationSchema,
  addImportOperationSchema,
  removeImportOperationSchema,
  jsonPatchOperationSchema,
  customEditOperationSchema,
])
export const editIntentSchema = z.object({
  targetId: z.string().optional().describe(
    parameterDescription({
      description: '目标解析阶段返回的稳定目标 id。',
    })
  ),
  operation: editOperationUnion.describe(
    parameterDescription({
      description: '编辑操作载荷；按 type 选择对应结构，具体字段说明写在各结构字段上。',
      notes: ['已知操作结构保留未知字段，以便 workspace 插件读取扩展参数。'],
    })
  ),
  reason: z.string().optional().describe(
    parameterDescription({
      description: '该 intent 的修改原因。',
    })
  ),
  constraints: editConstraintsSchema.optional(),
}).describe(
  parameterDescription({
    description: '单个编辑 intent；可直接携带 operation，也可用 targetId 绑定已解析目标。',
  })
).superRefine((intent, ctx) => {
  // L0：把「targetId 或 path+oldText 二选一」从散文升级为可校验约束，并给出可执行的报错。
  // refinement 不会序列化进 JSON schema，因此对 token 预算零开销。
  if (isString(intent.targetId) && !isEmpty(intent.targetId)) return
  const op = intent.operation as { type?: string; path?: unknown; oldText?: unknown }
  const rangeBoundOps = new Set([
    'replace_text',
    'insert_text',
    'delete_text',
    'replace_symbol',
    'insert_around_symbol',
    'insert_before_symbol',
    'insert_after_symbol',
  ])
  if (isString(op.type) && rangeBoundOps.has(op.type) && !isNonBlankString(op.path)) {
    ctx.addIssue({
      code: "custom",
      path: ['operation', 'path'],
      message: '无 targetId 时需在 operation.path 提供文件路径，或先用 resolve_target 得到 targetId。',
    })
  }
  if ((op.type === 'replace_text' || op.type === 'delete_text') && !isNonBlankString(op.oldText)) {
    ctx.addIssue({
      code: "custom",
      path: ['operation', 'oldText'],
      message: '无 targetId 时，replace_text / delete_text 需提供 oldText 以定位目标。',
    })
  }
})
export const editOperationsSchema = z.array(editIntentSchema).describe(
  parameterDescription({
    description: '编辑 intent 列表。',
    notes: ['每项包含 targetId?、operation、reason?、constraints?；operation.path 必须放在 operation 内。'],
  })
)
export const stagedEditOperationsSchema = z.array(editIntentSchema).describe(
  parameterDescription({
    description: '追加到已准备事务的编辑 intent 列表。',
    notes: ['oldText 与 anchor 应指向事务暂存后的内容。'],
  })
)
export const postconditionSymbolValueSchema = z.object({
  path: operationRequiredPathSchema,
  symbol: symbolSelectorSchema.describe(
    parameterDescription({
      description: '要检查的 JS/TS 符号。',
    })
  ),
}).describe(
  parameterDescription({
    description: '符号类后置条件的 value 结构。',
  })
)
export const schemaValidPostconditionValueSchema = z.object({
  paths: z.array(workspacePathItemSchema).optional().describe(
    parameterDescription({
      description: '要校验 schema 的工作区相对路径列表；省略时由事务 changedFiles 或校验器决定。',
    })
  ),
  schema: z.record(z.string(), z.unknown()).optional().describe(
    parameterDescription({
      description: '结构化校验器使用的 schema 配置。',
    })
  ),
}).describe(
  parameterDescription({
    description: '结构化文件校验后置条件的 value 结构，用于描述校验目标。',
  })
)
export const layoutPreservedPostconditionValueSchema = z.object({
  paths: z.array(workspacePathItemSchema).optional().describe(
    parameterDescription({
      description: '要检查布局稳定性的文件路径列表。',
    })
  ),
  tolerance: z.number().optional().describe(
    parameterDescription({
      description: '允许的布局差异阈值。',
    })
  ),
}).describe(
  parameterDescription({
    description: '布局稳定性后置条件的 value 结构，用于描述检查范围。',
  })
)
export const formulaPreservedPostconditionValueSchema = z.object({
  paths: z.array(workspacePathItemSchema).optional().describe(
    parameterDescription({
      description: '要检查公式稳定性的表格文件路径列表。',
    })
  ),
  sheets: z.array(sheetNameItemSchema).optional().describe(
    parameterDescription({
      description: '要检查的工作表名称列表。',
    })
  ),
  ranges: z.array(cellRangeItemSchema).optional().describe(
    parameterDescription({
      description: '要检查的单元格范围列表。',
    })
  ),
}).describe(
  parameterDescription({
    description: '表格公式稳定性后置条件的 value 结构，用于描述检查范围。',
  })
)
export const mustContainPostconditionSchema = z.looseObject({
  type: z.literal('must_contain').describe(
    parameterDescription({
      description: '要求事务每个 changed file 的暂存内容都包含指定字符串。',
    })
  ),
  value: z.string().describe(
    parameterDescription({
      description: '必须出现的字符串。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文本必须出现的后置条件；默认 core.postcondition 会执行。',
  })
)
export const mustNotContainPostconditionSchema = z.looseObject({
  type: z.literal('must_not_contain').describe(
    parameterDescription({
      description: '要求事务每个 changed file 的暂存内容都不包含指定字符串。',
    })
  ),
  value: z.string().describe(
    parameterDescription({
      description: '禁止出现的字符串。',
    })
  ),
}).describe(
  parameterDescription({
    description: '文本禁止出现的后置条件；默认 core.postcondition 会执行。',
  })
)
export const mustKeepSymbolPostconditionSchema = z.looseObject({
  type: z.literal('must_keep_symbol').describe(
    parameterDescription({
      description: '要求修改后仍能解析到指定符号。',
    })
  ),
  value: postconditionSymbolValueSchema,
}).describe(
  parameterDescription({
    description: '符号必须保留的后置条件；需要对应自定义 validator 执行。',
  })
)
export const mustModifySymbolPostconditionSchema = z.looseObject({
  type: z.literal('must_modify_symbol').describe(
    parameterDescription({
      description: '要求指定符号确实被改动。',
    })
  ),
  value: postconditionSymbolValueSchema,
}).describe(
  parameterDescription({
    description: '符号必须被改动的后置条件；需要对应自定义 validator 执行。',
  })
)
export const mustNotModifySymbolPostconditionSchema = z.looseObject({
  type: z.literal('must_not_modify_symbol').describe(
    parameterDescription({
      description: '要求指定符号不被改动。',
    })
  ),
  value: postconditionSymbolValueSchema,
}).describe(
  parameterDescription({
    description: '符号不能被改动的后置条件；需要对应自定义 validator 执行。',
  })
)
export const changedFilesAllowlistPostconditionSchema = z.looseObject({
  type: z.literal('changed_files_allowlist').describe(
    parameterDescription({
      description: '要求 transaction.changedFiles 全部在允许列表中。',
    })
  ),
  value: z.array(workspacePathItemSchema).describe(
    parameterDescription({
      description: '允许被修改的工作区相对路径列表。',
    })
  ),
}).describe(
  parameterDescription({
    description: '变更文件必须落在允许列表内的后置条件；默认 core.postcondition 会执行。',
  })
)
export const maxChangedLinesPostconditionSchema = z.looseObject({
  type: z.literal('max_changed_lines').describe(
    parameterDescription({
      description: '要求 transaction.changedLines 不超过上限。',
    })
  ),
  value: z.union([changedLineLimitNumberSchema, changedLineLimitStringSchema]).describe(
    parameterDescription({
      description: '允许修改的最大行数；字符串会按数字解析。',
    })
  ),
}).describe(
  parameterDescription({
    description: '变更行数上限后置条件；默认 core.postcondition 会执行。',
  })
)
export const schemaValidPostconditionSchema = z.looseObject({
  type: z.literal('schema_valid').describe(
    parameterDescription({
      description: '要求结构化文件满足指定 schema。',
    })
  ),
  value: schemaValidPostconditionValueSchema,
}).describe(
  parameterDescription({
    description: '结构化文件校验后置条件；需要对应 adapter 或自定义 validator 执行。',
  })
)
export const layoutPreservedPostconditionSchema = z.looseObject({
  type: z.literal('layout_preserved').describe(
    parameterDescription({
      description: '要求文档、表格或演示布局保持稳定。',
    })
  ),
  value: layoutPreservedPostconditionValueSchema,
}).describe(
  parameterDescription({
    description: '布局稳定性后置条件；需要对应自定义 validator 执行。',
  })
)
export const formulaPreservedPostconditionSchema = z.looseObject({
  type: z.literal('formula_preserved').describe(
    parameterDescription({
      description: '要求表格公式不被破坏。',
    })
  ),
  value: formulaPreservedPostconditionValueSchema,
}).describe(
  parameterDescription({
    description: '表格公式稳定性后置条件；需要对应自定义 validator 执行。',
  })
)
export const customPostconditionSchema = z.looseObject({
  type: z.literal('custom').describe(
    parameterDescription({
      description: '交给自定义 validator 消费的后置条件。',
    })
  ),
  value: z.unknown().describe(
    parameterDescription({
      description: '自定义 validator 定义的配置。',
    })
  ),
}).describe(
  parameterDescription({
    description: '自定义校验器消费的后置条件；调用方必须通过 checks 启用能消费它的校验器。',
  })
)
export const postconditionSchema = z.discriminatedUnion('type', [
  mustContainPostconditionSchema,
  mustNotContainPostconditionSchema,
  mustKeepSymbolPostconditionSchema,
  mustModifySymbolPostconditionSchema,
  mustNotModifySymbolPostconditionSchema,
  changedFilesAllowlistPostconditionSchema,
  maxChangedLinesPostconditionSchema,
  schemaValidPostconditionSchema,
  layoutPreservedPostconditionSchema,
  formulaPreservedPostconditionSchema,
  customPostconditionSchema,
])
  .describe(
    parameterDescription({
      description: '事务准备后要验证的声明式不变量；按 type 选择对应 value 结构。',
      notes: [
        '默认 core.postcondition 只直接执行文本包含、文本排除、变更文件允许列表和最大变更行数这四类检查。',
        '其他类型是给 adapter 或自定义 validator 使用的声明，不应假设默认校验器会自动生效。',
      ],
    })
  )
function defineReadInputSchema(description: string) {
  return z.strictObject({
    path: z.union([
      z.array(workspacePathItemSchema).min(1).max(20),
      workspaceReadPathItemSchema,
    ]).describe(
      parameterDescription({
        description: '要读取的工作区相对路径；可传单个路径字符串，也可传路径数组。',
        usage: ['读取多个文件时传数组。每个路径都会独立读取并返回 snapshot。'],
      })
    ),
    range: readRangeSchema.optional().describe(
      parameterDescription({
        description: '有界读取窗口。',
      })
    ),
    baseRevisions: z.record(z.string(), z.string()).optional().describe(
      parameterDescription({
        description: '调用方期望读取的文件 revision 映射。',
        usage: ['键是 path 指定的工作区相对路径，值是该路径期望的 revision。'],
      })
    ),
    // 宽容:上限超出直接钳到顶(不整调用报废);上界写在描述里保住模型可见性。
    maxBytes: z
      .number()
      .transform((value) => Math.min(5 * 1024 * 1024, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '读取结果允许返回的最大字节数。',
          notes: ['上限 5MB，超出自动钳制。'],
        })
      ),
    maxChars: z
      .number()
      .transform((value) => Math.min(500_000, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '读取结果允许返回的最大字符数。',
          notes: ['上限 500000，超出自动钳制。'],
        })
      ),
    allowUnbounded: z.boolean().optional().describe(
      parameterDescription({
        description: '是否显式允许无界读取。',
        usage: ['只有确认文件足够小或调用方能承受完整内容时才传 true。'],
        notes: ['range/maxBytes/maxChars 都省略时按安全默认上限读取，不会报错。'],
      })
    ),
    trust: trustLabelSchema.optional(),
  }).describe(
    parameterDescription({
      description,
    })
  ).superRefine((value, ctx) => {
    const endLine = value.range?.endLine
    if (isNumber(value.range?.startLine) && isNumber(endLine) && value.range.startLine > endLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['range', 'endLine'],
        message: 'range.startLine 不能大于 range.endLine',
      })
    }
    const paths = isString(value.path) ? [value.path] : isArray(value.path) ? value.path : []
    for (const path of Object.keys(value.baseRevisions ?? {})) {
      if (!paths.includes(path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseRevisions', path],
          message: 'baseRevisions 只能包含 path 中的路径',
        })
      }
    }
  })
}
export const batchReadInputSchema = defineReadInputSchema('批处理中的有界读取输入结构。')
export const batchSearchInputSchema = z.strictObject({
  query: z.string().describe(
    parameterDescription({
      description: '要在文件正文中搜索的字符串或正则表达式。',
    })
  ),
  root: z.string().optional().describe(
    parameterDescription({
      description: '限制正文搜索范围的工作区相对根目录。',
    })
  ),
  include: z.array(globPatternItemSchema).optional().describe(
    parameterDescription({
      description: '正文搜索时保留候选文件的 glob 列表。',
    })
  ),
  exclude: z.array(globPatternItemSchema).optional().describe(
    parameterDescription({
      description: '正文搜索时排除候选文件的 glob 列表。',
    })
  ),
  excludeGitignored: z.boolean().optional().describe(
    parameterDescription({
      description: '是否排除 gitignore 命中的文件。',
    })
  ),
  maxResults: z.number().optional().describe(
    parameterDescription({
      description: '最多返回的正文命中数量。',
    })
  ),
  regex: z.boolean().optional().describe(
    parameterDescription({
      description: '是否将 query 解释为正则表达式。',
    })
  ),
  caseSensitive: z.boolean().optional().describe(
    parameterDescription({
      description: '搜索是否区分大小写。',
    })
  ),
  useRipgrep: z.boolean().optional().describe(
    parameterDescription({
      description: '是否优先使用 ripgrep 执行正文搜索。',
    })
  ),
}).describe(
  parameterDescription({
    description: '批处理中的正文搜索输入结构。',
  })
)
export const batchResolveInputSchema = z.strictObject({
  path: z.string().describe(
    parameterDescription({
      description: '要解析目标的工作区相对文件路径。',
    })
  ),
  target: targetHintSchema.optional(),
  baseRevision: z.string().optional().describe(
    parameterDescription({
      description: '调用方观察到的文件 revision。',
    })
  ),
  expectedMatches: z.number().optional().describe(
    parameterDescription({
      description: '期望解析出的匹配数量。',
    })
  ),
  trust: trustLabelSchema.optional().describe(
    parameterDescription({
      description: '目标提示的信任来源标签。',
    })
  ),
}).describe(
  parameterDescription({
    description: '批处理中的目标解析输入结构。',
  })
)
export const batchPrepareInputSchema = z.strictObject({
  operations: editOperationsSchema,
  evidenceId: z.string().optional().describe(
    parameterDescription({
      description: 'evidence 构建阶段返回的 evidence id；默认 core 仅透传给输入流水线。',
    })
  ),
  baseRevision: z.string().optional().describe(
    parameterDescription({
      description: '没有 targetId 自带 revision 时使用的 revision 防护。',
    })
  ),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    parameterDescription({
      description: '调用方附加到事务的元数据。',
    })
  ),
}).describe(
  parameterDescription({
    description: '批处理中的准备编辑输入结构。',
  })
)
export const batchApplyInputSchema = z.strictObject({
  transactionId: z.string().describe(
    parameterDescription({
      description: '已准备事务的 id。',
    })
  ),
}).describe(
  parameterDescription({
    description: '批处理中的应用编辑输入结构。',
  })
)
export const batchValidateInputSchema = z.strictObject({
  transactionId: z.string().optional().describe(
    parameterDescription({
      description: '要校验的事务 id。',
    })
  ),
  paths: z.array(workspacePathItemSchema).optional().describe(
    parameterDescription({
      description: '要校验的工作区相对文件路径列表。',
    })
  ),
  checks: z.array(validationCheckIdSchema).optional().describe(
    parameterDescription({
      description: '要运行的 workspace 校验器 id 列表。',
    })
  ),
  postconditions: z.array(postconditionSchema).optional().describe(
    parameterDescription({
      description: '要验证的后置条件列表。',
    })
  ),
}).describe(
  parameterDescription({
    description: '批处理中的校验输入结构。',
  })
)
export const batchRollbackInputSchema = z.strictObject({
  transactionId: z.string().describe(
    parameterDescription({
      description: '已应用事务的 id。',
    })
  ),
}).describe(
  parameterDescription({
    description: '批处理中的回滚输入结构。',
  })
)
export const batchReadOperationSchema = z.strictObject({
  kind: z.literal('read').describe(
    parameterDescription({
      description: '执行有界读取任务。',
    })
  ),
  input: batchReadInputSchema,
}).describe(
  parameterDescription({
    description: '有界读取任务操作结构。',
  })
)
export const batchSearchOperationSchema = z.strictObject({
  kind: z.literal('search').describe(
    parameterDescription({
      description: '执行正文搜索任务。',
    })
  ),
  input: batchSearchInputSchema,
}).describe(
  parameterDescription({
    description: '正文搜索任务操作结构。',
  })
)
export const batchResolveOperationSchema = z.strictObject({
  kind: z.literal('resolve').describe(
    parameterDescription({
      description: '执行目标解析任务。',
    })
  ),
  input: batchResolveInputSchema,
}).describe(
  parameterDescription({
    description: '目标解析任务操作结构。',
  })
)
export const batchPrepareOperationSchema = z.strictObject({
  kind: z.literal('prepare').describe(
    parameterDescription({
      description: '执行准备编辑任务。',
    })
  ),
  input: batchPrepareInputSchema,
}).describe(
  parameterDescription({
    description: '准备编辑任务操作结构。',
  })
)
export const batchApplyOperationSchema = z.strictObject({
  kind: z.literal('apply').describe(
    parameterDescription({
      description: '执行应用编辑任务。',
    })
  ),
  input: batchApplyInputSchema,
}).describe(
  parameterDescription({
    description: '应用编辑任务操作结构。',
  })
)
export const batchValidateOperationSchema = z.strictObject({
  kind: z.literal('validate').describe(
    parameterDescription({
      description: '执行工作区校验任务。',
    })
  ),
  input: batchValidateInputSchema,
}).describe(
  parameterDescription({
    description: '工作区校验任务操作结构。',
  })
)
export const batchRollbackOperationSchema = z.strictObject({
  kind: z.literal('rollback').describe(
    parameterDescription({
      description: '执行事务回滚任务。',
    })
  ),
  input: batchRollbackInputSchema,
}).describe(
  parameterDescription({
    description: '事务回滚任务操作结构。',
  })
)
export const batchOperationSchema = z.discriminatedUnion('kind', [
  batchReadOperationSchema,
  batchSearchOperationSchema,
  batchResolveOperationSchema,
  batchPrepareOperationSchema,
  batchApplyOperationSchema,
  batchValidateOperationSchema,
  batchRollbackOperationSchema,
]).describe(
  parameterDescription({
    description: '批处理任务操作载荷；按 kind 选择对应 input 结构。',
  })
)
export const batchTaskSchema = z
  .strictObject({
    id: z.string().describe(
      parameterDescription({
        description: '批处理任务 id。',
      })
    ),
    dependsOn: z.array(batchDependencyIdSchema).optional().describe(
      parameterDescription({
        description: '当前任务开始前必须成功完成的任务 id 列表。',
      })
    ),
    op: batchOperationSchema,
  })
  .describe(
    parameterDescription({
      description: '批处理中的单个任务。',
    })
  )

// --- Agent 工具输入 schema（16 个工具的唯一事实来源）---

export const statusInputSchema = z.object({})

export const readInputSchema = defineReadInputSchema('read 工具有界读取输入结构。')

export const statInputSchema = z.object({
  path: z.string().describe(
    parameterDescription({
      description: '要检查元数据的工作区相对路径。',
      usage: ['用于文件、目录、缺失路径或二进制文件的轻量探测。'],
    })
  ),
})

export const listFilesInputSchema = z.object({
  path: z.string().optional().describe(
    parameterDescription({
      description: '开始列举的工作区相对目录或路径。',
      notes: ['省略时从工作区根目录开始。'],
    })
  ),
  include: z.array(globPatternItemSchema).optional().describe(
    parameterDescription({
      description: '用于保留候选路径的 glob 列表。',
      usage: ['例如 **/*.ts 或 packages/workspace/**。'],
    })
  ),
  exclude: z.array(globPatternItemSchema).optional().describe(
    parameterDescription({
      description: '用于排除候选路径的 glob 列表。',
      usage: ['例如 dist/**、node_modules/** 或 **/*.map。'],
    })
  ),
  excludeGitignored: z.boolean().optional().describe(
    parameterDescription({
      description: '是否排除 gitignore 命中的路径。',
      notes: ['默认行为由 workspace 实现决定。'],
    })
  ),
  maxFiles: z.number().optional().describe(
    parameterDescription({
      description: '最多返回的路径数量。',
      usage: ['递归或宽 glob 查询时设置上限。'],
    })
  ),
  recursive: z.boolean().optional().describe(
    parameterDescription({
      description: '是否递归列举子目录。',
      notes: ['递归查询通常应同时设置 maxDepth 或 maxFiles。'],
    })
  ),
  maxDepth: z.number().optional().describe(
    parameterDescription({
      description: '递归列举时允许进入的最大目录深度。',
      usage: ['与 recursive 搭配控制扫描范围。'],
    })
  ),
})

export const searchInputSchema = batchSearchInputSchema.extend({})

export const symbolsInputSchema = z.object({
  path: z.string().describe(
    parameterDescription({
      description: '要抽取符号的单个工作区相对文件路径。',
      notes: ['跨文件正文定位请使用 search。'],
    })
  ),
})

export const resolveTargetInputSchema = batchResolveInputSchema.extend({})

export const evidenceTaskSchema = z.object({
  description: z.string().optional().describe(
    parameterDescription({
      description: '任务的人类可读简述；随 evidence 记录，便于追溯上下文。',
    })
  ),
  goal: z.string().optional().describe(
    parameterDescription({
      description: '本次任务目标。',
    })
  ),
  userConstraints: z.array(taskConstraintItemSchema).optional().describe(
    parameterDescription({
      description: '用户明确给出的限制条件。',
    })
  ),
  successCriteria: z.array(taskSuccessCriterionItemSchema).optional().describe(
    parameterDescription({
      description: '判断任务完成的标准。',
    })
  ),
  riskLevel: z.enum(['low', 'medium', 'high']).optional().describe(
    parameterDescription({
      description: '任务风险等级。',
    })
  ),
})

export const buildEvidenceInputSchema = z.object({
  task: evidenceTaskSchema.optional().describe(
    parameterDescription({
      description: '随 evidence 记录的任务摘要。',
    })
  ),
  target: z
    .object({
      targetId: z.string().optional().describe(
        parameterDescription({
          description: '目标解析阶段返回的目标 id。',
        })
      ),
      path: z.string().optional().describe(
        parameterDescription({
          description: '没有 targetId 时使用的工作区相对文件路径。',
        })
      ),
      baseRevision: z.string().optional().describe(
        parameterDescription({
          description: '目标对应的文件 revision。',
        })
      ),
      range: rangeSchema.optional().describe(
        parameterDescription({
          description: '没有 targetId 时使用的目标行列范围。',
        })
      ),
    })
    .optional()
    .describe(
      parameterDescription({
        description: '要构建 evidence 的目标。',
      })
    ),
  include: z
    .object({
      currentWindow: z.boolean().optional().describe(
        parameterDescription({
          description: '是否包含目标附近的当前文本窗口。',
        })
      ),
      windowLinesBefore: z.number().optional().describe(
        parameterDescription({
          description: '当前窗口中目标之前包含的行数。',
        })
      ),
      windowLinesAfter: z.number().optional().describe(
        parameterDescription({
          description: '当前窗口中目标之后包含的行数。',
        })
      ),
    })
    .optional()
    .describe(
      parameterDescription({
        description: 'EvidencePack 要包含的上下文内容。',
      })
    ),
  editScope: z
    .object({
      allowedFiles: z.array(workspacePathItemSchema).optional().describe(
        parameterDescription({
          description: '允许编辑的文件路径列表。',
        })
      ),
      forbiddenFiles: z.array(workspacePathItemSchema).optional().describe(
        parameterDescription({
          description: '禁止编辑的文件路径列表。',
        })
      ),
      maxChangedFiles: z.number().optional().describe(
        parameterDescription({
          description: '允许修改的最大文件数。',
        })
      ),
      maxChangedLines: z.number().optional().describe(
        parameterDescription({
          description: '允许修改的最大行数。',
        })
      ),
      allowFullFileRewrite: z.boolean().optional().describe(
        parameterDescription({
          description: '是否允许整文件级重写。',
        })
      ),
    })
    .optional()
    .describe(
      parameterDescription({
        description: '随 evidence 记录的编辑范围提示；默认 core 不把它单独作为写盘前强制校验。',
      })
    ),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    parameterDescription({
      description: '调用方附加的 evidence 元数据。',
    })
  ),
})

export const prepareEditInputSchema = z.object({
  operations: editOperationsSchema,
  evidenceId: evidenceIdParam(),
  baseRevision: baseRevisionGuardParam(),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    parameterDescription({
      description: '调用方附加到事务的元数据。',
    })
  ),
})

export const amendEditInputSchema = z.object({
  transactionId: z.string().describe(
    parameterDescription({
      description: '要修补的已准备事务 id。',
    })
  ),
  operations: stagedEditOperationsSchema,
  evidenceId: evidenceIdParam(),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    parameterDescription({
      description: '调用方附加到修补事务的元数据。',
    })
  ),
})

export const commitEditInputSchema = z.object({
  operations: editOperationsSchema,
  evidenceId: evidenceIdParam(),
  baseRevision: baseRevisionGuardParam(),
  autoApply: z.boolean().optional().describe(
    parameterDescription({
      description: '校验通过后是否自动应用事务。',
      notes: ['默认 true；传 false 时只返回准备和校验结果。'],
    })
  ),
  checks: z.array(validationCheckIdSchema).optional().describe(
    parameterDescription({
      description: '要运行的 workspace 校验器 id 列表。',
      notes: ['省略时使用 workspace 当前注册的默认校验器，Prettier/ESLint 默认延后。'],
    })
  ),
  postconditions: z.array(postconditionSchema).optional().describe(
    parameterDescription({
      description: '事务准备后要验证的后置条件列表。',
    })
  ),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    parameterDescription({
      description: '调用方附加到事务的元数据。',
    })
  ),
})

export const applyEditInputSchema = batchApplyInputSchema.extend({})

export const validateInputSchema = batchValidateInputSchema.extend({})

export const rollbackInputSchema = batchRollbackInputSchema.extend({})

export const diffInputSchema = z.object({
  transactionId: z.string().optional().describe(
    parameterDescription({
      description: '要查看 diff 的事务 id。',
      notes: ['省略时按 workspace 实现返回可用 diff 信息。'],
    })
  ),
})

export const runBatchInputSchema = z.strictObject({
  tasks: z.array(batchTaskSchema).min(1).describe(
    parameterDescription({
      description: '要执行的任务列表。',
    })
  ),
  concurrency: z.number().int().positive().optional().describe(
    parameterDescription({
      description: '批处理并发上限。',
    })
  ),
  stopOnError: z.boolean().optional().describe(
    parameterDescription({
      description: '任务失败后是否停止继续调度后续任务。',
    })
  ),
  atomic: z.boolean().optional().describe(
    parameterDescription({
      description: '批处理失败时是否回滚本批次已应用的事务。',
    })
  ),
  mode: z.enum(['dag', 'prepare-then-apply']).optional().describe(
    parameterDescription({
      description: '批处理执行模式。',
      values: ['dag：依赖满足后立即执行。', 'prepare-then-apply：先准备补丁，冲突检查通过后再应用。'],
    })
  ),
  conflictCheck: z.boolean().optional().describe(
    parameterDescription({
      description: 'prepare-then-apply 模式下是否检查准备事务之间的冲突。',
    })
  ),
})

/** 按工具名索引的输入 schema 映射，供 parity 测试与 App 适配层复用。 */
export const workspaceToolInputSchemas = {
  [wsTool.status]: statusInputSchema,
  [wsTool.read]: readInputSchema,
  [wsTool.stat]: statInputSchema,
  [wsTool.listFiles]: listFilesInputSchema,
  [wsTool.search]: searchInputSchema,
  [wsTool.symbols]: symbolsInputSchema,
  [wsTool.resolveTarget]: resolveTargetInputSchema,
  [wsTool.buildEvidence]: buildEvidenceInputSchema,
  [wsTool.prepareEdit]: prepareEditInputSchema,
  [wsTool.amendEdit]: amendEditInputSchema,
  [wsTool.commitEdit]: commitEditInputSchema,
  [wsTool.applyEdit]: applyEditInputSchema,
  [wsTool.validate]: validateInputSchema,
  [wsTool.rollback]: rollbackInputSchema,
  [wsTool.diff]: diffInputSchema,
  [wsTool.runBatch]: runBatchInputSchema,
} as const

export type EvidenceTaskInput = z.infer<typeof evidenceTaskSchema>
export type BuildEvidenceToolInput = z.infer<typeof buildEvidenceInputSchema>
export type ResolveTargetToolInput = z.infer<typeof resolveTargetInputSchema>
export type RunBatchToolInput = z.infer<typeof runBatchInputSchema>
