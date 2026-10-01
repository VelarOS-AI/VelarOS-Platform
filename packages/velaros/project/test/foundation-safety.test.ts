import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type {
  RehearsalSandboxHostPort,
  SandboxOperationContext,
} from '../../sandbox/contract/requires'
import { sandboxOperations } from '../../sandbox/impl/SandboxOperations'
import type { ProjectHostPort, ProjectOperationContext } from '../contract/requires'
import { createProjectKernel } from '../impl/kernel/LocalProjectKernel'
import {
  ProjectCapabilityPorts,
  projectCapabilityPorts,
} from '../impl/operations/ProjectCapabilityPorts'
import { ProjectExecutionGate } from '../impl/operations/ProjectExecutionGate'
import { projectFileOperations } from '../impl/operations/ProjectFileOperations'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-foundation-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('post-commit hook diagnostics preserve applied receipt and undo', async () => {
  await writeFile(join(root, 'note.txt'), 'before')
  const kernel = await createProjectKernel({ root })
  kernel.registerHook({
    id: 'after-failure',
    event: 'AfterApplyEdit',
    run: () => {
      throw new AppError('HOOK_FAILED', 'original hook failure')
    },
  })
  const ctx: ProjectOperationContext = {
    abortSignal: new AbortController().signal,
    sessionId: 'foundation',
    project: { getRootPath: () => root, kernel: async () => kernel },
  }
  const result = await projectFileOperations.edit(
    { steps: [{ action: 'write', path: 'note.txt', text: 'after' }] },
    ctx
  )
  expect(result.changeRef).toStartWith('change:')
  expect(result.notes?.join(' ')).toContain('original hook failure')
  expect(result.notes?.join(' ')).toContain('HOOK_FAILED')
  expect((await projectFileOperations.inspect({ changeRef: result.changeRef }, ctx)).status).toBe(
    'applied'
  )
  await projectFileOperations.undo({ changeRef: result.changeRef }, ctx)
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before')
})

test('all project sandbox handle operations reject a known foreign source', async () => {
  const foreign = join(root, 'a')
  const current = join(root, 'b')
  await mkdir(foreign)
  await mkdir(current)
  let effects = 0
  const host = {
    diffSandbox: async () => ({
      sandboxId: 'known-id',
      source: foreign,
      created: ['x'],
      modified: [],
      deleted: [],
      gitChanged: false,
      textDiffs: [],
      omittedDiffs: 0,
    }),
    applySandbox: async () => {
      effects++
      return {}
    },
    runInSandbox: async () => {
      effects++
      return {}
    },
    discardSandbox: async () => {
      effects++
      return {}
    },
  } as unknown as RehearsalSandboxHostPort
  const signal = new AbortController().signal
  const port = projectCapabilityPorts.sandbox(
    { getRootPath: () => current, sandbox: host } as ProjectHostPort,
    signal
  )
  for (const invoke of [
    () => port.diffSandbox({ sandboxId: 'known-id' }),
    () => port.applySandbox({ sandboxId: 'known-id' }),
    () => port.runInSandbox({ sandboxId: 'known-id', command: 'true' }),
    () => port.discardSandbox('known-id'),
  ]) {
    await expect(invoke()).rejects.toMatchObject({ code: 'PERMISSION' })
  }
  expect(effects).toBe(0)
})

test('sandbox cancellation while diffing prevents apply', async () => {
  const abort = new AbortController()
  let applied = false
  const ctx = {
    abortSignal: abort.signal,
    approval: {},
    sandbox: {
      diffSandbox: async () => {
        abort.abort()
        return { created: ['a'], modified: [], deleted: [], gitChanged: false }
      },
      applySandbox: async () => {
        applied = true
        return {}
      },
    },
  } as unknown as SandboxOperationContext
  await expect(sandboxOperations.apply({ id: 'known-id' }, ctx)).rejects.toBeDefined()
  expect(applied).toBe(false)
})

