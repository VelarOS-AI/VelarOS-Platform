import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import {
  buildExecutionFailureResult,
  buildToolFailureResult,
} from '../src/tools/ExecutionPolicyFailures'

describe('tool execution failure projection', () => {
  test('promotes an independent domain reason when the generic wrapper is UNKNOWN', () => {
    const domainError = Object.assign(new Error('路径解析后越出工作区根目录'), {
      reason: 'PERMISSION_DENIED',
      suggestedNextAction:
        '该路径通过符号链接指向工作区外部；请切换到目标包的真实工作区，不要改搜父目录。',
    })

    const result = buildExecutionFailureResult('project:search', AppError.from(domainError))

    expect(result).toMatchObject({
      error: 'tool_denied',
      code: 'PERMISSION_DENIED',
      details: {
        reason: 'PERMISSION_DENIED',
        code: 'PERMISSION_DENIED',
      },
    })
    expect(result.nextActions).toEqual([
      '该路径通过符号链接指向工作区外部；请切换到目标包的真实工作区，不要改搜父目录。',
    ])
  })

  test('preserves runtime diagnosis when an embedded failure crosses the AppError boundary', () => {
    const embedded = buildToolFailureResult(
      'schema_validation_failed',
      '参数结构不符合 browser:evaluate_script 的 schema',
      'browser:evaluate_script',
      { nextActions: ['按当前可见 schema 重建参数。'] }
    )
    const result = buildExecutionFailureResult(
      'browser:evaluate_script',
      new AppError('VALIDATION', 'Tool arguments validation failed', undefined, {
        toolFailure: embedded,
      })
    )

    expect(result.runtimeToolIssue).toEqual(embedded.runtimeToolIssue)
    expect(result.nextActions).toEqual(embedded.nextActions)
    expect(
      result.nextActions?.filter((action) => action.startsWith('先归因本次工具问题'))
    ).toHaveLength(1)
  })
})
