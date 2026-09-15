import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { systemFileOperations } from '../src/impl/SystemFileOperations.js'
import type { SystemToolContext } from '../src/interface/requires.js'
import { shouldReapForegroundProcessGroupAfterExit } from '../src/utils/command-policy.js'
import { buildSystemProcessConfinementSpawnSpec, buildSystemSeatbeltProfile } from '../src/utils/confinement.js'

/** 一律批准的工具上下文：写入测试只关心内容，不走真实的用户确认。 */
const approvingContext: SystemToolContext = {
  abortSignal: new AbortController().signal,
  approval: {
    requestApproval: async () => ({ approved: true }),
    awaitConfirmation: async () => undefined,
  },
  system: {} as never,
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

  test('only reaps commands that launch a real shell background job', () => {
    expect(shouldReapForegroundProcessGroupAfterExit('printf one && printf two')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('false || printf fallback')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('printf value | wc -c')).toBe(false)
    expect(shouldReapForegroundProcessGroupAfterExit('server &')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &; printf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('server &\nprintf ready')).toBe(true)
    expect(shouldReapForegroundProcessGroupAfterExit('nohup server &')).toBe(false)
  })

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
      expect(entryOf(budget, 1)).toMatchObject({ content: '', range: { offset: 0, end: 0 }, totalChars: 5, hasMore: true })

      const continued = await readAll({ files: [{ path: bigPath, offset: 199_998 }, { path: smallPath, offset: entryOf(budget, 1).range.end, maxChars: 3 }] })
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
      const hosted: SystemToolContext = { ...approvingContext, system: { resolveCommandCwd: () => root } as never } as SystemToolContext
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
      expect(budget.note).toContain('第 2 个文件')
      expect(entryOf(budget, 1)).toMatchObject({ content: '', hasMore: true })
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

})