test('before-commit hook failures preserve the original diagnostic and write nothing', async () => {
  await writeFile(join(root, 'note.txt'), 'before')
  const kernel = await createProjectKernel({ root })
  kernel.registerHook({
    id: 'before-failure',
    event: 'BeforeApplyEdit',
    run: () => {
      throw new AppError('HOOK_FAILED', 'before original')
    },
  })
  const ctx: ProjectOperationContext = {
    abortSignal: new AbortController().signal,
    sessionId: 'before-foundation',
    project: { getRootPath: () => root, kernel: async () => kernel },
  }
  await expect(
    projectFileOperations.edit(
      { steps: [{ action: 'write', path: 'note.txt', text: 'after' }] },
      ctx
    )
  ).rejects.toMatchObject({
    code: 'HOOK_FAILED',
    message: expect.stringContaining('before original'),
  })
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before')
})
test('cancellation during validation prevents project commit', async () => {
  await writeFile(join(root, 'note.txt'), 'before')
  const kernel = await createProjectKernel({ root })
  const abort = new AbortController()
  kernel.registerHook({
    id: 'cancel-validation',
    event: 'BeforeValidate',
    run: async () => {
      await Promise.resolve()
      abort.abort()
    },
  })
  const ctx: ProjectOperationContext = {
    abortSignal: abort.signal,
    sessionId: 'cancel-foundation',
    project: { getRootPath: () => root, kernel: async () => kernel },
  }
  await expect(
    projectFileOperations.edit(
      { steps: [{ action: 'write', path: 'note.txt', text: 'after' }] },
      ctx
    )
  ).rejects.toBeDefined()
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before')
})
test('late cancellation and after-rollback failure retain committed and undone facts', async () => {
  await writeFile(join(root, 'note.txt'), 'before')
  const kernel = await createProjectKernel({ root })
  const abort = new AbortController()
  kernel.registerHook({
    id: 'cancel-after',
    event: 'AfterApplyEdit',
    run: () => {
      abort.abort()
    },
  })
  kernel.registerHook({
    id: 'rollback-failure',
    event: 'AfterRollback',
    run: () => {
      throw new AppError('ROLLBACK_HOOK', 'rollback original')
    },
  })
  const ctx: ProjectOperationContext = {
    abortSignal: abort.signal,
    sessionId: 'late-foundation',
    project: { getRootPath: () => root, kernel: async () => kernel },
  }
  const result = await projectFileOperations.edit(
    { steps: [{ action: 'write', path: 'note.txt', text: 'after' }] },
    ctx
  )
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after')
  const live = { ...ctx, abortSignal: new AbortController().signal }
  const undone = await projectFileOperations.undo({ changeRef: result.changeRef }, live)
  expect(undone.notes?.join(' ')).toContain('ROLLBACK_HOOK')
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('before')
  expect(
    (await projectFileOperations.undo({ changeRef: result.changeRef }, live)).alreadyUndone
  ).toBe(true)
})
test('sandbox apply waits for the same project write gate and queued cancellation invokes no host', async () => {
  const gate = new ProjectExecutionGate()
  const abort = new AbortController()
  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = gate.run(root, true, new AbortController().signal, async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await enteredPromise
  let effects = 0
  const host = {
    getSandboxRecord: async () => ({ source: root }),
    applySandbox: async () => {
      effects++
      return {}
    },
  } as unknown as RehearsalSandboxHostPort
  const port = new ProjectCapabilityPorts(gate).sandbox(
    { getRootPath: () => root, sandbox: host } as ProjectHostPort,
    abort.signal
  )
  const pending = port.applySandbox({ sandboxId: 'known-id' })
  abort.abort()
  await expect(pending).rejects.toBeDefined()
  expect(effects).toBe(0)
  release()
  await blocked
  const live = new ProjectCapabilityPorts(gate).sandbox(
    { getRootPath: () => root, sandbox: host } as ProjectHostPort,
    new AbortController().signal
  )
  await live.applySandbox({ sandboxId: 'known-id' })
  expect(effects).toBe(1)
})
test('a missing sandbox is an idempotent discard without dispatching a delete', async () => {
  let deletes = 0
  const host = {
    getSandboxRecord: async () => {
      throw new AppError('NOT_FOUND', 'gone')
    },
    discardSandbox: async () => {
      deletes++
      return {}
    },
  } as unknown as RehearsalSandboxHostPort
  const port = projectCapabilityPorts.sandbox(
    { getRootPath: () => root, sandbox: host } as ProjectHostPort,
    new AbortController().signal
  )
  expect(await port.discardSandbox('known-id')).toEqual({ sandboxId: 'known-id', removed: false })
  expect(deletes).toBe(0)
})
