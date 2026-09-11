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

  test('preserves independent domain details through an AppError cause', () => {
    const domainError = Object.assign(new Error('事务应用后文件已被外部修改'), {
      reason: 'CONFLICT_WITH_EXTERNAL_EDIT',
      details: {
        path: 'src/a.ts',
        expectedRevision: 'rev_expected',
        actualRevision: 'rev_actual',
      },
      suggestedNextAction: '请重新读取冲突文件并人工合并。',
    })

    const result = buildExecutionFailureResult('project:rollback', AppError.from(domainError))

    expect(result).toMatchObject({
      error: 'tool_execution_failed',
      code: 'CONFLICT_WITH_EXTERNAL_EDIT',
      details: {
        reason: 'CONFLICT_WITH_EXTERNAL_EDIT',
        code: 'CONFLICT_WITH_EXTERNAL_EDIT',
        path: 'src/a.ts',
        expectedRevision: 'rev_expected',
        actualRevision: 'rev_actual',
      },
    })
    expect(result.nextActions).toEqual(['请重新读取冲突文件并人工合并。'])
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

  test('bounds an oversized domain diagnostics array while keeping the original count', () => {
    const diagnostics = Array.from({ length: 43 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      message: `诊断条目 ${index}`,
    }))
    const domainError = Object.assign(new Error('校验失败：存在多条诊断'), {
      reason: 'VALIDATION_FAILED',
      details: { diagnostics, checks: ['a', 'b'] },
      suggestedNextAction: '逐条修复 diagnostics 后重试。',
    })

    const result = buildExecutionFailureResult('project:edit', AppError.from(domainError))

    const boundedDiagnostics = (result.details?.diagnostics as unknown[]) ?? []
    expect(boundedDiagnostics).toHaveLength(11)
    expect(boundedDiagnostics[0]).toMatchObject({ path: 'src/file-0.ts' })
    expect(boundedDiagnostics[10]).toMatchObject({
      __truncatedItems: 33,
      originalLength: 43,
    })
    expect(result.details).toMatchObject({ checks: ['a', 'b'] })
  })

  test('truncates an oversized domain string field in details', () => {
    const longMessage = 'x'.repeat(5_000)
    const domainError = Object.assign(new Error('冲突'), {
      reason: 'CONFLICT_WITH_EXTERNAL_EDIT',
      details: { path: 'src/a.ts', excerpt: longMessage },
    })

    const result = buildExecutionFailureResult('project:rollback', AppError.from(domainError))

    const excerpt = result.details?.excerpt as string
    expect(excerpt.length).toBeLessThan(longMessage.length)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  test('bounds deeply nested details without throwing', () => {
    let nested: Record<string, unknown> = { leaf: 'bottom' }
    for (let i = 0; i < 10; i++) nested = { child: nested }
    const domainError = Object.assign(new Error('深层结构'), {
      reason: 'VALIDATION_FAILED',
      details: nested,
    })

    const result = buildExecutionFailureResult('project:edit', AppError.from(domainError))

    expect(() => JSON.stringify(result)).not.toThrow()
    expect(JSON.stringify(result)).toContain('depth limit')
  })

  test('safely handles a BigInt value nested in domain details', () => {
    // BigInt 是 JSON.stringify 会直接抛错的基础类型，用它验证有界投影确实让结果可安全序列化。
    const domainError = Object.assign(new Error('携带 BigInt 字段'), {
      reason: 'VALIDATION_FAILED',
      details: { path: 'src/a.ts', size: 9_007_199_254_740_993n },
    })

    const result = buildExecutionFailureResult('project:edit', AppError.from(domainError))

    expect(() => JSON.stringify(result)).not.toThrow()
    expect(result.details?.size).toBe('9007199254740993n')
  })

  test('safely handles a circular reference nested in domain details', () => {
    const circular: Record<string, unknown> = { path: 'src/a.ts' }
    circular.self = circular
    const domainError = Object.assign(new Error('携带循环引用字段'), {
      reason: 'VALIDATION_FAILED',
      details: { wrapper: circular },
    })

    const result = buildExecutionFailureResult('project:edit', AppError.from(domainError))

    expect(() => JSON.stringify(result)).not.toThrow()
    expect(result.details?.wrapper).toMatchObject({ self: '[circular reference omitted]' })
  })

  test('preserves diagnostics from the kernel-module projectCapabilityError shape (AppError with a ProjectError cause and context.projectError)', () => {
    // 复刻 packages/project/src/kernel-module.ts 里 projectCapabilityError 的构造方式：
    // AppError.code 已被提升为领域 reason，cause 是原始 ProjectError，
    // context.projectError 是它的序列化镜像。
    class FakeProjectError extends Error {
      reason = 'VALIDATION_FAILED'
      details = {
        diagnostics: Array.from({ length: 15 }, (_, index) => ({ rule: `rule-${index}` })),
      }
      suggestedNextAction = '按 diagnostics 逐条修复。'
      constructor() {
        super('校验失败')
        this.name = 'ProjectError'
      }
    }
    const domainError = new FakeProjectError()
    const appError = new AppError(domainError.reason, domainError.message, domainError, {
      projectError: {
        name: domainError.name,
        reason: domainError.reason,
        message: domainError.message,
        details: domainError.details,
        suggestedNextAction: domainError.suggestedNextAction,
      },
    })

    const result = buildExecutionFailureResult('project:edit', appError)

    expect(result.code).toBe('VALIDATION_FAILED')
    const diagnostics = (result.details?.diagnostics as unknown[]) ?? []
    expect(diagnostics).toHaveLength(11)
    expect(diagnostics[10]).toMatchObject({ __truncatedItems: 5, originalLength: 15 })
    expect(result.nextActions).toEqual(['按 diagnostics 逐条修复。'])
  })

  test('recovers diagnostics from context.projectError after an AppError JSON round trip drops cause (cross-Kernel boundary)', () => {
    // AppError.toJSON 不携带 cause，fromJSON 重建的错误 cause 恒为 undefined——这正是
    // 一次跨 Kernel/IPC 边界（例如通过消息通道转发）之后的真实形态。上一条用例只覆盖了
    // 进程内 cause 链完好的情况，从未真正触发过 context.projectError 回退路径。
    class FakeProjectError extends Error {
      reason = 'VALIDATION_FAILED'
      details = {
        diagnostics: Array.from({ length: 15 }, (_, index) => ({ rule: `rule-${index}` })),
      }
      suggestedNextAction = '按 diagnostics 逐条修复。'
      constructor() {
        super('校验失败')
        this.name = 'ProjectError'
      }
    }
    const domainError = new FakeProjectError()
    const appError = new AppError(domainError.reason, domainError.message, domainError, {
      projectError: {
        name: domainError.name,
        reason: domainError.reason,
        message: domainError.message,
        details: domainError.details,
        suggestedNextAction: domainError.suggestedNextAction,
      },
    })

    const crossed = AppError.fromJSON(JSON.parse(JSON.stringify(appError.toJSON())))
    expect(crossed.cause).toBeUndefined()

    const result = buildExecutionFailureResult('project:edit', crossed)

    expect(result.code).toBe('VALIDATION_FAILED')
    const diagnostics = (result.details?.diagnostics as unknown[]) ?? []
    expect(diagnostics).toHaveLength(11)
    expect(diagnostics[10]).toMatchObject({ __truncatedItems: 5, originalLength: 15 })
    expect(result.nextActions).toEqual(['按 diagnostics 逐条修复。'])
  })

  test('projects a Date value in domain details through its toJSON instead of silently losing it as {}', () => {
    // isPlainObject 把 Date 当普通记录按自有可枚举属性遍历——Date 没有可枚举属性，
    // 不特殊处理就会静默变成 {}。
    const domainError = Object.assign(new Error('携带 Date 字段'), {
      reason: 'VALIDATION_FAILED',
      details: { occurredAt: new Date('2026-01-01T00:00:00.000Z') },
    })

    const result = buildExecutionFailureResult('project:edit', AppError.from(domainError))

    expect(result.details?.occurredAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('bounds a domain details object with an unbounded number of keys', () => {
    const newRevisions: Record<string, string> = {}
    for (let i = 0; i < 500; i++) newRevisions[`src/file-${i}.ts`] = `rev_${i}`
    const domainError = Object.assign(new Error('多文件修订'), {
      reason: 'VALIDATION_FAILED',
      details: { newRevisions },
    })

    const result = buildExecutionFailureResult('project:edit', AppError.from(domainError))

    const boundedRevisions = result.details?.newRevisions as Record<string, unknown>
    expect(Object.keys(boundedRevisions)).toHaveLength(52)
    expect(boundedRevisions.__truncatedKeys).toBe(450)
    expect(boundedRevisions.__originalKeyCount).toBe(500)
    expect(() => JSON.stringify(result)).not.toThrow()
  })
})
