import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, spyOn, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { projectFileOperations } from '../impl/operations/ProjectFileOperations'
import { createProjectObservationProvider } from '../impl/operations/ProjectObservationProvider'

import { projectToolFixture } from './support/tools'

test('snapshot plans preserve cross-project roots and reauthorize every real capture', async () => {
  const a = await mkdtemp(join(tmpdir(), 'snapshot-route-a-'))
  const b = await mkdtemp(join(tmpdir(), 'snapshot-route-b-'))
  try {
    await writeFile(join(a, 'file.txt'), 'A')
    await writeFile(join(b, 'file.txt'), 'B')
    const first = await projectToolFixture({ root: a })
    const second = await projectToolFixture({ root: b })
    const provider = createProjectObservationProvider()
    const plan = provider.prepare('files', {
      projectRoot: b,
      files: [{ path: 'file.txt', key: 'value', purpose: 'Observe the authorized project' }],
    })
    expect(plan.projectRoot).toBe(b)
    const reads = spyOn(second.kernel, 'read')
    try {
      await expect(projectFileOperations.snapshot(plan, first.context)).rejects.toThrow(
        '宿主未提供'
      )
      let allowed = true
      const modes: boolean[] = []
      first.context.resolveProject = async (requested, options) => {
        expect(requested).toBe(b)
        expect(options.currentProject).toBe(first.host)
        modes.push(options.write)
        if (!allowed) throw new AppError('PERMISSION', 'snapshot authorization revoked')
        return second.host
      }
      const captured = await projectFileOperations.snapshot(plan, first.context)
      expect(captured.root).toBe(b)
      expect(captured.value.files[0].text).toBe('B')
      expect(captured.readRequests).toBe(2)
      await writeFile(join(b, 'file.txt'), 'B changed')
      const nextPlan = provider.prepare('files', plan)
      expect(nextPlan.projectRoot).toBe(b)
      const next = await projectFileOperations.snapshot(nextPlan, first.context)
      expect(next.value.files[0].text).toBe('B changed')
      expect(next.fingerprint).not.toBe(captured.fingerprint)
      expect(reads).toHaveBeenCalledTimes(4)
      allowed = false
      await expect(projectFileOperations.snapshot(plan, first.context)).rejects.toThrow(
        'snapshot authorization revoked'
      )
      expect(modes).toEqual([false, false, false])
      expect(reads).toHaveBeenCalledTimes(4)
      first.context.resolveProject = async () => first.host
      await expect(projectFileOperations.snapshot(plan, first.context)).rejects.toThrow(
        '真实根不一致'
      )
      expect(reads).toHaveBeenCalledTimes(4)
      expect(await readFile(join(a, 'file.txt'), 'utf8')).toBe('A')
    } finally {
      reads.mockRestore()
    }
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test('snapshot preparation and capture reject unknown fields while preserving the default root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-default-'))
  try {
    await writeFile(join(root, 'file.txt'), 'current project')
    const f = await projectToolFixture({ root })
    const provider = createProjectObservationProvider()
    const plan = { files: [{ path: 'file.txt', key: 'value', purpose: 'Observe current project' }] }
    const prepared = provider.prepare('files', plan)
    expect(prepared).toEqual(plan)
    const captured = await projectFileOperations.snapshot(prepared, f.context)
    expect(captured.root).toBe(root)
    expect(captured.value.files[0].text).toBe('current project')
    const reads = spyOn(f.kernel, 'read')
    try {
      const unknown = { ...plan, unexpected: true }
      expect(() => provider.prepare('files', unknown)).toThrow('只接受 files 和 projectRoot')
      await expect(projectFileOperations.snapshot(unknown, f.context)).rejects.toThrow(
        '只接受 files 和 projectRoot'
      )
      const unknownEntry = { files: [{ ...plan.files[0], unexpected: true }] }
      expect(() => provider.prepare('files', unknownEntry)).toThrow('含未知字段')
      await expect(projectFileOperations.snapshot(unknownEntry, f.context)).rejects.toThrow(
        '含未知字段'
      )
      for (const projectRoot of ['', '../relative'])
        await expect(
          projectFileOperations.snapshot({ ...plan, projectRoot }, f.context)
        ).rejects.toThrow('项目绝对路径')
      for (const projectRoot of ['', '../relative', null, 123]) {
        const invalid = { ...plan, projectRoot }
        expect(() => provider.prepare('files', invalid)).toThrow('项目绝对路径')
      }
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cross-project operations require host authorization and preserve root-bound undo', async () => {
  const a = await mkdtemp(join(tmpdir(), 'route-a-'))
  const b = await mkdtemp(join(tmpdir(), 'route-b-'))
  try {
    await writeFile(join(a, 'file.txt'), 'A')
    await writeFile(join(b, 'file.txt'), 'B')
    const first = await projectToolFixture({ root: a })
    const second = await projectToolFixture({ root: b })
    const input = { projectRoot: b, files: [{ path: 'file.txt' }] }
    await expect(first.call('project', 'read', input)).rejects.toThrow('宿主未提供')
    const modes: boolean[] = []
    first.context.resolveProject = async (root, options) => {
      expect(root).toBe(b)
      modes.push(options.write)
      return second.host
    }
    expect((await first.call('project', 'read', input)).files[0].text).toBe('B')
    const changed = await first.call('project', 'edit', {
      projectRoot: b,
      steps: [{ action: 'write', path: 'file.txt', text: 'new', expectedText: 'B' }],
    })
    expect(await readFile(join(a, 'file.txt'), 'utf8')).toBe('A')
    expect(await readFile(join(b, 'file.txt'), 'utf8')).toBe('new')
    await expect(first.call('project', 'undo', { changeRef: changed.changeRef })).rejects.toThrow(
      '另一个项目'
    )
    await first.call('project', 'undo', { projectRoot: b, changeRef: changed.changeRef })
    expect(await readFile(join(b, 'file.txt'), 'utf8')).toBe('B')
    expect(modes).toEqual([false, true, true])
    first.context.resolveProject = async () => first.host
    await expect(first.call('project', 'read', input)).rejects.toThrow('真实根不一致')
    first.context.resolveProject = async () => {
      throw new Error('revoked authorization')
    }
    await expect(first.call('project', 'read', input)).rejects.toThrow('revoked authorization')
    await expect(
      first.call('project', 'read', { ...input, projectRoot: '../relative' })
    ).rejects.toThrow('绝对路径')
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test('authorized project cannot escape through a link and cancellation prevents dispatch', async () => {
  const a = await mkdtemp(join(tmpdir(), 'route-safe-a-'))
  const b = await mkdtemp(join(tmpdir(), 'route-safe-b-'))
  try {
    await writeFile(join(a, 'secret.txt'), 'untouched')
    await symlink(a, join(b, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const first = await projectToolFixture({ root: a })
    const second = await projectToolFixture({ root: b })
    first.context.resolveProject = async () => second.host
    await expect(
      first.call('project', 'edit', {
        projectRoot: b,
        steps: [{ action: 'write', path: 'escape/secret.txt', text: 'escaped' }],
      })
    ).rejects.toThrow()
    expect(await readFile(join(a, 'secret.txt'), 'utf8')).toBe('untouched')
    const controller = new AbortController()
    first.context.abortSignal = controller.signal
    first.context.resolveProject = async () => {
      controller.abort(new Error('cancel during authorization'))
      return second.host
    }
    await expect(
      first.call('project', 'edit', {
        projectRoot: b,
        steps: [{ action: 'write', path: 'new.txt', text: 'not written' }],
      })
    ).rejects.toThrow('cancel during authorization')
    await expect(readFile(join(b, 'new.txt'))).rejects.toThrow()
  } finally {
    await rm(b, { recursive: true, force: true })
    await rm(a, { recursive: true, force: true })
  }
})

test('explicit current root borrows its kernel while preserving authorization and restricted ports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'route-current-'))
  try {
    await writeFile(join(root, 'file.txt'), 'before')
    const f = await projectToolFixture({ root })
    const ports: unknown[] = []
    const kernels: unknown[] = []
    let revoked = false
    f.context.resolveProject = async (requested, options) => {
      expect(requested).toBe(root)
      expect(options.currentProject).toBe(f.context.project)
      ports.push(options.currentProject)
      kernels.push(await options.currentProject.kernel())
      if (revoked) throw new Error('revoked current root')
      return options.currentProject
    }
    await Promise.all(
      Array.from({ length: 4 }, () =>
        f.call('project', 'read', {
          projectRoot: root,
          files: [{ path: 'file.txt' }],
        })
      )
    )
    const change = await f.call('project', 'edit', {
      projectRoot: root,
      steps: [{ action: 'write', path: 'file.txt', text: 'after', expectedText: 'before' }],
    })
    await f.call('project', 'undo', { changeRef: change.changeRef })
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('before')
    expect(ports.length).toBe(5)
    expect(new Set(kernels).size).toBe(1)
    revoked = true
    await expect(
      f.call('project', 'read', {
        projectRoot: root,
        files: [{ path: 'file.txt' }],
      })
    ).rejects.toThrow('revoked current root')
    f.context.resolveProject = async (_root, { currentProject }) => ({
      ...currentProject,
      kernel: async () => {
        throw new Error('restricted wrapper')
      },
    })
    await expect(
      f.call('project', 'read', {
        projectRoot: root,
        files: [{ path: 'file.txt' }],
      })
    ).rejects.toThrow('restricted wrapper')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
