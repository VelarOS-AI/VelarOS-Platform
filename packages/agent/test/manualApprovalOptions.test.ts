import { describe, expect, test } from 'bun:test'

import { createManualApprovalOptions } from '../src/tool-contract'

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
