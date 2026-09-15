/**
 * 演练沙箱在 system 与 project 两个空间的工具入参一致性：数据形状、上限与落回规则已经是公共包 @velaros-ai/rehearsal-sandbox，
 * 两个工具的 schema 形状相同、文案按空间不同，各持一份；这里从仓库层核对两份 schema 对同样的输入给出同样的裁决
 * （project 多一个 run 动作，因为项目工具出不了项目边界）。
 */

import { describe, expect, test } from 'bun:test'

import { projectTools } from '../../packages/project/src/impl/ProjectTools'
import { systemTools } from '../../packages/system/src/exports/index'

const system = systemTools['system:sandbox']!
const project = projectTools['project:sandbox']!
const accepts = (tool: { schema: { safeParse: (input: unknown) => { success: boolean } } }, input: unknown): boolean => tool.schema.safeParse(input).success

describe('sandbox contract parity across spaces', () => {
  test('the shared input fields are judged the same way by system:sandbox and project:sandbox', () => {
    const shared: Array<[Record<string, unknown>, boolean]> = [
      [{ action: 'create' }, true],
      [{ action: 'create', source: 'packages/app', network: true, ignored: 'copy' }, true],
      [{ action: 'create', ignored: 'elsewhere' }, false],
      [{ action: 'create', source: '' }, false],
      [{ action: 'diff', sandboxId: '20260915-183000-3fa2c1', maxFiles: 50 }, true],
      [{ action: 'diff', sandboxId: '20260915-183000-3fa2c1', maxFiles: 0 }, false],
      [{ action: 'apply', sandboxId: '20260915-183000-3fa2c1', paths: ['src/a.ts'] }, true],
      [{ action: 'apply', sandboxId: '20260915-183000-3fa2c1', paths: [''] }, false],
      [{ action: 'discard', sandboxId: '20260915-183000-3fa2c1' }, true],
      [{ action: 'discard', sandboxId: '20260915-183000-3fa2c1', unknownField: 1 }, false],
      [{ action: 'reset' }, false],
    ]
    for (const [input, expected] of shared) {
      expect(accepts(system, input)).toBe(expected)
      expect(accepts(project, input)).toBe(expected)
    }
    // project 多的 run 动作与它的三个字段，system 一律拒绝。
    expect(accepts(project, { action: 'run', sandboxId: '20260915-183000-3fa2c1', command: 'bun test', timeoutMs: 1000, maxOutputChars: 2000 })).toBe(true)
    expect(accepts(system, { action: 'run', sandboxId: '20260915-183000-3fa2c1', command: 'bun test' })).toBe(false)
    expect(accepts(system, { action: 'diff', sandboxId: '20260915-183000-3fa2c1', command: 'bun test' })).toBe(false)
  })

})
