import { z } from 'zod'

import type { SubAgentTypeId } from '@velaros-ai/agent/protocol'
import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'

/**
 * 子 Agent 授权用的分类 id：本层只校形状。可委派性由注入的 capability delegation policy 在执行期判
 * （与 `AgentWorkflow.ts` 同一裁决）。此前挂的恒空黑名单 + 永真 refine 已删——空壳门会让读者误以为
 * 委派边界在 schema 层把着。
 */
const subAgentToolCategorySchema = z.string().trim().min(1).max(120)

const teamModelRouteCategorySchema = z.string().trim().min(1).max(80)

const dispatchAgentSchema = z.object({
  agent_name: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z][A-Za-z -]*$/)
    .describe(
      parameterDescription({
        description:
          '子 Agent 的英文代号名，必须由模型在派发时填写，用于 UI 展示；不要使用数字，例如 Atlas、Forge、Scout、Beacon。',
      })
    ),
  subagent_type: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .default('general')
    .describe(
      parameterDescription({
        description:
          '子 Agent 类型 id。只使用运行时 SubAgentTypeProvider 已公开的类型。',
      })
    ),
  tool_scope: z
    .enum(['type_default', 'inherit', 'custom'])
    .default('type_default')
    .describe(
      parameterDescription({
        description:
          '子 Agent 工具授权模式：type_default 使用子 Agent 类型默认能力；inherit 继承父 Agent 当前已启用能力；custom 使用 tool_categories 指定能力。',
      })
    ),
  tool_categories: z
    .array(subAgentToolCategorySchema)
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description:
          'tool_scope=custom 时指定子 Agent 可用的工具分类。为方便查询和申请，系统会始终保留 general 分类。',
      })
    ),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(12_000)
    .describe(
      parameterDescription({
        description: '交给子 Agent 的完整任务说明，应自洽且可独立执行。',
      })
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .optional()
    .describe(
      parameterDescription({
        description: '短标题，用于 UI 线程面板展示。',
      })
    ),
  thread_id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe(
      parameterDescription({
        description: '可选：复用已有子 Agent 线程 id 以续跑、查询状态或中断。',
      })
    ),
  mode: z
    .enum(['sync', 'async'])
    .default('sync')
    .describe(
      parameterDescription({
        description:
          'sync（默认）阻塞直到子 Agent 完成、直接内联返回结果，主链路需要该结果继续时用；async 后台 fire-and-forget，立即返回可等待 job，父 Agent 继续非重叠工作，之后用 job:wait 收束。',
      })
    ),
  readonly: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '为 true 时强制只读子 Agent，禁止带写权限的能力。',
      })
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      parameterDescription({
        description: '可选：覆盖子 Agent 使用的模型 id。',
      })
    ),
  effort: z
    .enum(['fast', 'balanced', 'deep'])
    .optional()
    .describe(
      parameterDescription({
        description:
          '可选：覆盖子 Agent 的 reasoning effort（思考力度）。fast=低、balanced=中、deep=高；省略时继承当前会话 effort。简单/机械子任务用 fast 更快省钱，深度分析/难题用 deep。',
      })
    ),
  output_schema: z
    .record(z.string().trim().min(1).max(120), z.unknown())
    .optional()
    .describe(
      parameterDescription({
        description:
          '可选：要求子 Agent 返回符合该 JSON Schema 的结构化对象（有界 JSON Schema 子集：type/properties/required/items/enum 等）。设置后子 Agent 强制产出合规 JSON，校验不符会自动重试；结果在 <subagent-result> 的 structured_output 字段。父需要机器可读结果、免去二次解析散文时用。',
      })
    ),
  route_category: teamModelRouteCategorySchema.optional().describe(
    parameterDescription({
      description: '可选：覆盖团队模型路由分类（如 scout、writer、verifier）。',
    })
  ),
  attachments: z
    .array(z.string().trim().min(1).max(4096))
    .max(20)
    .optional()
    .describe(
      parameterDescription({
        description: '可选：附加到子 Agent 指令的上下文片段（最多 20 条）。',
      })
    ),
  interrupt: z
    .boolean()
    .default(false)
    .describe(
      parameterDescription({
        description: '配合 thread_id：为 true 时中断该线程上正在运行的子 Agent。',
      })
    ),
}).superRefine((value, issueCtx) => {
  if (value.tool_scope !== 'custom' || !isEmpty(value.tool_categories)) return

  issueCtx.addIssue({
    code: 'custom',
    message: 'tool_scope=custom 时至少需要指定一个 tool_categories。',
    path: ['tool_categories'],
  })
})

type DispatchAgentInput = z.infer<typeof dispatchAgentSchema>

export { type DispatchAgentInput, dispatchAgentSchema, type SubAgentTypeId }
