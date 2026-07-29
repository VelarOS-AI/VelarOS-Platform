// 域：Kernel 通用 identity。这里只表达归属和生命周期关联，不解释聊天、工作区或 Agent 回合。
import { z } from 'zod'

import { ScopeRefSchema } from './capability'

export const KernelSessionIdentitySchema = z.strictObject({
  id: z.string().min(1),
  ownerModuleId: z.string().min(1),
  scope: ScopeRefSchema.nullable(),
  createdAt: z.number().int(),
})
export type KernelSessionIdentity = z.infer<
  typeof KernelSessionIdentitySchema
>

export const KernelRunIdentitySchema = z.strictObject({
  id: z.string().min(1),
  ownerModuleId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  generation: z.number().int().positive(),
  startedAt: z.number().int(),
})
export type KernelRunIdentity = z.infer<typeof KernelRunIdentitySchema>
