/**
 * 工具面逐字节快照。
 *
 * 改造期间搬文件、拆模块、把裸数字换成常量表引用，都不许让模型看到的那一面变一个字节。
 * 这里把 10 个工具（连同它们的 preset / guided surface）的说明、参数说明与 schema JSON 冻在
 * `fixtures/tool-surface-snapshot.json` 里：结构一动就红，只有在差量报告里点名改动工具面时才更新它。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { officeTools } from '../src/index'

type ToolSurfaceSnapshot = {
  description: string
  schema: unknown
}

type ToolSnapshot = {
  name: string
  category: string
  role: string
  summary?: string
  readOnly?: boolean
  permissions: string[]
  capabilities?: unknown
  hideWhenUnavailable?: boolean
  description: string
  schema: unknown
  surfaces: Record<string, ToolSurfaceSnapshot>
}

/** 从固化文件读取上一次冻住的工具面。 */
function readFrozenSnapshot(): Record<string, ToolSnapshot> {
  const path = join(import.meta.dir, 'fixtures', 'tool-surface-snapshot.json')
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, ToolSnapshot>
}

/** 按当前源码渲染一个工具的模型面：说明、权限、能力声明与参数 schema。 */
function renderToolSnapshot(tool: Record<string, unknown>): ToolSnapshot {
  const surfaces: Record<string, ToolSurfaceSnapshot> = {}
  const declared = (tool.surfaces ?? {}) as Record<string, { description: string; schema: z.ZodType }>
  for (const [surfaceId, surface] of Object.entries(declared)) {
    surfaces[surfaceId] = {
      description: surface.description,
      schema: z.toJSONSchema(surface.schema, { io: 'input' }),
    }
  }
  return JSON.parse(
    JSON.stringify({
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
    })
  ) as ToolSnapshot
}

describe('office tool surface snapshot', () => {
  const frozen = readFrozenSnapshot()

  test('工具名单与冻住的一致', () => {
    expect(Object.keys(officeTools).sort()).toEqual(Object.keys(frozen).sort())
  })

  for (const toolName of Object.keys(frozen)) {
    test(`${toolName} 的说明与 schema 逐字节不变`, () => {
      const tool = (officeTools as Record<string, Record<string, unknown>>)[toolName]
      expect(tool).toBeDefined()
      expect(renderToolSnapshot(tool!)).toEqual(frozen[toolName]!)
    })
  }
})
