import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  createToolCallableOperations,
  parseToolWireInput,
} from '../src/utils/toolkit/callable-operations'

type Context = { abortSignal: AbortSignal; available: boolean }

const echo = {
  name: 'demo:echo',
  schema: z.object({ text: z.string() }),
  permissions: ['fs:read', 'fs:read'],
  capabilities: { reason: '回显' },
  isAvailable: (context: Context) => context.available,
  execute: async (input: Record<string, unknown>, context: Context) => ({ text: input.text, aborted: context.abortSignal.aborted }),
}

describe('parseToolWireInput', () => {
  test('对象 schema 拒收未知字段，报错带字段路径与能力名；不是对象直接拒', () => {
    expect(parseToolWireInput(echo, { text: 'hi' }, '演示')).toEqual({ text: 'hi' })
    expect(() => parseToolWireInput(echo, { text: 'hi', extra: 1 }, '演示')).toThrow('演示能力的入参不合法')
    expect(() => parseToolWireInput(echo, { text: 1 }, '演示')).toThrow('text:')
    expect(() => parseToolWireInput(echo, 'hi', '演示')).toThrow('入参必须是对象')
  })
})

describe('createToolCallableOperations', () => {
  test('先解析入参再解析上下文：坏入参不会去问宿主要上下文', async () => {
    let resolved = 0
    const operations = createToolCallableOperations<Context>({ echo }, () => {
      resolved += 1
      return { abortSignal: new AbortController().signal, available: true }
    }, { label: '演示' })
    const operation = operations['demo:echo']!
    await expect(Promise.resolve(operation.invoke(undefined, { text: 1 }, new AbortController().signal))).rejects.toThrow('演示能力的入参不合法')
    expect(resolved).toBe(0)
    expect(await operation.invoke(undefined, { text: 'ok' }, new AbortController().signal)).toEqual({ text: 'ok', aborted: false })
    expect(resolved).toBe(1)
    expect(operation.metadata).toEqual({ permissions: ['fs:read'], reason: '回显' })
  })

  test('上下文里不可用报 UNAVAILABLE；工具抛的错交给 mapError；没有解析器一个都不登记；混进非工具值报 INVARIANT', async () => {
    const unavailable = createToolCallableOperations<Context>({ echo }, () => ({ abortSignal: new AbortController().signal, available: false }), { label: '演示' })
    await expect(Promise.resolve(unavailable['demo:echo']!.invoke(undefined, { text: 'x' }, new AbortController().signal))).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    const failing = { ...echo, execute: async () => { throw new Error('boom') } }
    const mapped = createToolCallableOperations<Context>({ failing }, () => ({ abortSignal: new AbortController().signal, available: true }), { label: '演示', mapError: () => new Error('mapped') })
    await expect(Promise.resolve(mapped['demo:echo']!.invoke(undefined, { text: 'x' }, new AbortController().signal))).rejects.toThrow('mapped')

    expect(createToolCallableOperations<Context>({ echo }, undefined, { label: '演示' })).toEqual({})
    expect(() => createToolCallableOperations<Context>({ broken: { name: 'x' } }, () => ({ abortSignal: new AbortController().signal, available: true }), { label: '演示' })).toThrow('不是可执行的工具规格')
  })
})
