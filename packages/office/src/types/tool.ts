/** 工具面的工作类型：能力声明的形状（比 agent 的基类多要求一张 metadata 表）。 */

import type { ToolCapabilitySchema } from '@velaros-ai/agent/protocol'

/** office 工具的能力声明：在 agent 的能力 schema 之上，要求每档都带一张宿主读的 metadata 表。 */
export type OfficeToolCapabilitySchema = ToolCapabilitySchema & {
  metadata: Readonly<Record<string, unknown>>
}
