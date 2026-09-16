/**
 * 重新固化工具面快照（`bun run test/support/generate-tool-surface-snapshot.ts`）。
 *
 * 只有在差量报告里点名改了工具说明或 schema 时才跑它；改造期间工具面不许变，跑它等于承认变了。
 * 渲染方式必须与 `test/tool-surface-snapshot.test.ts` 完全一致，zod 也要从本包解析，否则 JSON 会有差异。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { officeTools } from '../../src/index'

const snapshot: Record<string, unknown> = {}
for (const [name, raw] of Object.entries(officeTools)) {
  const tool = raw as unknown as Record<string, unknown>
  const surfaces: Record<string, unknown> = {}
  const declared = (tool.surfaces ?? {}) as Record<string, { description: string; schema: z.ZodType }>
  for (const [surfaceId, surface] of Object.entries(declared)) {
    surfaces[surfaceId] = {
      description: surface.description,
      schema: z.toJSONSchema(surface.schema, { io: 'input' }),
    }
  }
  snapshot[name] = {
    name: tool.name,
    category: tool.category,
    role: tool.role,
    summary: tool.summary,
    readOnly: tool.readOnly,
    permissions: tool.permissions,
    capabilities: tool.capabilities,
    hideWhenUnavailable: tool.hideWhenUnavailable,
    description: tool.description,
    schema: z.toJSONSchema(tool.schema as z.ZodType, { io: 'input' }),
    surfaces,
  }
}

writeFileSync(
  join(import.meta.dir, '..', 'fixtures', 'tool-surface-snapshot.json'),
  `${JSON.stringify(snapshot, null, 2)}\n`,
  'utf8'
)
console.info('已固化工具面快照，工具数：', Object.keys(snapshot).length)
