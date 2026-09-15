import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createLocalSystemKernel } from '../src/impl/LocalSystemKernel.js'
import { systemCommandPolicy } from '../src/impl/SystemCommandPolicy.js'
import { systemFileOperations } from '../src/impl/SystemFileOperations.js'
import { SystemGlobalSearch } from '../src/impl/SystemGlobalSearch.js'
import { systemTools } from '../src/impl/SystemTools.js'
import type { SystemToolContext } from '../src/interface/requires.js'
import { buildSystemProcessConfinementSpawnSpec, buildSystemSeatbeltProfile } from '../src/utils/confinement.js'
import { isCredentialPath, isSensitiveSystemMutationPath } from '../src/utils/file-safety.js'
import { findOccurrences } from '../src/utils/text.js'

/** 一律批准的工具上下文：写入测试只关心内容，不走真实的用户确认。 */
const approvingContext: SystemToolContext = {
  abortSignal: new AbortController().signal,
  approval: {
    requestApproval: async () => ({ approved: true }),
    awaitConfirmation: async () => undefined,
  },
  system: { resolvePath: (path = process.cwd()) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path)) } as never,
} as SystemToolContext

/** 结果里取一项，是失败条目就抛出来，让断言直接看到原因。 */
function entryOf<T extends { path: string }>(result: { files: Array<T | { path: string; error: { code: string; message: string } }> }, index = 0): T {
  const entry = result.files[index]
  if (!entry) throw new Error(`no entry ${index}`)
  if ('error' in entry) throw new Error(`entry ${index} failed: ${entry.error.code} ${entry.error.message}`)
  return entry
}

/** 读一批，一律批准。 */
const readAll = (input: Parameters<typeof systemFileOperations.read>[0]) => systemFileOperations.read(input, approvingContext)
/** 看一批，一律批准。 */
const viewAll = (input: Parameters<typeof systemFileOperations.view>[0]) => systemFileOperations.view(input, approvingContext)

/** 读一个文件的快捷方式。 */
async function readOne(file: { path: string; offset?: number; maxChars?: number; version?: string }) {
  return entryOf(await readAll({ files: [file] }))
}

/** 写一个文件的快捷方式，一律批准。 */
async function editOne(file: { path: string; newText?: string; edits?: Array<{ range: { offset: number; end: number }; oldText?: string; newText: string }>; restore?: string }) {
  const result = await systemFileOperations.edit({ files: [file] }, approvingContext)
  const entry = result.files[0]
  if (!entry) throw new Error('no entry')
  return entry
}

/** 整批失败时回执里的问题清单，顺便核对什么都没写的标记。 */
async function problemsOf(call: Promise<unknown>) {
  try {
    await call
  } catch (error) {
    const failure = error as { context?: { executionOutcome?: string }; cause?: { reason?: string; details?: { executionOutcome?: string; problems?: Array<Record<string, unknown>> } } }
    expect(failure.context?.executionOutcome).toBe('not-applied')
    expect(failure.cause?.details?.executionOutcome).toBe('not-applied')
    return { reason: failure.cause?.reason, problems: failure.cause?.details?.problems ?? [] }
  }
  throw new Error('expected the edit to fail')
}

