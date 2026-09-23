import { describe, expect, test } from 'bun:test'

import { approvalContracts } from '../src/index'
const { createManualApprovalOptions } = approvalContracts

describe('manual approval contract', () => {
  test('pins explicit user interaction and disables decision reuse', () => {
    expect(
      createManualApprovalOptions({
        approvalRisk: 'high',
        riskScope: 'scheduled-task-delete:fixture',
      })
    ).toEqual({
      approvalRisk: 'high',
      riskScope: 'scheduled-task-delete:fixture',
      requireManualApproval: true,
      rememberRiskScope: false,
    })
  })
})
