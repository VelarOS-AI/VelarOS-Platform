import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { InMemoryContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import {
  resolveToolInputReuse,
  saveToolAttemptInput,
  saveToolAttemptOutcome,
  withToolInputReuse,
} from '../src/tools/recovery/ToolInputReuse'

const toolName = 'project:edit'
function context(store = new InMemoryContextPayloadStore(), root = '/repo') {
  return { sessionId: 's', contextPayloadStore: store, project: { getRootPath: () => root } }
}
const input = {
  edits: [{ path: 'a.ts', oldText: 'wrong', newText: '中文🙂\\path\r\n'.repeat(20_000) }],
}
const retry = {
  reuse: 'attempt:first',
  changes: [{ op: 'set', path: ['edits', 0, 'oldText'], value: 'right' }],
}

describe('tool input reuse', () => {
  test('changes one field in a large immutable input and preserves exact Unicode and escapes across restart', async () => {
    const ctx = context()
    await saveToolAttemptInput(ctx, 'first', toolName, input)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    const restored = await resolveToolInputReuse(context(ctx.contextPayloadStore), toolName, retry)
    expect(restored).toEqual({ edits: [{ ...input.edits[0], oldText: 'right' }] })
    expect(input.edits[0]!.oldText).toBe('wrong')
    expect(JSON.stringify(retry).length / JSON.stringify(input).length).toBeLessThan(0.001)
    expect(
      withToolInputReuse(z.strictObject({ edits: z.array(z.unknown()) })).safeParse(retry).success
    ).toBe(true)
  })
  test('requires a settled not-applied receipt and matching session, workspace and tool', async () => {
    for (const outcome of ['completed', 'unknown', undefined] as const) {
      const ctx = context()
      await saveToolAttemptInput(ctx, 'first', toolName, input)
      if (outcome) await saveToolAttemptOutcome(ctx, 'first', outcome)
      await expect(resolveToolInputReuse(ctx, toolName, retry)).rejects.toThrow()
    }
    const ctx = context()
    await saveToolAttemptInput(ctx, 'first', toolName, input)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    await expect(
      resolveToolInputReuse(context(ctx.contextPayloadStore, '/other'), toolName, retry)
    ).rejects.toThrow()
    await expect(
      resolveToolInputReuse({ ...ctx, sessionId: 'other' }, toolName, retry)
    ).rejects.toThrow()
    await expect(resolveToolInputReuse(ctx, 'project:write', retry)).rejects.toThrow()
  })
  test('validates paths without prototype traversal, implicit parents or array holes', async () => {
    const ctx = context()
    await saveToolAttemptInput(ctx, 'first', toolName, input)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    for (const path of [
      ['__proto__', 'polluted'],
      ['edits', 99],
      ['missing', 'value'],
      ['edits', '0'],
      ['constructor'],
    ]) {
      await expect(
        resolveToolInputReuse(ctx, toolName, {
          ...retry,
          changes: [{ op: 'set', path, value: true }],
        })
      ).rejects.toThrow()
    }
    const removed = await resolveToolInputReuse(ctx, toolName, {
      ...retry,
      changes: [{ op: 'remove', path: ['edits', 0, 'oldText'] }],
    })
    expect((removed.edits as Array<Record<string, unknown>>)[0]!.oldText).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

test('reuse schema keeps an object provider contract and native defaults', () => {
  const wrapped = withToolInputReuse(
    z.strictObject({ content: z.string(), limit: z.number().default(10) })
  )
  expect(wrapped.parse(retry)).toEqual(retry)
  expect(z.toJSONSchema(wrapped, { io: 'input' }).type).toBe('object')
  expect(wrapped.parse({ content: 'hello' })).toEqual({ content: 'hello', limit: 10 })
  expect(wrapped.safeParse({ content: 'hello', ...retry }).success).toBe(false)
})

test('reuse restores before business refinements and retains strict unknown-field checks', () => {
  const schema = z.strictObject({
    action: z.enum(['apply', 'inspect']),
    text: z.string().optional(),
    ref: z.string().optional(),
  }).superRefine((value, context) => {
    if (value.action === 'apply' ? value.text === undefined || value.ref !== undefined : !value.ref || value.text !== undefined)
      context.addIssue({ code: 'custom', message: 'action fields disagree' })
  })
  const wrapped = withToolInputReuse(schema)
  expect(wrapped.parse(retry)).toEqual(retry)
  expect(wrapped.parse({ action: 'apply', text: '正文' })).toEqual({ action: 'apply', text: '正文' })
  expect(wrapped.safeParse({ action: 'apply' }).success).toBe(false)
  expect(wrapped.safeParse({ action: 'inspect', ref: 'receipt', text: 'wrong' }).success).toBe(false)
  expect(wrapped.safeParse({ action: 'apply', text: '正文', unexpected: true }).success).toBe(false)
})

test('one failed attempt admits only one execution, including concurrent retries and restart', async () => {
  const ctx = context()
  await saveToolAttemptInput(ctx, 'first', toolName, input)
  await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
  const results = await Promise.allSettled([
    resolveToolInputReuse(ctx, toolName, retry, 'second'),
    resolveToolInputReuse(ctx, toolName, retry, 'duplicate'),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  await expect(
    resolveToolInputReuse(context(ctx.contextPayloadStore), toolName, retry, 'after-restart')
  ).rejects.toThrow('already has a retry')
})

describe('trusted saved input contract migration', () => {
  test('migrates patched saved parameters with trusted provenance before admitting a retry', async () => {
    const ctx = context()
    await saveToolAttemptInput(ctx, 'first', toolName, input)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    const seen: unknown[] = []
    const restored = await resolveToolInputReuse(ctx, toolName, retry, 'second', {
      inputContractVersion: 2,
      migrateReusedInput: (request) => {
        seen.push(request)
        return { files: request.input.edits }
      },
    })
    expect(restored).toEqual({ files: [{ ...input.edits[0], oldText: 'right' }] })
    expect(seen[0]).toMatchObject({
      sourceContractVersion: 1, targetContractVersion: 2,
      sourceToolName: toolName, sourceCallId: 'first', toolCallId: 'second',
    })
    expect(input.edits[0]!.oldText).toBe('wrong')
    await expect(resolveToolInputReuse(ctx, toolName, retry, 'duplicate')).rejects.toThrow('already has a retry')
  })

  test('migration failure preserves the source attempt so the next retry only supplies missing fields', async () => {
    const ctx = context()
    await saveToolAttemptInput(ctx, 'first', toolName, input)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    const options = {
      inputContractVersion: 2,
      migrateReusedInput: ({ input: restored }: { input: Record<string, unknown> }) => {
        if (!restored.fileRef) throw new Error('Read the target and add fileRef to saved input')
        return { fileRef: restored.fileRef, files: restored.edits }
      },
    }
    await expect(resolveToolInputReuse(ctx, toolName, retry, 'needs-reference', options)).rejects.toThrow('add fileRef')
    const fixed = await resolveToolInputReuse(ctx, toolName, {
      ...retry,
      changes: [...retry.changes, { op: 'set', path: ['fileRef'], value: 'view:read-source' }],
    }, 'fixed', options)
    expect(fixed).toMatchObject({ fileRef: 'view:read-source' })
    expect((fixed.files as Array<{ newText: string }>)[0]!.newText).toBe(input.edits[0]!.newText)
  })

  test('never migrates fresh input or lets model fields spoof source provenance', async () => {
    const ctx = context()
    let migrations = 0
    const options = { inputContractVersion: 2, migrateReusedInput: () => { migrations++; return {} } }
    const fresh = { ...input, inputContractVersion: 1, sourceToolName: 'allowed:legacy' }
    expect(await resolveToolInputReuse(ctx, toolName, fresh, 'fresh', options)).toBe(fresh)
    expect(migrations).toBe(0)
    expect(withToolInputReuse(z.strictObject({ files: z.array(z.unknown()) })).safeParse(fresh).success).toBe(false)
    await saveToolAttemptInput(ctx, 'first', toolName, input, 2)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    const restored = await resolveToolInputReuse(ctx, toolName, {
      ...retry, changes: [{ op: 'set', path: ['sourceContractVersion'], value: 1 }],
    }, 'second', options)
    expect(restored.sourceContractVersion).toBe(1)
    expect(migrations).toBe(0)
  })

  test('only trusted runtime aliases can migrate input from renamed tools', async () => {
    const ctx = context()
    await saveToolAttemptInput(ctx, 'first', 'project:write', input)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    let migratedSource = ''
    const options = {
      inputContractVersion: 2,
      migrateReusedInput: (request: { sourceToolName: string; input: Record<string, unknown> }) => {
        migratedSource = request.sourceToolName
        return { files: request.input.edits }
      },
    }
    await expect(resolveToolInputReuse(ctx, toolName, retry, 'untrusted', options)).rejects.toThrow('different tool')
    expect(migratedSource).toBe('')
    await resolveToolInputReuse(ctx, toolName, retry, 'trusted', { ...options, inputReuseSourceTools: ['project:write'] })
    expect(migratedSource).toBe('project:write')
  })

  test('checks settled outcome and resource scope before exposing input to a migrator', async () => {
    let migrations = 0
    const options = { inputContractVersion: 2, migrateReusedInput: () => { migrations++; return {} } }
    for (const outcome of ['unknown', 'completed'] as const) {
      const ctx = context()
      await saveToolAttemptInput(ctx, 'first', toolName, input)
      await saveToolAttemptOutcome(ctx, 'first', outcome)
      await expect(resolveToolInputReuse(ctx, toolName, retry, 'retry', options)).rejects.toThrow('may already have applied')
    }
    const ctx = { sessionId: 's', resourceId: 'resource:one', contextPayloadStore: new InMemoryContextPayloadStore() }
    await saveToolAttemptInput(ctx, 'first', toolName, input)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    await expect(resolveToolInputReuse({ ...ctx, resourceId: 'resource:two' }, toolName, retry, 'retry', options)).rejects.toThrow('resource scope')
    expect(migrations).toBe(0)
    expect(await resolveToolInputReuse(ctx, toolName, retry)).toMatchObject({ edits: [{ oldText: 'right' }] })
    const legacy = { sessionId: 'legacy', contextPayloadStore: new InMemoryContextPayloadStore() }
    await saveToolAttemptInput(legacy, 'first', toolName, input)
    await saveToolAttemptOutcome(legacy, 'first', 'not-applied')
    await expect(resolveToolInputReuse({ ...legacy, resourceId: 'resource:one' }, toolName, retry, 'retry', options)).rejects.toThrow('no verified resource scope')
    expect(migrations).toBe(0)
  })

  test('newly saved contract versions survive restart and mismatches require explicit migration', async () => {
    const ctx = context()
    await saveToolAttemptInput(ctx, 'first', toolName, input, 2)
    await saveToolAttemptOutcome(ctx, 'first', 'not-applied')
    await expect(resolveToolInputReuse(context(ctx.contextPayloadStore), toolName, retry)).rejects.toThrow('contract 2')
    expect(await resolveToolInputReuse(context(ctx.contextPayloadStore), toolName, retry, 'second', { inputContractVersion: 2 })).toEqual({ edits: [{ ...input.edits[0], oldText: 'right' }] })
  })
})
