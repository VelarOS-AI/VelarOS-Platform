import { compileProjectChange } from '../../editing/planner/index'
import type { ProjectChangeStep } from '../../editing/types'
import { ProjectError } from '../../errors'
import { ProjectToolNames } from '../../project-tool-names'
import { ProjectChangeSchema } from '../contracts/change'
import { ProjectWriteCapability } from '../ProjectCapabilities'
import { runWithProjectExecutionGate } from '../ProjectExecutionGate'
import { registerProjectFileContext } from '../ProjectFileContext'

import { projectPlannerResolver } from './planner-resolver'
import { readProjectReceipt } from './receipts'
import { defineProjectTool } from './shared'
import { applyProjectEditTransaction } from './transaction'

export const projectChange = defineProjectTool({
  name: ProjectToolNames.change,
  category: 'project-changes',
  role: 'edit',
  summary: '组合文件操作与源码编辑为一个事务，查看或撤销变更回执。',
  usage: [
    'apply 的 steps 按顺序使用 file.actions 或 edit.files。fileRef 固定读取版本；sourceRef 跟随计划中此前的移动和修改；path 只引用计划创建的文件。',
    'inspect/undo 只传 changeRef；undo 遇到外部修改会拒绝覆盖。普通 edit/file 已自动提交，不需要另行调用 apply。',
    '同一个 edit 步骤内坐标固定；后续步骤可以编辑此前步骤产生的新内容。失败用 reuse + changes 复用未变正文。',
  ],
  examples: [{ action: 'inspect', changeRef: '<changeRef>' }],
  notes: ['示例是参数模板；<changeRef> 必须替换为实际 edit/file/change 回执中的 changeRef。'],
  schema: ProjectChangeSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: { tier: 'situational', rank: 20 },
  isConcurrencySafe: (input) => input.action === 'inspect',
  execute: async (input, context) => {
    if (input.action === 'apply') return applyProjectEditTransaction({
      operationLabel: '项目事务变更',
      // 来源互斥关系已通过 schema 校验，Zod 无法自动推导对应联合类型。
      plan: () => compileProjectChange({ action: 'apply', steps: input.steps! as ProjectChangeStep[] }, projectPlannerResolver(context)),
    }, context)
    context.abortSignal.throwIfAborted()
    const changeRef = input.changeRef!
    const record = changeRef.startsWith('change:')
      ? await readProjectReceipt(context, 'change', changeRef) as {
        transactionId: string
        oldRevisions?: Record<string, string>
        newRevisions?: Record<string, string>
      }
      : { transactionId: changeRef }
    const kernel = await context.project.kernel()
    const transaction = kernel.getTransaction(record.transactionId)
    if (!transaction)
      throw new ProjectError('TARGET_NOT_FOUND', '变更回执当前不可用。', { changeRef })
    if (input.action === 'inspect') {
      const diff = transaction.diff.slice(0, 16_000)
      return { changeRef, transactionId: transaction.transactionId, status: transaction.status,
        oldRevisions: record.oldRevisions,
        newRevisions: record.newRevisions,
        changedFiles: transaction.changedFiles, changedLines: transaction.changedLines,
        diff, diffTruncated: diff.length < transaction.diff.length,
      }
    }
    const authorization = await context.project.prepareMutation({ operation: '撤销项目变更' })
    if (!authorization.approved)
      return { approved: false, changed: false, message: authorization.rejectionMessage ?? authorization.message }
    return context.project.runWithApproval(() => runWithProjectExecutionGate(
      context.project.getRootPath(), true, context.abortSignal, async () => {
        const files = registerProjectFileContext(context)
        try {
          const result = await kernel.rollback({ transactionId: record.transactionId })
          return { ...result, changeRef }
        } finally {
          files?.touch(context.project.getRootPath(), transaction.changedFiles)
          await files?.prepare(context.toolCallId)
        }
      },
    ))
  },
})
