import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { projectToolFixture } from './support/tools'

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
