/**
 * 演练沙箱在 system 与 project 两个空间的镜像一致性：两个包互不知道对方，各自持有一份工具与数据形状，
 * 这里从仓库层核对两份入参 schema 对同样的输入给出同样的裁决（project 多一个 run 动作，因为项目工具出不了项目边界），
 * 以及记录、差量、落回结果三种数据形状可以互相赋值。
 */

import { describe, expect, test } from 'bun:test'

import { projectTools } from '../../packages/project/src/impl/ProjectTools'
import type { ProjectSandboxApplyResult, ProjectSandboxDiff, ProjectSandboxRecord } from '../../packages/project/src/types/project'
import type { SystemSandboxApplyResult, SystemSandboxDiff, SystemSandboxRecord } from '../../packages/system/src/exports/index'
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

  test('the record, diff and apply result shapes are mutually assignable', () => {
    const record: SystemSandboxRecord = { id: 'x', root: '/r', source: '/s', createdAt: 0, network: false, ignored: 'link', fileCount: 0, bytes: 0, linkedDirectories: [], git: false }
    const projectRecord: ProjectSandboxRecord = record
    const systemRecord: SystemSandboxRecord = projectRecord
    const diff: SystemSandboxDiff = { sandboxId: 'x', source: '/s', created: [], modified: [], deleted: [], truncated: false, gitChanged: false, textDiffs: [], omittedDiffs: 0 }
    const projectDiff: ProjectSandboxDiff = diff
    const systemDiff: SystemSandboxDiff = projectDiff
    const applied: SystemSandboxApplyResult = { sandboxId: 'x', created: [], modified: [], deleted: [], skippedGit: false }
    const projectApplied: ProjectSandboxApplyResult = applied
    const systemApplied: SystemSandboxApplyResult = projectApplied
    expect([systemRecord.id, systemDiff.sandboxId, systemApplied.sandboxId]).toEqual(['x', 'x', 'x'])
  })
})
