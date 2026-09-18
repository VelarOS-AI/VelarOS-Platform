import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { failureOf, projectSpaceFixture } from './support/space'

describe('项目空间里的审批', () => {
  test('项目里的危险命令：确认卡片点名原样的命令与工作目录，必须用户亲自点、不记住答案', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-approval-dangerous-'))
    try {
      let ran = false
      const { call, confirmations, mutations } = await projectSpaceFixture({
        root, approve: false,
        runCommand: async () => { ran = true; throw new Error('被拒的命令不该跑起来') },
      })
      expect((await failureOf(call('shell', 'run', { command: 'rm -rf ./dist' }))).code).toBe('PERMISSION')
      expect(confirmations).toHaveLength(1)
      expect(confirmations[0]!.options).toMatchObject({
        approvalRisk: 'high',
        riskScope: 'project-command:dangerous',
        // 任何权限档都要弹卡、也不记住答案：审批端口会用操作键覆盖 riskScope，只靠后缀挡不住自动放行。
        requireManualApproval: true,
        rememberRiskScope: false,
        operation: { label: 'rm -rf ./dist', target: root },
      })
      // 被拒之后既不再问项目的修改授权，也不起进程。
      expect(mutations).toEqual([])
      expect(ran).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
