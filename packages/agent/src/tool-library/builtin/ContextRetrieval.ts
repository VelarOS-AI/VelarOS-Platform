import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'

const MAX_CHARS_MIN = 1_000
const MAX_CHARS_MAX = 30_000

/** maxChars 钳制到 [1000, 30000]:模型传超限值不该被硬拒(schema error),自动夹到范围。 */
function clampMaxChars(value: number): number {
  return Math.min(MAX_CHARS_MAX, Math.max(MAX_CHARS_MIN, Math.round(value)))
}

export const recallContextSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe(
        parameterDescription({
          description: '要从历史上下文中找回的信息查询；用于搜索类召回。',
          notes: ['可用文件名、错误、命令、路径、决策或用户意图关键词。'],
        })
      ),
    kind: z
      .enum(['all', 'conversation', 'terminal'])
      .optional()
      .describe(
        parameterDescription({
          description: '搜索范围。',
          values: [
            'all：同时搜索会话历史和保存的终端输出。',
            'conversation：只搜索较早可见聊天记录。',
            'terminal：只搜索已保存的内部终端日志。',
          ],
          notes: ['默认 all；精确 ref 读取时忽略。'],
        })
      ),
    ref: z
      .string()
      .min(1)
      .optional()
      .describe(
        parameterDescription({
          description: '要精确取回的上下文引用。',
          notes: ['可传 evidence id、tool call id、ctx-payload:* 或动态上下文 handle。'],
        })
      ),
    refKind: z
      .enum(['evidence', 'tool-payload', 'payload-ref', 'context-handle'])
      .optional()
      .describe(
        parameterDescription({
          description: 'ref 的类型。',
          values: [
            'evidence：读取 Context OS evidence ledger 记录。',
            'tool-payload：按 tool call id 读取保存的工具 payload。',
            'payload-ref：按 ctx-payload:* 内容引用读取工具 payload。',
            'context-handle：按动态上下文 handle 取回压缩上下文。',
          ],
          notes: ['可省略——系统按 ref 前缀自动判别(ctx-payload:*/tool:*/message:*/含冒号段的 evidence id/裸 tool call id)。'],
        })
      ),
    jsonPath: z
      .string()
      .min(1)
      .max(1_000)
      .optional()
      .describe(
        parameterDescription({
          description: '精确 ref 读取工具 payload 时，只取回该 JSON path 子树。',
          notes: ['用于读取工具结果截断节点上的 jsonPath。'],
        })
      ),
    offset: z
      .number()
      .transform((value) => Math.max(0, Math.round(value)))
      .optional()
      .describe(
        parameterDescription({
          description: 'jsonPath 命中数组时从第几项开始返回（0 起）。',
          notes: [
            '配合工具结果里 __truncatedItems 标记的 nextOffset 续读剩余条目。',
            '返回若仍有剩余,结果会带新的 nextOffset。',
          ],
        })
      ),
    reason: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe(
        parameterDescription({
          description: '为什么现在需要这段历史上下文（可省略）。',
        })
      ),
    maxResults: z
      .number()
      .transform((value) => Math.min(20, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '搜索模式最多返回多少条匹配结果。',
          notes: ['默认 8。'],
        })
      ),
    maxChars: z
      .number()
      .int()
      .transform(clampMaxChars)
      .optional()
      .describe(
        parameterDescription({
          description: '最多返回多少字符。',
          notes: ['默认 8000；只有聚焦需求才提高上限。'],
        })
      ),
  })
  .superRefine((input, refinementContext) => {
    // 宽容:传 ref 即可——refKind 按前缀自动判别、reason 缺省兜底(真机实证:两个必填
    // 都是模型高频踩的仪式,对只读取回无功能作用,硬拒只烧一轮重试)。
    if (input.ref) return

    if (!input.query?.trim()) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['query'],
        message: '搜索召回必须提供 query；精确取回必须提供 ref。',
      })
    }
  })

export type RecallContextInput = z.infer<typeof recallContextSchema>

/** recall 精确取回的 refKind 前缀判别:模型可省略 refKind,系统按 ref 形状推断。 */
export function inferRecallRefKind(
  ref: string
): 'evidence' | 'tool-payload' | 'payload-ref' | 'context-handle' {
  if (ref.startsWith('ctx-payload:')) return 'payload-ref'
  // tool:*/message:* 都是 retrieveContextPayload 原生认识的 handle 前缀,直接走 handle 通道;
  // 若推断成 tool-payload 会经 readToolPayload 再包一层 tool: 前缀,变成 tool:tool:* 而 miss。
  if (ref.startsWith('tool:') || ref.startsWith('message:')) return 'context-handle'
  // evidence id 形如 <toolCallId>:<kind>:<index>(至少两个冒号段);裸 tool call id 无冒号。
  if (ref.split(':').length >= 3) return 'evidence'
  return 'tool-payload'
}
