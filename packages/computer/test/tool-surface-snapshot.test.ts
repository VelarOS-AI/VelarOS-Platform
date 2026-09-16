/**
 * 模型面逐字节快照。
 *
 * 冻的是模型真正看到的那几样：五个工具的顺序与名字、类别、角色、权限、要求的模型输入模态、
 * 渲染后的完整工具说明，以及入参 schema 的 JSON（每个参数的说明就在里面）。
 * `check:capabilities-schemas` 只核对 schema 生成得出来，不守字节；结构改造期间靠这条测试证明
 * 挪文件、抽常量没有动模型面——任何一个字节变了它就红。
 *
 * 真要改工具面时：跑一次本文件的渲染逻辑重写 `tool-surface-snapshot.json`，并在差量报告里逐工具说明改了什么。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { computerTools } from '../src/index'

/** 递归按键名排序，让快照与对象字面量里键的书写顺序无关。 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (!value || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return Object.fromEntries(entries.map(([key, item]) => [key, sortDeep(item)]))
}

/** 把工具集合渲染成快照文本；与 tool-surface-snapshot.json 逐字节比对。 */
function renderToolSurface(): string {
  const surface = Object.keys(computerTools).map((name) => {
    const tool = computerTools[name as keyof typeof computerTools]
    return {
      key: name,
      name: tool.name,
      category: tool.category,
      role: tool.role,
      permissions: tool.permissions,
      requiredModelInputModalities: tool.requiredModelInputModalities ?? null,
      description: tool.description,
      schema: sortDeep(z.toJSONSchema(tool.schema, { io: 'input' })),
    }
  })
  return `${JSON.stringify(surface, null, 2)}\n`
}

describe('computer 工具的模型面', () => {
  test('五个工具的说明与入参 schema 逐字节不变', () => {
    const expected = readFileSync(join(import.meta.dir, 'tool-surface-snapshot.json'), 'utf8')

    expect(renderToolSurface()).toBe(expected)
  })
})
