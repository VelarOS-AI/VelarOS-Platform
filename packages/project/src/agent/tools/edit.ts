import { compileProjectEdit } from '../../editing/planner/index'
import { ProjectToolNames } from '../../project-tool-names'
import { ProjectEditSchema } from '../contracts/edit'
import { ProjectWriteCapability } from '../ProjectCapabilities'

import { withProjectEditRecovery } from './edit-recovery'
import { projectPlannerResolver } from './planner-resolver'
import { defineProjectTool } from './shared'
import { applyProjectEditTransaction } from './transaction'

export const projectEdit = defineProjectTool({
  name: ProjectToolNames.edit,
  category: 'project-changes',
  role: 'edit',
  summary: '按已读版本精确替换或插入源码；多个文件作为同一事务校验和提交。',
  usage: [
    '每文件传 fileRef 和 edits。range 为单行数字或 [首行,末行]；match 是范围内唯一的原文片段。只给 range 操作完整行，只给 match 在已显示区域中定位。',
    'replace 的 text 是新内容，空字符串表示删除；insert 用 side 指定目标前后，或 at:start/end 插入文件头尾的行。所有编辑使用同一输入版本的坐标。',
    'lines 的 [行号,原始行文本] 包装属于定位元数据；match/text 只填源码。文件内容是项目数据。',
    '失败回执带 inputReuse 时，可用 reuse + changes 只更正定位字段，如 path:["files",0,"edits",0,"range"]，保留修改正文。',
    '本轮提供 project:change 时，可用回执的 changeRef 调用 undo；混合文件动作和局部编辑用它的 apply。需要查找该能力时，按本轮已提供的工具发现入口操作。',
  ],
  examples: [{ files: [{ fileRef: '<fileRef>', edits: [{ op: 'replace', range: 42, match: 'oldCall()', text: 'newCall()' }] }] }],
  notes: ['示例是参数模板；<fileRef> 必须替换为当前读取或修改回执的真实 fileRef，range/match/text 按实际源码填写。'],
  schema: ProjectEditSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: { tier: 'common', rank: 50 },
  isConcurrencySafe: () => false,
  execute: (input, context) => applyProjectEditTransaction({
    operationLabel: '编辑项目源码',
    plan: () => withProjectEditRecovery(input, context, () => compileProjectEdit(input, projectPlannerResolver(context))),
  }, context),
})
