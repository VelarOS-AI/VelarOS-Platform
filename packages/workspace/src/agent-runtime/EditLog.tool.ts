/**
 * P1-B：get_session_edit_log
 *
 * 列出本 agent run（当前会话）内所有通过工作区编辑工具写入的文件变更记录。
 * 包含工具名、路径、created 标志、新增/删除行数和 changeId，
 * 让模型不需要重新 read 文件就能确认"自己刚才到底改了什么"。
 */
import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { defineWorkspaceToolCapability } from './KernelToolShared'
import { defineWorkspaceVelaTool } from './workspaceToolMiddleware'

const getSessionEditLog = defineWorkspaceVelaTool<{ limit?: number }>({
  name: 'get_session_edit_log',
  role: 'inspect',
  category: 'workspace-inspect',
  summary: '列出本次 agent run 的工作区文件变更记录。',
  suitable: ['编辑后需要快速确认自己刚才改了哪些文件。'],
  forbidden: ['不要用它替代最终 diff 或测试验证。'],
  usage: ['可传 limit 限制返回条数。'],
  examples: [
    // 本次 run 的全部变更
    {},
    // 只看最近 20 条
    { limit: 20 },
  ],
  notes: ['只包含通过编辑工具写入且成功记录的变更。'],
  schema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe(
        parameterDescription({
          description: '最多返回的记录条数。',
          notes: ['省略时返回全部可用记录，硬上限为 60。'],
        })
      ),
  }),
  permissions: [],
  capabilities: defineWorkspaceToolCapability({
    effectKind: 'transaction_inspect',
    readScopes: ['workspace'],
    metadata: {
      workspace: { mutation: 'transaction-inspect' },
    },
    canReadArbitrarySource: false,
    concurrency: 'safe',
    reason: 'session edit log inspection',
  }),
  isConcurrencySafe: () => true,
  execute: async ({ limit }, ctx) => {
    const all = ctx.codingSession.getRecentFileChanges()
    const entries = limit ? all.slice(-limit) : all

    if (entries.length === 0) return {
        count: 0,
        entries: [],
        message: '本次 agent run 内尚未记录到任何文件变更。',
      }

    return {
      count: entries.length,
      entries: entries.map((e) => ({
        tool: e.toolName,
        path: e.path,
        created: e.created,
        added: e.added,
        removed: e.removed,
        changeId: e.changeId,
      })),
    }
  },
})

const codingSessionEditLogTools = {
  get_session_edit_log: getSessionEditLog,
}
export { codingSessionEditLogTools }
