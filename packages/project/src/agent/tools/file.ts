import { compileProjectFile } from '../../editing/planner/index'
import { ProjectToolNames } from '../../project-tool-names'
import { ProjectFileSchema } from '../contracts/file'
import { ProjectWriteCapability } from '../ProjectCapabilities'

import { projectPlannerResolver } from './planner-resolver'
import { defineProjectTool } from './shared'
import { applyProjectEditTransaction } from './transaction'

export const projectFile = defineProjectTool({
  name: ProjectToolNames.file,
  category: 'project-changes',
  role: 'edit',
  summary: '通过事务创建、整体覆盖、移动、删除项目文件，或批量转换文件的磁盘编码。',
  usage: [
    'actions 中 create 传 path/text；overwrite 传 fileRef/text；move 传 fileRef/to；delete 传 fileRef。create 拒绝覆盖已有路径。',
    'recode 传 paths 与可选 encoding（默认 utf-8）、bom、newline：框架探测原编码并按目标格式重写字节，Unicode 正文不变，已是目标格式的文件跳过；读取与编辑永远只处理文本，不需要也不接受编码参数。',
    'move 本身只移动文件。移动与源码引用更新需要共同提交且本轮提供 project:change 时，用它组合文件动作和编辑。',
    '失败回执包含 inputReuse 时，用 reuse + changes 修正字段，正文自动复用。',
    '本轮提供 project:change 时，整组撤销用回执的 changeRef 调用 undo，无需重新输入原文件内容。需要查找该能力时，按本轮已提供的工具发现入口操作。',
  ],
  examples: [{ actions: [{ op: 'create', path: 'src/cache.ts', text: 'export const cache = new Map()\n' }] }],
  schema: ProjectFileSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: { tier: 'common', rank: 40 },
  isConcurrencySafe: () => false,
  execute: (input, context) => applyProjectEditTransaction({
    operationLabel: '变更项目文件',
    plan: () => compileProjectFile(input, projectPlannerResolver(context)),
  }, context),
})
