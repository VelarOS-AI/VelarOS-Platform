/**
 * 演练沙箱公共规则的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { describe, expect, test } from 'bun:test'

import { RehearsalSandboxTuning } from '../src/utils/tuning'
import { rehearsalSandboxRules, SandboxApplyOperationKind, type SandboxDiff } from '../src/exports/index'

function diffOf(overrides: Partial<SandboxDiff> = {}): SandboxDiff {
  return { sandboxId: 's1', source: '/repo', created: [], modified: [], deleted: [], truncated: false, gitChanged: false, textDiffs: [], omittedDiffs: 0, fingerprint: 'fp1', ...overrides }
}

const base = { targetLabel: '/repo', closingNote: '删除和覆盖无法撤销。', riskScope: 'system-sandbox:apply' }

describe('落回前的核对与确认请求', () => {
  test('INV-1 截断的差量直接拒绝；条数与敏感路径按完整三列算，操作身份带指纹与条数', () => {
    expect(() => rehearsalSandboxRules.prepareApply({ ...base, diff: diffOf({ truncated: true, created: ['a'] }) })).toThrow('被截断')
    const created = Array.from({ length: RehearsalSandboxTuning.confirmation.previewItems + 2100 }, (_, index) => `new/${index}.txt`)
    const request = rehearsalSandboxRules.prepareApply({ ...base, diff: diffOf({ created, modified: ['.ssh/config'] }), isSensitive: (path) => path.startsWith('.ssh/') })
    expect(request?.message).toContain(`新增 ${created.length} 个`)
    expect(request?.message).toContain(`等 ${created.length} 个`)
    expect(request?.message).toContain('其中是系统敏感路径或凭证文件的：.ssh/config')
    expect(request?.selection.created).toHaveLength(created.length)
    const key = request?.options.operation?.key ?? ''
    expect(key.startsWith(`${SandboxApplyOperationKind}:`)).toBe(true)
    expect(key).toContain('fp1')
    const changed = rehearsalSandboxRules.prepareApply({ ...base, diff: diffOf({ created, modified: ['.ssh/config'], fingerprint: 'fp2' }) })
    expect(changed?.options.operation?.key).not.toBe(key)
  })

  test('INV-2 点名了没有变化的路径在问用户之前就拒绝；什么都没变返回 null', () => {
    expect(() => rehearsalSandboxRules.prepareApply({ ...base, diff: diffOf({ modified: ['a.ts'] }), paths: ['a.ts', 'ghost.ts'] })).toThrow('ghost.ts')
    expect(rehearsalSandboxRules.prepareApply({ ...base, diff: diffOf() })).toBeNull()
    expect(rehearsalSandboxRules.prepareApply({ ...base, diff: diffOf({ modified: ['a.ts'], deleted: ['b.ts'] }), paths: ['./a.ts'] })?.selection).toEqual({ created: [], modified: ['a.ts'], deleted: [], unknown: [] })
  })

  test('INV-3 落回的审批是高风险、手动、不可记忆', () => {
    const request = rehearsalSandboxRules.prepareApply({ ...base, diff: diffOf({ deleted: ['old.txt'] }) })
    expect(request?.options).toMatchObject({ approvalRisk: 'high', requireManualApproval: true, rememberRiskScope: false, riskScope: 'system-sandbox:apply', operation: { target: '/repo' } })
    expect(request?.message.endsWith('删除和覆盖无法撤销。')).toBe(true)
  })
})