describe('System capability', () => {

  test('builds deterministic platform confinement profiles with an observable backend', () => {
    const policy = {
      mode: 'workspace-write' as const,
      workspaceRoot: process.cwd(),
      writeRoots: [tmpdir()],
      network: false,
    }
    const mac = buildSystemProcessConfinementSpawnSpec(
      { spec: { file: '/bin/sh', args: ['-lc', 'true'] }, policy },
      { platform: 'darwin', sandboxExecPath: '/sandbox-exec', sandboxExecAvailable: true }
    )
    const linux = buildSystemProcessConfinementSpawnSpec(
      { spec: { file: '/bin/sh', args: ['-lc', 'true'] }, policy },
      { platform: 'linux', bubblewrapPath: '/bwrap', bubblewrapAvailable: true }
    )

    expect(mac.evidence).toMatchObject({
      mode: 'workspace-write',
      enforcement: 'full',
      backend: 'seatbelt',
      reason: 'enforced',
    })
    expect(mac.evidence.writableRoots).toContain(process.cwd())
    expect(mac.evidence.writableRoots).toHaveLength(2)
    expect(mac.spec.file).toBe('/sandbox-exec')
    expect(mac.profile).toBe(buildSystemSeatbeltProfile(policy))
    expect(mac.profile).toContain('(deny network*)')
    expect(mac.profile).toContain(`(subpath ${JSON.stringify(process.cwd())})`)
    expect(linux.evidence.backend).toBe('bubblewrap')
    expect(linux.spec.args).toContain('--unshare-net')
    expect(linux.spec.args).toContain(process.cwd())
  })

  test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'enforces real Seatbelt workspace writes and blocks writes outside the approved root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'velaros-seatbelt-root-'))
      const outside = await mkdtemp(join(tmpdir(), 'velaros-seatbelt-outside-'))
      try {
        const allowedPath = join(root, 'allowed.txt')
        const deniedPath = join(outside, 'denied.txt')
        const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
        const allowed = buildSystemProcessConfinementSpawnSpec(
          {
            spec: { file: '/bin/sh', args: ['-lc', `printf allowed > '${allowedPath}'`] },
            policy,
          },
          { platform: 'darwin' }
        )
        const denied = buildSystemProcessConfinementSpawnSpec(
          {
            spec: { file: '/bin/sh', args: ['-lc', `printf denied > '${deniedPath}'`] },
            policy,
          },
          { platform: 'darwin' }
        )

        expect(spawnSync(allowed.spec.file, allowed.spec.args).status).toBe(0)
        expect(await readFile(allowedPath, 'utf8')).toBe('allowed')
        expect(spawnSync(denied.spec.file, denied.spec.args).status).not.toBe(0)
        expect(existsSync(deniedPath)).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    }
  )

  test('reads text by character ranges and continues from range.end without splitting a surrogate pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-'))
    const path = join(root, 'notes.txt')
    try {
      const text = 'héllo 中文😀 tail'
      await writeFile(path, text)
      const first = await readOne({ path, maxChars: 8 })
      expect(first.content).toBe('héllo 中文')
      expect(first.range).toEqual({ offset: 0, end: 8 })
      expect(first.hasMore).toBe(true)
      const second = await readOne({ path, offset: first.range.end, maxChars: 1 })
      expect(second.content).toBe('😀')
      expect(second.range).toEqual({ offset: 8, end: 10 })
      const rest = await readOne({ path, offset: second.range.end })
      expect(rest.content).toBe(' tail')
      expect(rest.hasMore).toBe(false)
      expect(rest.totalChars).toBe(text.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('decodes UTF-16 text and keeps its line endings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-utf16-'))
    const path = join(root, 'utf16.txt')
    try {
      await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb', 'utf16le')]))
      const result = await readOne({ path })
      expect(result.content).toBe('a\r\nb')
      expect(result.encoding).toBe('utf16le')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('view hands images to the model whole, files one or many, and refuses everything else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-view-'))
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      const imagePath = join(root, 'shot.png')
      await writeFile(imagePath, png)
      const viewedImage = await viewAll({ files: [{ path: imagePath }] })
      expect(entryOf(viewedImage)).toEqual({ path: imagePath, mediaType: 'image/png', bytes: png.byteLength })
      expect(viewedImage.modelContent).toEqual([
        { type: 'text', text: `文件 1/1：${imagePath}` },
        { type: 'image-data', data: png.toString('base64'), mediaType: 'image/png' },
      ])
      await expect(readAll({ files: [{ path: imagePath }] })).rejects.toThrow('system:view')

      const pdfPath = join(root, 'report.pdf')
      await writeFile(pdfPath, Buffer.from('%PDF-1.4\n%fake\n'))
      await expect(viewAll({ files: [{ path: pdfPath }] })).rejects.toThrow('only shows images')
      await expect(readAll({ files: [{ path: pdfPath }] })).rejects.toThrow('not text')
      const textPath = join(root, 'plain.txt')
      await writeFile(textPath, 'hello')
      await expect(viewAll({ files: [{ path: textPath }] })).rejects.toThrow('system:read')

      // 一批里混着图片和一个不存在的文件：失败的只标记它那一项，内容块按顺序排。
      const secondPath = join(root, 'again.png')
      await writeFile(secondPath, png)
      const batch = await viewAll({ files: [{ path: imagePath }, { path: join(root, 'missing.png') }, { path: secondPath }] })
      expect(batch.files.map((entry) => ('error' in entry ? entry.error.code : entry.mediaType))).toEqual(['image/png', 'NOT_FOUND', 'image/png'])
      expect(batch.modelContent.map((part) => part.type)).toEqual(['text', 'image-data', 'text', 'image-data'])
      expect(batch.modelContent[2]).toEqual({ type: 'text', text: `文件 3/3：${secondPath}` })
      await expect(viewAll({ files: [{ path: join(root, 'a.png') }, { path: join(root, 'b.png') }] })).rejects.toThrow('not found')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('read takes a batch: one budget for the whole call, per-file offsets, and a failing file only marks its own entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-batch-'))
    try {
      const bigPath = join(root, 'big.txt')
      const smallPath = join(root, 'small.txt')
      await writeFile(bigPath, 'a'.repeat(200_000))
      await writeFile(smallPath, 'small')
      const budget = await readAll({ files: [{ path: bigPath }, { path: smallPath }] })
      expect(entryOf(budget, 0)).toMatchObject({ totalChars: 200_000, hasMore: false, range: { offset: 0, end: 200_000 } })
      // 预算在第一个文件用完，第二个文件不读盘，那一项是失败条目，note 说明从它起没读。
      expect(budget.files[1]).toMatchObject({ path: smallPath, error: { code: 'VALIDATION' } })
      expect(budget.note).toContain('从第 2 个文件起没有读')

      const continued = await readAll({ files: [{ path: bigPath, offset: 199_998 }, { path: smallPath, offset: 0, maxChars: 3 }] })
      expect(entryOf(continued, 0)).toMatchObject({ content: 'aa', hasMore: false })
      expect(entryOf(continued, 1)).toMatchObject({ content: 'sma', range: { offset: 0, end: 3 }, hasMore: true })

      const mixed = await readAll({ files: [{ path: smallPath }, { path: join(root, 'missing.txt') }] })
      expect(entryOf(mixed, 0).content).toBe('small')
      expect(mixed.files[1]).toEqual({ path: join(root, 'missing.txt'), error: { code: 'NOT_FOUND', message: expect.stringContaining('not found') } })
      await expect(readAll({ files: [{ path: join(root, 'x.txt') }, { path: join(root, 'y.txt') }] })).rejects.toThrow('not found')
      await expect(readAll({ files: [] })).rejects.toThrow('files is empty')
      await expect(readAll({ files: Array.from({ length: 21 }, () => ({ path: smallPath })) })).rejects.toThrow('At most 20 files')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('read resolves relative paths against the host default directory, asks before credential files, and notes an exhausted budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-base-'))
    try {
      await writeFile(join(root, 'note.txt'), 'here')
      const hosted: SystemToolContext = { ...approvingContext, system: { resolvePath: (path = root) => resolve(root, path) } as never } as SystemToolContext
      expect(entryOf(await systemFileOperations.read({ files: [{ path: 'note.txt' }] }, hosted))).toMatchObject({ path: join(root, 'note.txt'), content: 'here' })

      // 凭证文件：批准就读，拒绝只算这个文件失败。
      const keyPath = join(root, 'deploy.pem')
      await writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nabc\n')
      expect(entryOf(await readAll({ files: [{ path: keyPath }] })).content).toContain('PRIVATE KEY')
      const denying: SystemToolContext = { ...approvingContext, approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => { throw new Error('user said no') } } } as SystemToolContext
      const refused = await systemFileOperations.read({ files: [{ path: join(root, 'note.txt') }, { path: keyPath }] }, denying)
      expect(refused.files.map((entry) => ('error' in entry ? entry.error.message : entry.content))).toEqual(['here', 'user said no'])
      await expect(systemFileOperations.read({ files: [{ path: keyPath }] }, denying)).rejects.toThrow('user said no')

      // 预算用完：结果说明从第几个文件起没内容。
      await writeFile(join(root, 'big.txt'), 'a'.repeat(200_000))
      const budget = await readAll({ files: [{ path: join(root, 'big.txt') }, { path: join(root, 'note.txt') }] })
      expect(budget.note).toContain('从第 2 个文件起没有读')
      expect(budget.files[1]).toMatchObject({ error: { code: 'VALIDATION' } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects directories, other binaries and device files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-read-reject-'))
    try {
      await expect(readAll({ files: [{ path: root }] })).rejects.toThrow('is a directory')
      const binaryPath = join(root, 'blob.bin')
      await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]))
      await expect(readAll({ files: [{ path: binaryPath }] })).rejects.toThrow('binary')
      if (process.platform !== 'win32') {
        await expect(readAll({ files: [{ path: '/dev/null' }] })).rejects.toThrow('not a regular file')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('edit writes whole files, changes several places at once within read ranges, and hands back the new text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-edit-'))
    const path = join(root, 'nested', 'config.toml')
    try {
      const written = await editOne({ path, newText: 'name = "a"\nport = 80\nport = 80\n' })
      expect(written).toMatchObject({ action: 'written', created: true, previousVersion: null })
      if (written.action !== 'written') throw new Error('expected written')
      expect(written.version).toMatch(/^[0-9a-f]{12}$/)
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 80\nport = 80\n')

      // 多处匹配：整批不写，回执里给出是第几处和每处的锚点。
      const whole = await readOne({ path })
      const ambiguous = await problemsOf(editOne({ path, edits: [{ range: whole.range, oldText: 'port = 80', newText: 'port = 8080' }] }))
      expect(ambiguous.reason).toBe('SYSTEM_EDIT_UNRESOLVED')
      expect(ambiguous.problems).toHaveLength(1)
      expect(ambiguous.problems[0]).toMatchObject({ file: 0, edit: 0, reason: 'ambiguous', matchCount: 2 })
      const anchors = ambiguous.problems[0]!.anchors as Array<{ range: { offset: number; end: number }; context: string }>
      expect(anchors.map((anchor) => anchor.range)).toEqual([{ offset: 11, end: 20 }, { offset: 21, end: 30 }])
      expect(anchors[1]!.context).toContain('port = 80\n')
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 80\nport = 80\n')

      // 同一个文件两处一起改：一处按锚点确认，一处在整段里唯一；返回盖住两处那段的新内容。
      const confirmed = await editOne({
        path,
        edits: [
          { range: anchors[1]!.range, oldText: 'port = 80', newText: 'port = 8080' },
          { range: whole.range, oldText: 'name = "a"', newText: 'name = "ab"' },
        ],
      })
      expect(confirmed).toMatchObject({ action: 'replaced', edits: 2, content: 'name = "ab"\nport = 80\nport = 8080\n', range: { offset: 0, end: 34 }, previousVersion: written.version })
      if (confirmed.action !== 'replaced') throw new Error('expected replaced')
      expect(confirmed.windows.map((window) => [window.edit, window.range, window.content])).toEqual([[0, { offset: 0, end: 34 }, 'name = "ab"\nport = 80\nport = 8080\n'], [1, { offset: 0, end: 34 }, 'name = "ab"\nport = 80\nport = 8080\n']])
      expect(await readFile(path, 'utf8')).toBe('name = "ab"\nport = 80\nport = 8080\n')

      // 任何一处定不下来整个文件就不动，而且所有问题一次报完：第一处找不到，第二处多处匹配。
      const twoProblems = await problemsOf(editOne({ path, edits: [{ range: { offset: 0, end: 12 }, oldText: 'name = "zz"', newText: 'name = "c"' }, { range: { offset: 0, end: 34 }, oldText: 'port = ', newText: 'p = ' }] }))
      expect(twoProblems.problems.map((problem) => [problem.edit, problem.reason])).toEqual([[0, 'not-found'], [1, 'ambiguous']])
      expect(await readFile(path, 'utf8')).toBe('name = "ab"\nport = 80\nport = 8080\n')
      const overlap = await problemsOf(editOne({ path, edits: [{ range: { offset: 0, end: 12 }, newText: 'x' }, { range: { offset: 5, end: 20 }, newText: 'y' }] }))
      expect(overlap.problems[0]).toMatchObject({ reason: 'overlap', edit: 1, with: 0 })
      expect(await readFile(path, 'utf8')).toBe('name = "ab"\nport = 80\nport = 8080\n')

      const recalled = await readOne({ path, version: written.version })
      expect(recalled.content).toBe('name = "a"\nport = 80\nport = 80\n')
      expect(recalled.version).toBe(written.version)
      await expect(readAll({ files: [{ path, version: 'nope' }] })).rejects.toThrow('not in history')

      const window = await readOne({ path, offset: 12, maxChars: 10 })
      expect(window.content).toBe('port = 80\n')
      const replaced = await editOne({ path, edits: [{ range: window.range, oldText: 'port = 80', newText: 'port = 8080' }] })
      expect(replaced).toMatchObject({ action: 'replaced', edits: 1, content: 'port = 8080\n', range: { offset: 12, end: 24 }, windows: [{ edit: 0, range: { offset: 0, end: 36 } }] })
      expect(await readFile(path, 'utf8')).toBe('name = "ab"\nport = 8080\nport = 8080\n')

      const swapped = await editOne({ path, edits: [{ range: { offset: 0, end: 12 }, newText: 'name = "b"\n' }] })
      expect(swapped).toMatchObject({ action: 'replaced', content: 'name = "b"\n' })
      expect(await readFile(path, 'utf8')).toBe('name = "b"\nport = 8080\nport = 8080\n')
      const inserted = await editOne({ path, edits: [{ range: { offset: 0, end: 0 }, newText: '# top\n' }] })
      expect(inserted).toMatchObject({ action: 'replaced', content: '# top\n', range: { offset: 0, end: 6 }, windows: [{ edit: 0, range: { offset: 0, end: 41 } }] })
      expect(await readFile(path, 'utf8')).toBe('# top\nname = "b"\nport = 8080\nport = 8080\n')

      const overwritten = await editOne({ path, newText: 'fresh\n' })
      expect(overwritten).toMatchObject({ action: 'written', created: false })
      if (overwritten.action !== 'written') throw new Error('expected written')
      expect(await readFile(path, 'utf8')).toBe('fresh\n')

      const restored = await editOne({ path, restore: written.version })
      expect(restored).toMatchObject({ action: 'restored', version: written.version, previousVersion: overwritten.version })
      expect(await readFile(path, 'utf8')).toBe('name = "a"\nport = 80\nport = 80\n')
      expect((await problemsOf(editOne({ path, restore: 'nope' }))).problems[0]).toMatchObject({ reason: 'not-found' })
      await expect(editOne({ path, restore: written.version, newText: 'x' })).rejects.toThrow('each go alone')
      await expect(editOne({ path })).rejects.toThrow('give newText')
      await expect(editOne({ path, edits: [{ range: { offset: 0, end: 6 }, oldText: 'missing', newText: 'x' }] })).rejects.toThrow('not found within range')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('edit takes a batch that succeeds or fails as a whole: writes, edits and rollbacks per file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-edit-batch-'))
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    try {
      const created = await systemFileOperations.edit({ files: [{ path: a, newText: 'alpha\n' }, { path: b, newText: 'beta\n' }] }, approvingContext)
      expect(created.files.map((entry) => entry.action)).toEqual(['written', 'written'])
      const versionA = created.files[0]!.version
      const versionB = created.files[1]!.version

      // 一批里有一个文件定不下来：整批不写，回执指出是哪个文件；修好那一项再发就全部成功。
      const failed = await problemsOf(systemFileOperations.edit({
        files: [
          { path: a, edits: [{ range: { offset: 0, end: 6 }, oldText: 'alpha', newText: 'ALPHA' }] },
          { path: join(root, 'missing.txt'), edits: [{ range: { offset: 0, end: 1 }, newText: 'x' }] },
          { path: b, newText: 'BETA\n' },
        ],
      }, approvingContext))
      expect(failed.problems).toEqual([expect.objectContaining({ file: 1, reason: 'not-found' })])
      expect(await readFile(a, 'utf8')).toBe('alpha\n')
      expect(await readFile(b, 'utf8')).toBe('beta\n')
      const changed = await systemFileOperations.edit({
        files: [
          { path: a, edits: [{ range: { offset: 0, end: 6 }, oldText: 'alpha', newText: 'ALPHA' }] },
          { path: b, newText: 'BETA\n' },
        ],
      }, approvingContext)
      expect(changed.files.map((entry) => entry.action)).toEqual(['replaced', 'written'])
      expect(await readFile(a, 'utf8')).toBe('ALPHA\n')
      expect(await readFile(b, 'utf8')).toBe('BETA\n')

      const rolledBack = await systemFileOperations.edit({ files: [{ path: a, restore: versionA }, { path: b, restore: versionB }] }, approvingContext)
      expect(rolledBack.files.map((entry) => entry.action)).toEqual(['restored', 'restored'])
      expect(await readFile(a, 'utf8')).toBe('alpha\n')
      expect(await readFile(b, 'utf8')).toBe('beta\n')

      const recalled = await readAll({ files: [{ path: a, version: rolledBack.files[0]!.previousVersion! }, { path: b, version: rolledBack.files[1]!.previousVersion! }] })
      expect(recalled.files.map((entry) => ('error' in entry ? entry.error.code : entry.content))).toEqual(['ALPHA\n', 'BETA\n'])

      // 敏感路径被拒：整批不写，问题标 denied。
      const denying: SystemToolContext = { ...approvingContext, approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => { throw new Error('user said no') } } } as SystemToolContext
      // 临时目录一律豁免，所以拿 /etc 下一个不存在的文件当敏感路径；被拒就不会真的写。
      const sensitive = '/etc/velaros-system-edit-test-never-written.conf'
      const denied = await problemsOf(systemFileOperations.edit({ files: [{ path: a, newText: 'never\n' }, { path: sensitive, newText: 'Host x\n' }] }, denying))
      expect(denied.reason).toBe('SYSTEM_EDIT_DENIED')
      expect(await readFile(a, 'utf8')).toBe('alpha\n')
      expect(existsSync(sensitive)).toBe(false)

      // 带 version：文件被改过就整批不写，回执给出当前版本；版本对得上就照常写。
      const before = entryOf(await readAll({ files: [{ path: a }] }))
      await writeFile(a, 'changed outside\n')
      const stale = await problemsOf(systemFileOperations.edit({ files: [{ path: a, version: before.version, edits: [{ range: before.range, newText: 'x' }] }, { path: b, newText: 'never\n' }] }, approvingContext))
      expect(stale.problems[0]).toMatchObject({ file: 0, reason: 'stale', currentVersion: expect.stringMatching(/^[0-9a-f]{12}$/) })
      expect(await readFile(a, 'utf8')).toBe('changed outside\n')
      expect(await readFile(b, 'utf8')).toBe('beta\n')
      const fresh = entryOf(await readAll({ files: [{ path: a }] }))
      const applied = await systemFileOperations.edit({ files: [{ path: a, version: fresh.version, newText: 'fine\n' }] }, approvingContext)
      expect(applied.files[0]).toMatchObject({ action: 'written' })

      await expect(systemFileOperations.edit({ files: [] }, approvingContext)).rejects.toThrow('files is empty')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a long edited span only comes back as per-edit windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-edit-long-'))
    const path = join(root, 'long.txt')
    try {
      await writeFile(path, `${'x'.repeat(30_000)  }NEEDLE${  'y'.repeat(30_000)}`)
      const whole = await readOne({ path })
      const replaced = await editOne({ path, edits: [{ range: whole.range, oldText: 'NEEDLE', newText: 'THREAD' }] })
      if (replaced.action !== 'replaced') throw new Error('expected replaced')
      expect(replaced.content).toBeUndefined()
      expect(replaced.range).toBeUndefined()
      expect(replaced.windows).toHaveLength(1)
      expect(replaced.windows[0]).toMatchObject({ edit: 0, range: { offset: 29_800, end: 30_206 } })
      expect(replaced.windows[0]!.content).toBe(`${'x'.repeat(200)  }THREAD${  'y'.repeat(200)}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('edit refuses what it cannot do losslessly or safely: bad bytes, stale restores, duplicates, out-of-range ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-edit-guard-'))
    try {
      // 不是合法 UTF-8 的字节：解码再编码对不上原字节，拒绝改，文件一个字节都不动。
      const latin = join(root, 'latin1.conf')
      const bytes = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x3d, 0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6d, 0x6f, 0x64, 0x65, 0x3d, 0x6f, 0x6c, 0x64, 0x0a])
      await writeFile(latin, bytes)
      const lossy = await problemsOf(editOne({ latin: 'x', path: latin, edits: [{ range: { offset: 0, end: 19 }, oldText: 'mode=old', newText: 'mode=new' }] } as never))
      expect(lossy.problems[0]).toMatchObject({ file: 0, reason: 'invalid' })
      expect(Buffer.compare(await readFile(latin), bytes)).toBe(0)

      // restore 也核对 version。
      const path = join(root, 'a.txt')
      const first = await editOne({ path, newText: 'one\n' })
      await editOne({ path, newText: 'two\n' })
      const staleRestore = await problemsOf(editOne({ path, restore: first.version, version: 'deadbeef0000' }))
      expect(staleRestore.problems[0]).toMatchObject({ reason: 'stale', currentVersion: expect.any(String) })
      expect(await readFile(path, 'utf8')).toBe('two\n')

      // 同一批里同一个文件出现两次：整批不写。
      const duplicated = await problemsOf(systemFileOperations.edit({ files: [{ path, newText: 'x\n' }, { path, newText: 'y\n' }] }, approvingContext))
      expect(duplicated.problems[0]).toMatchObject({ file: 1, reason: 'invalid', message: expect.stringContaining('more than once') })
      expect(await readFile(path, 'utf8')).toBe('two\n')

      // range 的起点落在文件外：不静默追加，按 stale 报（终点越界只是钳到文件末尾）。
      const outside = await problemsOf(editOne({ path, edits: [{ range: { offset: 5000, end: 5010 }, newText: 'APPENDED' }] }))
      expect(outside.problems[0]).toMatchObject({ edit: 0, reason: 'stale', message: expect.stringContaining('read it again') })
      expect(await readFile(path, 'utf8')).toBe('two\n')

      // 重叠出现也算多处：'aaa' 里找 'aa' 有两处。
      const overlapping = join(root, 'aaa.txt')
      await writeFile(overlapping, 'aaa')
      const ambiguous = await problemsOf(editOne({ path: overlapping, edits: [{ range: { offset: 0, end: 3 }, oldText: 'aa', newText: 'X' }] }))
      expect(ambiguous.problems[0]).toMatchObject({ reason: 'ambiguous', matchCount: 2 })

      // 读不了的文件变成这个文件的问题，而不是裸错。
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        const locked = join(root, 'locked.txt')
        await writeFile(locked, 'secret\n')
        await chmod(locked, 0o000)
        const unreadable = await problemsOf(editOne({ path: locked, edits: [{ range: { offset: 0, end: 7 }, newText: 'x' }] }))
        expect(unreadable.problems[0]).toMatchObject({ file: 0, reason: expect.stringMatching(/denied|invalid/) })
        await chmod(locked, 0o600)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('credential checks see through symlinks and case, edit asks too, and exhausted reads do not ask', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-credential-'))
    try {
      const keyPath = join(root, 'deploy.pem')
      await writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nabc\n')
      const alias = join(root, 'notes.txt')
      await symlink(keyPath, alias)
      const denying: SystemToolContext = { ...approvingContext, approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => { throw new Error('user said no') } } } as SystemToolContext
      await expect(systemFileOperations.read({ files: [{ path: alias }] }, denying)).rejects.toThrow('user said no')
      const write = await problemsOf(systemFileOperations.edit({ files: [{ path: alias, newText: 'clobbered\n' }] }, denying))
      expect(write.reason).toBe('SYSTEM_EDIT_DENIED')
      expect(await readFile(keyPath, 'utf8')).toContain('PRIVATE KEY')
      expect(isCredentialPath('/Users/someone/.SSH/config', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
      expect(isCredentialPath('/users/someone/.aws/config', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
      expect(isCredentialPath('/home/someone/.SSH/config', { homeDir: '/home/someone', platform: 'linux' })).toBe(false)
      expect(isCredentialPath('/home/someone/work/id_ed25519', { homeDir: '/home/someone', platform: 'linux' })).toBe(true)
      // 文件名那一半也按平台大小写规则比：macOS 上 ID_RSA、.NETRC 是同一个文件，Linux 上不是。
      expect(isCredentialPath('/Users/someone/work/ID_RSA', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
      expect(isCredentialPath('/Users/someone/.NETRC', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
      expect(isCredentialPath('/home/someone/work/ID_RSA', { homeDir: '/home/someone', platform: 'linux' })).toBe(false)

      // 预算已经用完的文件根本不读盘：不问用户，也不把版本号、字符数交出去。
      await writeFile(join(root, 'big.txt'), 'a'.repeat(200_000))
      const exhausted = await systemFileOperations.read({ files: [{ path: join(root, 'big.txt') }, { path: keyPath }] }, denying)
      expect(exhausted.files[1]).toMatchObject({ path: keyPath, error: { code: 'VALIDATION' } })
      expect(exhausted.files[1]).not.toHaveProperty('version')
      expect(exhausted.note).toContain('从第 2 个文件起没有读')

      // 参数对象里的未知字段在 schema 这一层就被拒绝，拼错的 version 不会被静默丢掉。
      expect(systemTools['system:read']!.schema.safeParse({ files: [{ path: keyPath, Version: 'x' }] }).success).toBe(false)
      expect(systemTools['system:edit']!.schema.safeParse({ files: [{ path: keyPath, edits: [{ range: { offset: 0, end: 1 }, newText: 'x', oldtext: 'y' }] }] }).success).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('adapts a replacement to CRLF files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-edit-crlf-'))
    const path = join(root, 'lines.txt')
    try {
      await writeFile(path, 'a\r\nb\r\nc\r\n')
      const result = await editOne({ path, edits: [{ range: { offset: 0, end: 9 }, oldText: 'a\nb', newText: 'x\ny' }] })
      expect(result.action).toBe('replaced')
      expect(await readFile(path, 'utf8')).toBe('x\r\ny\r\nc\r\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('sensitive-path judgement: macOS login items are caught after case folding, temp dirs never ask, Linux has no LaunchAgents', () => {
    expect(isSensitiveSystemMutationPath('/Users/someone/Library/LaunchAgents/com.evil.plist', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/Users/someone/Library/LaunchDaemons/com.evil.plist', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/Users/someone/Library/Preferences/x.plist', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(false)
    expect(isSensitiveSystemMutationPath('/home/someone/Library/LaunchAgents/x', { homeDir: '/home/someone', platform: 'linux' })).toBe(false)
    expect(isSensitiveSystemMutationPath('/private/var/folders/ab/T/velaros-x/note.txt', { homeDir: '/Users/someone', platform: 'darwin', tempDir: '/private/var/folders/ab/T' })).toBe(false)
  })

  test('edit works on the real file behind a link, refuses the same file twice in a batch, and stops asking after the first denial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-link-'))
    try {
      const real = join(root, 'real.conf')
      await writeFile(real, 'Host a\n')
      const link = join(root, 'link.conf')
      await symlink(real, link)
      const twice = await problemsOf(systemFileOperations.edit({ files: [{ path: real, newText: 'x\n' }, { path: link, newText: 'y\n' }] }, approvingContext))
      expect(twice.problems).toEqual([expect.objectContaining({ file: 1, reason: 'invalid' })])
      expect(await readFile(real, 'utf8')).toBe('Host a\n')

      const result = await systemFileOperations.edit({ files: [{ path: link, newText: 'Host b\n' }] }, approvingContext)
      expect(result.files[0]).toMatchObject({ path: link, target: await realpath(real), action: 'written' })
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(await readFile(real, 'utf8')).toBe('Host b\n')
      // 通过链接改的版本，从真实路径和链接路径都能召回。
      const previous = (result.files[0] as { previousVersion: string }).previousVersion
      expect(entryOf(await readAll({ files: [{ path: real, version: previous }] })).content).toBe('Host a\n')

      // 第一次被拒就停：第二个凭证文件不再弹确认。
      let asked = 0
      const countingDenial: SystemToolContext = { ...approvingContext, approval: { requestApproval: async () => ({ approved: true }), awaitConfirmation: async () => { asked += 1; throw new Error('no') } } } as SystemToolContext
      const key1 = join(root, 'a.pem')
      const key2 = join(root, 'b.pem')
      await writeFile(key1, 'k1\n')
      await writeFile(key2, 'k2\n')
      const denied = await problemsOf(systemFileOperations.edit({ files: [{ path: key1, newText: 'x\n' }, { path: key2, newText: 'y\n' }] }, countingDenial))
      expect(denied.reason).toBe('SYSTEM_EDIT_DENIED')
      expect(asked).toBe(1)
      expect(denied.problems).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('edit refuses to overwrite a binary file with newText and stops counting matches after the anchor limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-binary-'))
    try {
      const png = join(root, 'logo.png')
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])
      await writeFile(png, bytes)
      const refused = await problemsOf(systemFileOperations.edit({ files: [{ path: png, newText: 'oops\n' }] }, approvingContext))
      expect(refused.problems[0]).toMatchObject({ file: 0, reason: 'invalid' })
      expect(Buffer.from(await readFile(png)).equals(bytes)).toBe(true)

      const many = join(root, 'many.txt')
      await writeFile(many, 'a'.repeat(5_000))
      const ambiguous = await problemsOf(systemFileOperations.edit({ files: [{ path: many, edits: [{ range: { offset: 0, end: 5_000 }, oldText: 'aa', newText: 'b' }] }] }, approvingContext))
      expect(ambiguous.problems[0]).toMatchObject({ reason: 'ambiguous', matchCount: 11 })
      expect(String(ambiguous.problems[0]!.message)).toContain('at least 11')
      expect(findOccurrences('aaaa', 'aa', { offset: 0, end: 4 }, 2)).toEqual([0, 1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('read notes a budget that only shortened a file, and top-level unknown fields are rejected by the schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-budget-'))
    try {
      const first = join(root, 'first.txt')
      const second = join(root, 'second.txt')
      await writeFile(first, 'a'.repeat(150_000))
      await writeFile(second, 'b'.repeat(100_000))
      const result = await readAll({ files: [{ path: first }, { path: second }] })
      expect(entryOf(result, 1)).toMatchObject({ hasMore: true, range: { offset: 0, end: 50_000 } })
      expect(result.note).toContain('第 2 个文件只拿到预算剩下的部分')
      expect(systemTools['system:read']!.schema.safeParse({ files: [{ path: first }], maxChars: 5 }).success).toBe(false)
      expect(systemTools['system:view']!.schema.safeParse({ files: [{ path: first }], extra: 1 }).success).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('global path search reports truncated only when more matches exist, and env alone is read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-search-'))
    try {
      for (const name of ['file1.txt', 'file2.txt', 'file3.txt']) await writeFile(join(root, name), name)
      const search = new SystemGlobalSearch({ platform: process.platform, homeDir: root })
      const capped = await search.search(root, { query: 'file', limit: 2 })
      expect(capped.count).toBe(2)
      expect(capped.truncated).toBe(true)
      const complete = await search.search(root, { query: 'file', limit: 3 })
      expect(complete.count).toBe(3)
      expect(complete.truncated).toBe(false)
      expect(systemCommandPolicy.isReadOnly('env')).toBe(true)
      expect(systemCommandPolicy.isReadOnly('env -u FOO')).toBe(true)
      expect(systemCommandPolicy.isReadOnly('time ls')).toBe(true)
      expect(systemCommandPolicy.isReadOnly('env rm -rf x')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('edit clamps a range end past the file, rejects a reversed range, adapts line endings within the range, and writes through dangling links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-range-'))
    try {
      const short = join(root, 'short.txt')
      await writeFile(short, 'export EDITOR=vim\n')
      const clamped = await editOne({ path: short, edits: [{ range: { offset: 0, end: 1200 }, oldText: 'vim', newText: 'code' }] })
      expect(clamped.action).toBe('replaced')
      expect(await readFile(short, 'utf8')).toBe('export EDITOR=code\n')
      const reversed = await problemsOf(systemFileOperations.edit({ files: [{ path: short, edits: [{ range: { offset: 4, end: 2 }, newText: 'x' }] }] }, approvingContext))
      expect(reversed.problems[0]).toMatchObject({ edit: 0, reason: 'invalid' })
      const beyond = await problemsOf(systemFileOperations.edit({ files: [{ path: short, edits: [{ range: { offset: 999, end: 1000 }, newText: 'x' }] }] }, approvingContext))
      expect(beyond.problems[0]).toMatchObject({ edit: 0, reason: 'stale' })

      // 换行风格只看 range 里那一段：前半段 LF、后半段 CRLF 时，用 LF 写的 oldText 也能匹配 CRLF 那一段。
      const mixed = join(root, 'mixed.txt')
      await writeFile(mixed, 'P\nQ\n#####\nP\r\nQ\r\n')
      const adapted = await editOne({ path: mixed, edits: [{ range: { offset: 10, end: 16 }, oldText: 'P\nQ', newText: 'X\nY' }] })
      expect(adapted.action).toBe('replaced')
      expect(await readFile(mixed, 'utf8')).toBe('P\nQ\n#####\nX\r\nY\r\n')

      // 悬空的符号链接：写到它指向的路径，链接还是链接。
      const dangling = join(root, 'dead.link')
      await symlink(join(root, 'never-existed.txt'), dangling)
      const created = await systemFileOperations.edit({ files: [{ path: dangling, newText: 'born\n' }] }, approvingContext)
      expect(created.files[0]).toMatchObject({ action: 'written', created: true, target: join(await realpath(root), 'never-existed.txt') })
      expect((await lstat(dangling)).isSymbolicLink()).toBe(true)
      expect(await readFile(join(root, 'never-existed.txt'), 'utf8')).toBe('born\n')

      // 父路径是文件：计划期就报出来，入参可复用。
      const blocker = join(root, 'file.txt')
      await writeFile(blocker, 'x')
      const blocked = await problemsOf(systemFileOperations.edit({ files: [{ path: join(blocker, 'child.txt'), newText: 'y' }] }, approvingContext))
      expect(blocked.problems[0]).toMatchObject({ file: 0, reason: 'invalid' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('edit refuses oversized files before reading them, and whole-file writes above the snapshot limit keep the encoding but no version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-large-'))
    try {
      const big = join(root, 'big.txt')
      await writeFile(big, 'x'.repeat(3 * 1024 * 1024))
      const tooBigToEdit = await problemsOf(systemFileOperations.edit({ files: [{ path: big, edits: [{ range: { offset: 0, end: 1 }, newText: 'y' }] }] }, approvingContext))
      expect(String(tooBigToEdit.problems[0]!.message)).toContain('too large for edit')
      const rewritten = await editOne({ path: big, newText: 'small again\n' })
      expect(rewritten).toMatchObject({ action: 'written', previousVersion: null })
      expect(await readFile(big, 'utf8')).toBe('small again\n')

      const huge = join(root, 'huge.txt')
      await writeFile(huge, Buffer.alloc(21 * 1024 * 1024, 0x61))
      const refused = await problemsOf(systemFileOperations.edit({ files: [{ path: huge, newText: 'nope' }] }, approvingContext))
      expect(String(refused.problems[0]!.message)).toContain('too large to overwrite')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('sensitive-path judgement covers /Applications and files directly under the root', () => {
    expect(isSensitiveSystemMutationPath('/Applications/Foo.app/Contents/MacOS/foo', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/velaros-root-file', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(true)
    expect(isSensitiveSystemMutationPath('/tmp/velaros-x/file', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(false)
    expect(isSensitiveSystemMutationPath('/Users/someone/Documents/notes.txt', { homeDir: '/Users/someone', platform: 'darwin' })).toBe(false)
  })

  test('run and list-tasks hand the session id to the host port', async () => {
    const seen: Array<Record<string, unknown>> = []
    const port = {
      resolvePath: (path = process.cwd()) => resolve(path),
      runCommand: async (_command: string, options: Record<string, unknown>) => { seen.push({ run: options }); return { stdout: '', stderr: '', exitCode: 0, truncated: false, success: true, verification: {} } },
      listBackgroundTasks: async (options: Record<string, unknown>) => { seen.push({ list: options }); return [] },
    }
    const session: SystemToolContext = { ...approvingContext, sessionId: 'session-42', system: port as never } as SystemToolContext
    await systemTools['system:run']!.execute({ command: 'true' }, session)
    await systemTools['system:list-tasks']!.execute({}, session)
    expect(seen[0]!.run).toMatchObject({ sessionId: 'session-42' })
    expect(seen[1]!.list).toMatchObject({ sessionId: 'session-42' })
  })

  test.skipIf(process.platform === 'win32')('background tasks belong to their session, a missing cwd is reported as such, and dispose empties the task table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-system-session-'))
    const kernel = createLocalSystemKernel({ cwd: root })
    try {
      await expect(kernel.runCommand('true', { cwd: join(root, 'missing') })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const started = await kernel.runCommand('sleep 30', { background: true, sessionId: 'owner' })
      const taskId = started.backgroundProcess!.taskId!
      expect(await kernel.listBackgroundTasks({ sessionId: 'someone-else' })).toEqual([])
      expect((await kernel.listBackgroundTasks({ sessionId: 'owner' })).map((task) => task.id)).toEqual([taskId])
      await expect(kernel.terminateBackgroundTask({ taskId, sessionId: 'someone-else' })).rejects.toMatchObject({ code: 'PERMISSION' })
      const stopped = await kernel.terminateBackgroundTask({ taskId, sessionId: 'owner', force: true })
      expect(stopped.statusAfter).not.toBe('running')
      await kernel.dispose()
      expect(await kernel.listBackgroundTasks({})).toEqual([])
    } finally {
      await kernel.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
