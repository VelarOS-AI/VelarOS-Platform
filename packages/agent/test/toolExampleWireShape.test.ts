import { expect, test } from 'bun:test'
import { z } from 'zod'

import { defineToolRuntimeSpec } from '../src/tool-contract/define'
import {
  serializeToolExampleInput,
  ToolContractExampleRegistry,
} from '../src/tool-contract/examples'

function tool(schema: z.ZodType<any>, example: Record<string, unknown>) {
  return defineToolRuntimeSpec(
    {
      name: 'probe:example',
      category: 'probe',
      role: 'inspect',
      summary: '读取示例。',
      suitable: ['验证调用参数。'],
      forbidden: ['不执行写入。'],
      usage: ['按示例字段调用。'],
      notes: ['示例使用真实传输形状。'],
      examples: [example],
      schema,
      permissions: [],
      execute: async () => null,
    },
    new ToolContractExampleRegistry()
  )
}

test('model-facing examples are directly parseable JSON with exact escaping', () => {
  const value = { "odd'key\\": 'line\nquote" $HOME', nested: [true, null, 2], ignored: undefined }
  expect(JSON.parse(serializeToolExampleInput(value))).toEqual({
    "odd'key\\": 'line\nquote" $HOME',
    nested: [true, null, 2],
  })
})

test('optional example fields use omission rather than a schema-invalid null', () => {
  const schema = z.object({ value: z.string(), limit: z.number().optional() })
  const defined = tool(schema, { value: 'sample', limit: undefined })
  const match = defined.description.match(/调用参数示例：(.+)。/u)
  expect(match).not.toBeNull()
  const input = JSON.parse(match![1]!)
  expect(input).toEqual({ value: 'sample' })
  expect(schema.safeParse(input).success).toBe(true)
})

test('definition validates the actual JSON wire shape rather than only the in-memory object', () => {
  const schema = z.object({ at: z.date() })
  expect(() => tool(schema, { at: new Date('2026-01-01T00:00:00Z') })).toThrow(/example/u)
})
