/**
 * 文件能力的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 空间端口用 `spec/support.ts` 的真磁盘端口：作用域、审查、落盘都能按用例换。
 */

import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdtemp, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { codeProgramChecker } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'
import { textCodec } from '@velaros-ai/text-files'
import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import { VelarFilesModule } from '../contract/surface'
import type { FileLineRange, FileOperationContext, FileReadItem, FileText } from '../index'
import { FileErrorCodes, FileLimits, fileOperations } from '../index'

import { Declarations, diskSpace, failureOf, runModelProgram, submitModelProgram,UnitRoot } from './support'

let root = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 读一个文件，交回成功的那一项；读不到直接让用例挂掉。 */
async function readText(path: string, context: FileOperationContext, range?: FileLineRange): Promise<FileText> {
  const item: FileReadItem = { path }
  if (range !== undefined) item.range = range
  const [file] = (await fileOperations.read({ files: [item] }, context)).files
  if (!file || 'error' in file) throw new Error(`应当读得到 ${path}：${file && 'error' in file ? file.error.message : '没有结果'}`)
  return file
}

/** 大端 UTF-16，不带 BOM。 */
function utf16be(text: string): Buffer {
  return Buffer.from(text, 'utf16le').swap16()
}

/** 声明里紧挨在 anchor 前面的那段说明。 */
function docBefore(anchor: string): string {
  const at = Declarations.indexOf(anchor)
  if (at < 0) throw new Error(`声明里没有 ${anchor}`)
  return Declarations.slice(Declarations.lastIndexOf('/**', at), at)
}

describe('写：一批一次成败', () => {
  test('INV-1 任何一个写不下去就一个文件都不写：code 是 FILES_EDIT_UNRESOLVED，message 逐条写明第几个文件、为什么，版本对不上的带上现在的版本', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    await writeFile(join(root, 'b.txt'), 'beta\n')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    await symlink(join(root, 'a.txt'), join(root, 'alias.txt'))
    const b = await readText('b.txt', space.context)
    // 拿到 version 之后别人又改了 b
    await writeFile(join(root, 'b.txt'), 'beta changed\n')
    const current = (await readText('b.txt', space.context)).version
    const failure = await failureOf(fileOperations.edit({
      files: [
        { path: 'a.txt', newText: 'alpha 2\n' },
        { path: 'b.txt', version: b.version, edits: [{ range: 1, text: 'beta 2' }] },
        { path: 'blob.bin', newText: 'text\n' },
        { path: 'alias.txt', newText: 'again\n' },
        { path: 'fresh/c.txt', newText: 'c\n' },
      ],
    }, space.context))
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('这一批一个文件都没写，有 3 个问题')
    expect(failure.message).toContain(`files[1] ${join(root, 'b.txt')}：文件在版本 ${b.version} 之后被改过，现在是 ${current}`)
    expect(failure.message).toContain(`files[2] ${join(root, 'blob.bin')}：现有文件不能当文本改`)
    expect(failure.message).toContain(`files[3] ${join(root, 'alias.txt')}：同一个文件在这一批里出现了不止一次`)
    expect(failure.message).not.toContain('files[0]')
    expect(failure.message).not.toContain('files[4]')
    // 完整的问题清单另放在 context 里给宿主
    expect(failure.context).toMatchObject({ executionOutcome: 'not-applied', problems: [{ file: 1, reason: 'stale', currentVersion: current }, { file: 2 }, { file: 3 }] })
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta changed\n')
    expect(existsSync(join(root, 'fresh'))).toBe(false)
  })

  test('INV-1 写得下去就整批一次交给空间落盘：files 与入参一一对应，版本就是之后 read 读到的版本，给一个 changeId', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const a = await readText('a.txt', space.context)
    const result = await fileOperations.edit({
      files: [
        { path: 'a.txt', version: a.version, edits: [{ after: 1, text: 'beta' }] },
        { path: 'deep/new.txt', newText: 'one\ntwo\n' },
      ],
    }, space.context)
    expect(result.changeId).not.toBe('')
    expect(result.undoable).toBe(true)
    expect(result.files).toEqual([
      { path: join(root, 'a.txt'), created: false, version: (await readText('a.txt', space.context)).version, totalLines: 2 },
      { path: join(root, 'deep', 'new.txt'), created: true, version: (await readText('deep/new.txt', space.context)).version, totalLines: 2 },
    ])
    expect(space.commits).toHaveLength(1)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
    expect(await readFile(join(root, 'deep', 'new.txt'), 'utf8')).toBe('one\ntwo\n')
  })

  test('INV-2 落盘时核对计划时看到的字节：计划之后被同尺寸、同修改时间地改掉，也不覆盖', async () => {
    const plain = join(root, 'plain.txt')
    // 超过 64 KB：这么大的文件落盘前只看「大小 + 修改时间」，两样都没变就不重读（小文件一律重读，拦不到这里）。
    const original = `${'a'.repeat(100 * 1024)}\n`
    const concurrent = `${'z'.repeat(100 * 1024)}\n`
    await writeFile(plain, original)
    await writeFile(join(root, 'second.txt'), 'second\n')
    // 修改时间先落在整数秒上：拨回去时才能分毫不差，否则纳秒级的差别会让印记核对自己就发现了
    const pinned = 1_700_000_000
    await utimes(plain, pinned, pinned)
    const space = diskSpace({ root })
    // 定第二个文件的改法时，别人把第一个文件改成同样长度的内容，并把修改时间拨回去：印记核对看不出来，只能靠落盘时核字节
    const locate = space.port.locate
    space.port.locate = async (path) => {
      if (path === 'second.txt') {
        await writeFile(plain, concurrent)
        await utimes(plain, pinned, pinned)
      }
      return locate(path)
    }
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'plain.txt', newText: 'beta\n' }, { path: 'second.txt', newText: 'x\n' }] }, space.context))
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('这一批没有写进去')
    expect(failure.context).toEqual({ applied: [] })
    expect(space.commits[0]?.[0]?.expected).toEqual({ exists: true, bytes: Buffer.from(original) })
    expect(await readFile(plain, 'utf8')).toBe(concurrent)
    expect(await readFile(join(root, 'second.txt'), 'utf8')).toBe('second\n')
  })

  test('INV-2 新建的核对它仍不存在：定改法期间或者落盘前一刻别人建了同名文件，都不覆盖', async () => {
    const created = diskSpace({ root })
    await fileOperations.edit({ files: [{ path: 'fresh/new.txt', newText: 'hi\n' }] }, created.context)
    expect(created.commits[0]?.[0]?.expected).toEqual({ exists: false })

    // 定第二个文件的改法时别人建了它：写之前再核一次，整批不写
    await writeFile(join(root, 'second.txt'), 'second\n')
    const waiting = diskSpace({ root })
    const locate = waiting.port.locate
    waiting.port.locate = async (path) => {
      if (path === 'second.txt') await writeFile(join(root, 'mine.txt'), 'theirs\n')
      return locate(path)
    }
    const stale = await failureOf(fileOperations.edit({ files: [{ path: 'mine.txt', newText: 'mine\n' }, { path: 'second.txt', newText: 'x\n' }] }, waiting.context))
    expect(stale.code).toBe(FileErrorCodes.editUnresolved)
    expect(stale.message).toContain('定下改法之后文件又被改过了')
    expect(await readFile(join(root, 'mine.txt'), 'utf8')).toBe('theirs\n')

    // 核完到落盘之间别人建了它：空间拿 expected 核对，不覆盖
    const racing = diskSpace({ root })
    const commit = racing.port.commit
    racing.port.commit = async (writes) => {
      await writeFile(join(root, 'race.txt'), 'theirs\n')
      await commit(writes)
    }
    const raced = await failureOf(fileOperations.edit({ files: [{ path: 'race.txt', newText: 'mine\n' }] }, racing.context))
    expect(raced.message).toContain('这一批没有写进去')
    expect(await readFile(join(root, 'race.txt'), 'utf8')).toBe('theirs\n')
  })

  test('INV-2 写到一半出错时，message 点名哪几个已经写进去了，并给出把它们整次撤回的 changeId', async () => {
    await writeFile(join(root, 'one.txt'), 'one\n')
    await writeFile(join(root, 'two.txt'), 'two\n')
    const broken = diskSpace({ root, failOn: (target) => target.endsWith('three.txt') })
    const failure = await failureOf(fileOperations.edit({
      files: [{ path: 'one.txt', newText: '1\n' }, { path: 'two.txt', newText: '2\n' }, { path: 'three.txt', newText: '3\n' }],
    }, broken.context))
    expect(failure.code).toBe('PLATFORM')
    expect(failure.message).toContain('只写进去了一部分')
    expect(/已经写入的：(.*?)；出错的原因/.exec(failure.message)?.[1]).toBe(`${join(root, 'one.txt')}、${join(root, 'two.txt')}`)
    expect(failure.context).toEqual({ applied: [join(root, 'one.txt'), join(root, 'two.txt')] })
    expect(existsSync(join(root, 'three.txt'))).toBe(false)

    // 报错里给的号能把已经写进去的那几个退回到改之前
    const changeId = /undo\(\{ changeId: '([^']+)' \}\)/.exec(failure.message)?.[1]
    if (!changeId) throw new Error(`报错里应当给出 changeId：${failure.message}`)
    const undone = await fileOperations.undo({ changeId }, diskSpace({ root }).context)
    expect(undone.files.map((file) => file.action)).toEqual(['restored', 'restored'])
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('one\n')
    expect(await readFile(join(root, 'two.txt'), 'utf8')).toBe('two\n')

    // 第一个就没写进去：直说什么都没写
    const nothing = await failureOf(fileOperations.edit({ files: [{ path: 'three.txt', newText: '3\n' }] }, broken.context))
    expect(nothing.message).toContain('这一批没有写进去')
    expect(nothing.context).toEqual({ applied: [] })
  })

  test('INV-2 撤回同样核对：撤回前读到的字节在落盘时再核一次，核完之后被改过就不覆盖', async () => {
    await writeFile(join(root, 'deploy.pem'), 'secret\n')
    const change = await fileOperations.edit({ files: [{ path: 'deploy.pem', newText: 'rotated\n' }] }, diskSpace({ root }).context)
    const space = diskSpace({ root })
    const commit = space.port.commit
    space.port.commit = async (writes) => {
      await writeFile(join(root, 'deploy.pem'), 'rotated again\n')
      await commit(writes)
    }
    const failure = await failureOf(fileOperations.undo({ changeId: change.changeId }, space.context))
    expect(failure.code).toBe('VALIDATION')
    expect(space.commits[0]?.[0]).toEqual({ target: join(root, 'deploy.pem'), bytes: Buffer.from('secret\n'), expected: { exists: true, bytes: Buffer.from('rotated\n') } })
    expect(await readFile(join(root, 'deploy.pem'), 'utf8')).toBe('rotated again\n')
  })
})

describe('文本无损', () => {
  test('INV-3 编码原样保留：UTF-8（带不带 BOM）、UTF-16 两种字节序（带不带 BOM）、GB18030 按行改完还是原编码，没动的行字节不变', async () => {
    const space = diskSpace({ root })
    const before = 'first line\r\n中文第二行\r\n'
    const after = '改过的第一行\r\n中文第二行\r\n'
    const fixtures: Array<{ name: string; encoding: TextEncoding; bytes: (text: string) => Buffer }> = [
      { name: 'plain.txt', encoding: 'utf8', bytes: (text) => Buffer.from(text, 'utf8') },
      { name: 'bom.txt', encoding: 'utf8-bom', bytes: (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) },
      { name: 'le.txt', encoding: 'utf16le', bytes: (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) },
      { name: 'be.txt', encoding: 'utf16be', bytes: (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]) },
      { name: 'le-nobom.txt', encoding: 'utf16le-nobom', bytes: (text) => Buffer.from(text, 'utf16le') },
      { name: 'be-nobom.txt', encoding: 'utf16be-nobom', bytes: utf16be },
    ]
    for (const fixture of fixtures) {
      await writeFile(join(root, fixture.name), fixture.bytes(before))
      const file = await readText(fixture.name, space.context)
      expect(`${fixture.name}:${file.encoding}`).toBe(`${fixture.name}:${fixture.encoding}`)
      expect(file.lines).toEqual([[1, 'first line'], [2, '中文第二行']])
      await fileOperations.edit({ files: [{ path: fixture.name, version: file.version, edits: [{ range: 1, text: '改过的第一行' }] }] }, space.context)
      expect((await readFile(join(root, fixture.name))).equals(fixture.bytes(after))).toBe(true)
    }

    // GB18030（GBK）：「中文」是 D6D0 CEC4；新写的行按 GB18030 编，没动的行原样
    const secondLine = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])
    await writeFile(join(root, 'gbk.txt'), Buffer.concat([Buffer.from('first line\r\n'), secondLine]))
    const gbk = await readText('gbk.txt', space.context)
    expect(gbk.encoding).toBe('gb18030')
    expect(gbk.lines).toEqual([[1, 'first line'], [2, '中文']])
    await fileOperations.edit({ files: [{ path: 'gbk.txt', version: gbk.version, edits: [{ range: 1, text: '改过' }] }] }, space.context)
    expect((await readFile(join(root, 'gbk.txt'))).equals(Buffer.concat([textCodec.encode('改过\r\n', 'gb18030'), secondLine]))).toBe(true)
    // newText 整份写也按原编码
    await fileOperations.edit({ files: [{ path: 'le.txt', newText: '整份\n写\n' }] }, space.context)
    expect((await readFile(join(root, 'le.txt'))).equals(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('整份\r\n写\r\n', 'utf16le')]))).toBe(true)
  })

  test('INV-3 认不出的不当文本：读是那一项失败（图片指向 velar:images），已有的二进制文件不许被覆盖', async () => {
    const space = diskSpace({ root })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    await writeFile(join(root, 'shot.png'), png)
    await writeFile(join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
    // 真 PDF 里有二进制流；只是以 %PDF- 开头的文本仍按文本读（见下面的 notes.txt）。
    await writeFile(join(root, 'doc.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0x9f, 0x00, 0xff])]))
    await writeFile(join(root, 'notes.txt'), 'GIF89a is an image format\n')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    await writeFile(join(root, 'ok.txt'), 'ok\n')
    const { files } = await fileOperations.read({ files: [{ path: 'shot.png' }, { path: 'photo.jpg' }, { path: 'doc.pdf' }, { path: 'blob.bin' }, { path: '.' }, { path: 'ok.txt' }, { path: 'notes.txt' }] }, space.context)
    expect(files.map((file) => ('error' in file ? `${file.error.code} ${file.error.message}` : 'ok'))).toEqual([
      expect.stringMatching(/^VALIDATION .*是图片，用 velar:images 的 view 看/),
      expect.stringMatching(/^VALIDATION .*用 velar:images/),
      expect.stringMatching(/^VALIDATION .*是 PDF/),
      expect.stringMatching(/^VALIDATION 文件是二进制的/),
      expect.stringMatching(/^VALIDATION 路径是目录/),
      'ok',
      'ok',
    ])

    for (const name of ['blob.bin', 'shot.png']) {
      const original = await readFile(join(root, name))
      const refused = await failureOf(fileOperations.edit({ files: [{ path: name, newText: 'text\n' }] }, space.context))
      expect(refused.code).toBe(FileErrorCodes.editUnresolved)
      expect(refused.message).toContain('二进制文件用命令替换')
      expect((await readFile(join(root, name))).equals(original)).toBe(true)
    }
  })

  test('INV-3 新内容编不回原编码、带 NUL 字节，整批不写，不静默换成替换字符', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0x0a]))
    await writeFile(join(root, 'ok.txt'), 'ok\n')
    const lossy = await failureOf(fileOperations.edit({ files: [{ path: 'ok.txt', newText: 'fine\n' }, { path: 'gbk.txt', newText: '孤立代理项\uD800\n' }] }, space.context))
    expect(lossy.code).toBe(FileErrorCodes.editUnresolved)
    expect(lossy.message).toContain('不能按 gb18030 无损写进这个文件')
    const nul = await failureOf(fileOperations.edit({ files: [{ path: 'new.txt', newText: 'a\0b' }] }, space.context))
    expect(nul.message).toContain('NUL 字节')
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'ok.txt'), 'utf8')).toBe('ok\n')
    expect((await readFile(join(root, 'gbk.txt'))).equals(Buffer.from([0xd6, 0xd0, 0x0a]))).toBe(true)
    expect(existsSync(join(root, 'new.txt'))).toBe(false)
  })

  test('INV-3 符号链接读写它指向的文件，链接本身不变；回执里带上真正读写的 target', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'real.conf'), 'Host a\n')
    await symlink(join(root, 'real.conf'), join(root, 'link.conf'))
    const read = await readText('link.conf', space.context)
    expect(read).toMatchObject({ path: join(root, 'link.conf'), target: join(root, 'real.conf'), lines: [[1, 'Host a']] })
    expect(await readText('real.conf', space.context)).not.toHaveProperty('target')
    const written = await fileOperations.edit({ files: [{ path: 'link.conf', version: read.version, edits: [{ range: 1, text: 'Host b' }] }] }, space.context)
    expect(written.files[0]).toMatchObject({ path: join(root, 'link.conf'), target: join(root, 'real.conf'), created: false })
    expect(await readFile(join(root, 'real.conf'), 'utf8')).toBe('Host b\n')
    expect((await lstat(join(root, 'link.conf'))).isSymbolicLink()).toBe(true)
  })

  test('INV-3 换行风格照原文件：没动的行留着自己的换行符，新写的行与整份写的 newText 用文件为主的换行；新文件照写', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
    const crlf = await readText('crlf.txt', space.context)
    expect(crlf.lines).toEqual([[1, 'a'], [2, 'b'], [3, 'c']])
    await fileOperations.edit({ files: [{ path: 'crlf.txt', version: crlf.version, edits: [{ range: 2, text: 'B1\nB2' }] }] }, space.context)
    expect(await readFile(join(root, 'crlf.txt'), 'utf8')).toBe('a\r\nB1\r\nB2\r\nc\r\n')
    await fileOperations.edit({ files: [{ path: 'crlf.txt', newText: 'x\ny\n' }] }, space.context)
    expect(await readFile(join(root, 'crlf.txt'), 'utf8')).toBe('x\r\ny\r\n')

    // 混着的：CRLF 为主；第二行原来是 \n，没动就还是 \n
    await writeFile(join(root, 'mixed.txt'), 'one\r\ntwo\nthree\r\n')
    const mixed = await readText('mixed.txt', space.context)
    await fileOperations.edit({ files: [{ path: 'mixed.txt', version: mixed.version, edits: [{ range: 3, text: 'THREE' }, { after: 3, text: 'four' }] }] }, space.context)
    expect(await readFile(join(root, 'mixed.txt'), 'utf8')).toBe('one\r\ntwo\nTHREE\r\nfour\r\n')

    // 新文件没有原来的风格可照，给什么写什么（UTF-8）
    await fileOperations.edit({ files: [{ path: 'new.txt', newText: 'a\r\nb\n中' }] }, space.context)
    expect((await readFile(join(root, 'new.txt'))).equals(Buffer.from('a\r\nb\n中', 'utf8'))).toBe(true)
  })

  test('INV-3 结尾换不换行照原文件：原来结尾没有换行的，接在后面、删掉最后一行之后也没有；原来有的还有', async () => {
    const space = diskSpace({ root })
    const cases: Array<[string, string, Array<{ range: FileLineRange; text: string } | { after: number; text: string }>, string]> = [
      ['append-open.txt', 'a\nb', [{ after: 2, text: 'c' }], 'a\nb\nc'],
      ['delete-open.txt', 'a\nb', [{ range: 2, text: '' }], 'a'],
      ['replace-open.txt', 'a\nb', [{ range: 2, text: 'x\ny' }], 'a\nx\ny'],
      ['append-closed.txt', 'a\nb\n', [{ after: 2, text: 'c' }], 'a\nb\nc\n'],
      ['delete-closed.txt', 'a\nb\n', [{ range: 2, text: '' }], 'a\n'],
      ['empty.txt', '', [{ after: 0, text: 'x\ny' }], 'x\ny'],
    ]
    for (const [name, content, edits, expected] of cases) {
      await writeFile(join(root, name), content)
      const file = await readText(name, space.context)
      const result = await fileOperations.edit({ files: [{ path: name, version: file.version, edits }] }, space.context)
      expect(`${name}:${JSON.stringify(await readFile(join(root, name), 'utf8'))}`).toBe(`${name}:${JSON.stringify(expected)}`)
      expect(result.files[0]?.totalLines).toBe((await readText(name, space.context)).totalLines)
    }
  })
})

describe('大小分档', () => {
  test('INV-4 20 MB 以内整份读、整份改；多一个字节读写都拒，指向用命令；读的字符预算与文件字节上限是同一个数', async () => {
    // 两个上限是同一个数：否则会漏出一段「字节放行、字符拒绝」的文件，读不了也改不了
    expect(FileLimits.readChars).toBe(FileLimits.fileBytes)
    const space = diskSpace({ root })
    // 正好顶到上限：每行 1 KB
    const line = `${'x'.repeat(1023)}\n`
    const count = FileLimits.fileBytes / line.length
    await writeFile(join(root, 'edge.log'), line.repeat(count))
    const edge = await readText('edge.log', space.context)
    expect(edge.totalLines).toBe(count)
    const written = await fileOperations.edit({ files: [{ path: 'edge.log', version: edge.version, edits: [{ range: count, text: 'END' }] }] }, space.context)
    expect(written.files[0]?.totalLines).toBe(count)
    expect((await readFile(join(root, 'edge.log'), 'utf8')).endsWith(`${'x'.repeat(1023)}\nEND\n`)).toBe(true)

    await writeFile(join(root, 'huge.log'), Buffer.alloc(FileLimits.fileBytes + 1, 0x61))
    const [huge, after] = (await fileOperations.read({ files: [{ path: 'huge.log' }, { path: 'edge.log', range: 1 }] }, space.context)).files
    expect(huge).toEqual({ path: 'huge.log', error: { code: 'VALIDATION', message: expect.stringContaining('用 run 取片段') } })
    expect(after).toMatchObject({ lines: [[1, 'x'.repeat(1023)]] })
    const refused = await failureOf(fileOperations.edit({ files: [{ path: 'huge.log', newText: 'x' }] }, space.context))
    expect(refused.code).toBe(FileErrorCodes.editUnresolved)
    expect(refused.message).toContain('现有文件太大')
    expect(refused.message).toContain('用命令就地改')
  }, 60_000)

  test('INV-4 一批读好几个时，读不下的那个单独算失败、绝不回半份；单独放进一次 read 照样读得下', async () => {
    const space = diskSpace({ root })
    // ASCII：一个字节一个字符，两份 11 MB 加起来才压得过 20 MB 的字符预算
    const body = `${'x'.repeat(1023)}\n`.repeat(11 * 1024)
    await writeFile(join(root, 'first.log'), body)
    await writeFile(join(root, 'second.log'), body)
    await writeFile(join(root, 'note.txt'), 'here\n')
    const batch = await fileOperations.read({ files: [{ path: 'first.log' }, { path: 'second.log' }, { path: 'note.txt' }] }, space.context)
    const [first, second, note] = batch.files
    expect(first && 'lines' in first ? first.lines.length : 0).toBe(11 * 1024)
    expect(second).toEqual({ path: 'second.log', error: { code: 'VALIDATION', message: expect.stringContaining('单独放进一次 read') } })
    expect(note).toMatchObject({ lines: [[1, 'here']] })
    expect((await readText('second.log', space.context)).totalLines).toBe(11 * 1024)
  }, 60_000)
})

describe('作用域由空间注入', () => {
  test('INV-5 越出空间范围的路径（经符号链接越出去的也算）：读的那一项失败，写的那一批整批不写，code 是 FILES_EDIT_DENIED', async () => {
    const space = diskSpace({ root, clamp: true })
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-outside-')))
    try {
      await writeFile(join(outside, 'x.txt'), 'outside\n')
      await symlink(join(outside, 'x.txt'), join(root, 'escape.txt'))
      await writeFile(join(root, 'in.txt'), 'inside\n')
      const read = await fileOperations.read({ files: [{ path: join(outside, 'x.txt') }, { path: 'escape.txt' }, { path: 'in.txt' }] }, space.context)
      expect(read.files[0]).toMatchObject({ error: { code: 'PERMISSION' } })
      expect(read.files[1]).toMatchObject({ path: 'escape.txt', error: { code: 'PERMISSION' } })
      expect(read.files[2]).toMatchObject({ path: 'in.txt', lines: [[1, 'inside']] })

      for (const escaping of ['../escape-new.txt', 'escape.txt']) {
        const failure = await failureOf(fileOperations.edit({ files: [{ path: 'in.txt', newText: 'changed\n' }, { path: escaping, newText: 'x\n' }] }, space.context))
        expect(failure.code).toBe(FileErrorCodes.editDenied)
        expect(failure.message).toContain(`files[1] ${escaping}：`)
      }
      expect(space.commits).toHaveLength(0)
      expect(await readFile(join(root, 'in.txt'), 'utf8')).toBe('inside\n')
      expect(await readFile(join(outside, 'x.txt'), 'utf8')).toBe('outside\n')
      expect(existsSync(join(root, '..', 'escape-new.txt'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('代码面 files 命名空间', () => {
  test('INV-6 模型写的程序照生成的声明调到真实操作：读真文件、在程序里筛、只交出要的', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1\n// TODO: 补这里\n')
    await writeFile(join(root, 'b.ts'), '干净文件，没有待办\n')
    const result = await runModelProgram(diskSpace({ root, clamp: true }), `import { read } from 'velar:files'
const r = await read({ files: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'missing.ts' }] })
export default r.files.flatMap((f) => ('error' in f ? [\`\${f.path}: \${f.error.code}\`] : f.lines.filter(([, text]) => text.includes('TODO')).map(([line]) => \`\${f.path}:\${line}\`)))`)
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual(['a.ts:2', 'missing.ts: NOT_FOUND'])
  }, 60_000)

  test('INV-6 形状写错的程序过不了 typecheck，一行都不执行', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const space = diskSpace({ root, clamp: true })
    const outcome = await submitModelProgram(space, `import { edit, read } from 'velar:files'
await edit({ files: [{ path: 'made.txt', newText: '这一行不该跑' }] })
const [file] = (await read({ files: [{ path: 'a.txt', version: 'v1' }] })).files
await edit({ files: [{ path: 'a.txt', restore: 'v1' }] })
export default file.lines.length`)
    if (outcome.checked || !('check' in outcome)) throw new Error('应当被 typecheck 挡回去')
    // 读旧写法的 version、写旧写法的 restore、不先分开失败那支就取 lines：三行各被拦一次
    expect([...new Set(outcome.check.diagnostics.map((diagnostic) => diagnostic.line))]).toEqual([3, 4, 5])
    expect(existsSync(join(root, 'made.txt'))).toBe(false)
    expect(space.located).toHaveLength(0)
    expect(space.commits).toHaveLength(0)
  }, 60_000)

  test('INV-6 程序里按行号改、拿 changeId 再撤回：两段程序走的都是真操作，换行风格原样', async () => {
    const original = 'name=demo\r\nport=8080\r\n'
    await writeFile(join(root, 'app.conf'), original)
    const space = diskSpace({ root, clamp: true })
    const edited = await runModelProgram(space, `import { edit, read } from 'velar:files'
const [file] = (await read({ files: [{ path: 'app.conf' }] })).files
if ('error' in file) throw new Error(file.error.message)
const hit = file.lines.find(([, text]) => text.startsWith('port='))
if (!hit) throw new Error('没有 port 这一行')
const result = await edit({ files: [{ path: 'app.conf', version: file.version, edits: [{ range: hit[0], text: 'port=9090' }, { after: file.totalLines, text: 'debug=true' }] }] })
export default { changeId: result.changeId, totalLines: result.files[0].totalLines }`)
    expect(edited.failed).toBeUndefined()
    const { changeId, totalLines } = edited.value as { changeId: string; totalLines: number }
    expect(totalLines).toBe(3)
    expect(await readFile(join(root, 'app.conf'), 'utf8')).toBe('name=demo\r\nport=9090\r\ndebug=true\r\n')

    const reverted = await runModelProgram(space, `import { undo } from 'velar:files'
const result = await undo({ changeId: ${JSON.stringify(changeId)} })
export default result.files.map((f) => \`\${f.path} \${f.action}\`)`)
    expect(reverted.value).toEqual(['app.conf restored'])
    expect(await readFile(join(root, 'app.conf'), 'utf8')).toBe(original)
  }, 60_000)

  test('INV-6 大文件穿过隔离：十几 MB 读进程序、在程序里按行改、写回去，模型只看到一行摘要', async () => {
    const lines = Array.from({ length: 400_000 }, (_, index) => `${index % 997 === 0 ? 'ERROR' : 'INFO '} line ${index} ${'-'.repeat(12)}`)
    await writeFile(join(root, 'big.log'), `${lines.join('\n')}\n`)
    const result = await runModelProgram(diskSpace({ root }), `import { edit, read } from 'velar:files'
const [file] = (await read({ files: [{ path: 'big.log' }] })).files
if ('error' in file) throw new Error(file.error.message)
const edits = file.lines.filter(([, text]) => text.startsWith('ERROR')).map(([line, text]) => ({ range: line, text: text.replace('ERROR', 'FIXED') }))
const written = await edit({ files: [{ path: 'big.log', version: file.version, edits }] })
export default { chars: file.lines.reduce((sum, [, text]) => sum + text.length, 0), fixed: edits.length, undoable: written.undoable }`, 60_000)
    expect(result.failed).toBeUndefined()
    const value = result.value as { chars: number; fixed: number; undoable: boolean }
    expect(value.chars).toBeGreaterThan(10_000_000)
    expect(value.fixed).toBe(402)
    // 改之前超过 2 MB：能改，只是撤不回
    expect(value.undoable).toBe(false)
    expect(JSON.stringify(result).length).toBeLessThan(500)
    const after = await readFile(join(root, 'big.log'), 'utf8')
    expect(after.includes('ERROR')).toBe(false)
    expect(after.split('\n').length).toBe(400_001)
    expect(after.split('\n')[997]).toBe(`FIXED line 997 ${'-'.repeat(12)}`)
  }, 120_000)

  test('INV-6 写不下去时程序接得住：error.code 与 message 就是模型能看见的全部', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const result = await runModelProgram(diskSpace({ root }), `import { edit, undo } from 'velar:files'
const outcome = []
try {
  await edit({ files: [{ path: 'a.txt', version: 'not-the-version', edits: [{ range: 1, text: 'x' }] }] })
  outcome.push('没拦住')
} catch (error) {
  outcome.push({ code: error.code, stale: error.message.includes('被改过') })
}
try {
  await undo({ changeId: 'change-0-nothing' })
  outcome.push('没拦住')
} catch (error) {
  outcome.push({ code: error.code })
}
export default outcome`)
    expect(result.value).toEqual([{ code: FileErrorCodes.editUnresolved, stale: true }, { code: 'NOT_FOUND' }])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
  }, 60_000)
})

describe('入参', () => {
  test('INV-7 一批的形状不对一律 VALIDATION：不是对象、files 不是数组、空批、项不是对象、超过批量上限，碰不到空间', async () => {
    const space = diskSpace({ root })
    const shapes: unknown[] = [undefined, null, 'x', [], { files: '不是数组' }, { files: [] }, { files: ['a.txt'] }, { files: [null] }]
    for (const input of shapes) {
      expect((await failureOf(fileOperations.read(input as never, space.context))).code).toBe('VALIDATION')
      expect((await failureOf(fileOperations.edit(input as never, space.context))).code).toBe('VALIDATION')
    }
    const reads = Array.from({ length: FileLimits.readFiles + 1 }, (_, index) => ({ path: `${index}.txt` }))
    expect((await failureOf(fileOperations.read({ files: reads }, space.context))).message).toContain(`最多 ${FileLimits.readFiles} 个文件`)
    const edits = Array.from({ length: FileLimits.editFiles + 1 }, (_, index) => ({ path: `${index}.txt`, newText: '' }))
    expect((await failureOf(fileOperations.edit({ files: edits }, space.context))).message).toContain(`最多 ${FileLimits.editFiles} 个文件`)
    expect(space.located).toHaveLength(0)
    expect(space.commits).toHaveLength(0)
  })

  test('INV-7 读的一项不合法只那一项失败：path 不是字符串、range 不是合法的行号；全都不合法时整个调用报 VALIDATION', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\nb\n')
    const items = [{ path: 3 }, { path: '' }, { path: 'a.txt', range: 0 }, { path: 'a.txt', range: [2, 1] }, { path: 'a.txt', range: '1-2' }, { path: 'a.txt', range: [1, 2, 3] }, { path: 'a.txt', range: 1.5 }, { path: 'a.txt', range: [1, 2] }]
    const result = await fileOperations.read({ files: items } as never, space.context)
    expect(result.files.map((file) => ('error' in file ? file.error.code : 'ok'))).toEqual([...Array.from({ length: 7 }, () => 'VALIDATION'), 'ok'])
    expect(result.files[3]).toMatchObject({ error: { message: expect.stringContaining('range 要行号或 [首行, 末行]') } })
    expect((await failureOf(fileOperations.read({ files: [{ path: 3 }] } as never, space.context))).code).toBe('VALIDATION')
  })

  test('INV-7 写的一项不合法进 FILES_EDIT_UNRESOLVED 的问题清单：逐条点名，一个文件都不写', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const a = await readText('a.txt', space.context)
    const b = await readText('b.txt', space.context)
    const failure = await failureOf(fileOperations.edit({
      files: [
        { path: 3, newText: 'x' },
        { path: 'n1.txt', newText: 'x', edits: [{ after: 0, text: 'x' }] },
        { path: 'n2.txt' },
        { path: 'n3.txt', newText: 42 },
        { path: 'a.txt', version: a.version, edits: [{ line: 1, text: 'x' }] },
        { path: 'b.txt', version: b.version, edits: 'x' },
      ],
    } as never, space.context))
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('有 6 个问题')
    for (const [index, reason] of ['每一项都要有 path', 'edits 与 newText 只能用一种', '两者选一', 'newText 要是字符串', 'edits[0] 的 range 与 after 只给一个', `edits 要 1–${FileLimits.editsPerFile} 处改动的数组`].entries()) {
      expect(failure.message).toMatch(new RegExp(`files\\[${index}\\] [^；]*${reason.replace(/[[\]]/g, '\\$&')}`))
    }
    expect(space.commits).toHaveLength(0)
    expect(['n1.txt', 'n2.txt', 'n3.txt'].some((name) => existsSync(join(root, name)))).toBe(false)
  })

  test('INV-7 什么样的入参都不会让操作半途崩：抛出来的一律是带码的 AppError；undo 没给 changeId 是 VALIDATION', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    const version = (await readText('a.txt', space.context)).version
    const junk: unknown[] = [
      undefined, 0, {}, { files: null }, { files: [{}] }, { files: [{ path: null }] }, { files: [{ path: 'a.txt', range: {} }] },
      { files: [{ path: 'a.txt', newText: 'x', version: {} }] },
      { files: [{ path: 'a.txt', version, edits: [null] }] },
      { files: [{ path: 'a.txt', version, edits: [1] }] },
      { files: [{ path: 'a.txt', version, edits: [{ range: null, text: 'x' }] }] },
      { files: [{ path: 'a.txt', version, edits: [{ after: '1', text: 'x' }] }] },
      { files: [{ path: 'a.txt', version, edits: [{ range: 1, after: 1, text: 'x' }] }] },
      { files: [{ path: 'a.txt', version, edits: Array.from({ length: FileLimits.editsPerFile + 1 }, () => ({ after: 0, text: 'x' })) }] },
      { changeId: {} }, { changeId: '' },
    ]
    for (const input of junk) {
      const operations = [
        () => fileOperations.read(input as never, space.context),
        () => fileOperations.edit(input as never, space.context),
        () => fileOperations.undo(input as never, space.context),
      ]
      for (const operation of operations) {
        const outcome = await operation().then(() => null, (error: unknown) => error)
        if (outcome === null) continue
        expect(outcome).toBeInstanceOf(AppError)
        expect(['VALIDATION', FileErrorCodes.editUnresolved]).toContain((outcome as AppError).code)
      }
    }
    for (const input of [undefined, null, 'x', {}, { changeId: 3 }, { changeId: '  ' }]) {
      expect((await failureOf(fileOperations.undo(input as never, space.context))).code).toBe('VALIDATION')
    }
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n')
  })
})

describe('模型面', () => {
  test('INV-9 代码模版整份照真实声明过类型检查，import 只写一次；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(resolve(UnitRoot, 'template.js'), 'utf8')
    const checked = codeProgramChecker.check({ source: template, granted: [{ namespace: 'files', declarations: Declarations }] })
    expect(checked.ok ? [] : checked.diagnostics).toEqual([])
    expect(template.match(/^import /gm)).toHaveLength(1)
    expect(VelarFilesModule.template).toBe(template.trim())
    expect(Declarations).not.toContain('的代码模版')
  })

  test('INV-10 声明里写的上限与错误码和常量表一致；模型面上没有空间端口、调用上下文，也没有看图', () => {
    const mb = (bytes: number): string => `${bytes / 1024 / 1024} MB`
    expect(docBefore('interface FileReadInput')).toContain(`一批最多 ${FileLimits.readFiles} 个`)
    expect(docBefore('interface FileEditInput')).toContain(`一批最多 ${FileLimits.editFiles} 个文件`)
    expect(docBefore('interface FileReadItem')).toContain(`单个文件最大 ${mb(FileLimits.fileBytes)}`)
    expect(docBefore('export function read')).toContain(`超过 ${mb(FileLimits.fileBytes)} 的文件`)
    expect(docBefore('interface FileEditResult')).toContain(`超过 ${mb(FileLimits.undoBytes)}`)
    expect(docBefore('interface FileUndoInput')).toContain(`只留最近 ${FileLimits.undoChanges} 次`)
    expect(docBefore('export function undo')).toContain(`只留最近 ${FileLimits.undoChanges} 次`)
    expect(docBefore('interface FileEditResult')).toContain(FileErrorCodes.editUnresolved)
    expect(docBefore('interface FileEditResult')).toContain(FileErrorCodes.editDenied)
    expect(docBefore('interface FileUndoResult')).toContain(FileErrorCodes.undoConflict)
    // 声明只有三个方法，签名里没有宿主的上下文
    expect(Declarations.match(/export function \w+/g)).toEqual(['export function read', 'export function edit', 'export function undo'])
    expect(Declarations).toContain('export function read(input: FileReadInput): Promise<FileReadResult>')
    for (const hidden of ['FileSpacePort', 'FileOperationContext', 'FileWrite', 'FileLocation', 'locate', 'commit', 'abortSignal']) {
      expect(`${hidden}:${Declarations.includes(hidden)}`).toBe(`${hidden}:false`)
    }
    expect(Declarations).toContain('看图片用 `velar:images`')
  })
})

describe('行：数法与按行改', () => {
  test('INV-12 行号的数法和 wc -l 一样：结尾的换行不多出一行，最后一行没换行也算一行；range 末行超出就收到最后一行，version 是整个文件的', async () => {
    const space = diskSpace({ root })
    const cases: Array<[string, string, Array<[number, string]>]> = [
      ['closed.txt', 'a\nb\n', [[1, 'a'], [2, 'b']]],
      ['open.txt', 'a\nb', [[1, 'a'], [2, 'b']]],
      ['empty.txt', '', []],
      ['blank.txt', '\n', [[1, '']]],
      ['blanks.txt', '\r\n\r\n', [[1, ''], [2, '']]],
    ]
    for (const [name, content, lines] of cases) {
      await writeFile(join(root, name), content)
      const file = await readText(name, space.context)
      expect(`${name}:${file.totalLines}:${JSON.stringify(file.lines)}`).toBe(`${name}:${lines.length}:${JSON.stringify(lines)}`)
    }
    // 结尾有换行的文件，行数就是 wc -l 数出来的
    await writeFile(join(root, 'log.txt'), 'one\ntwo\nthree\n')
    const log = await readText('log.txt', space.context)
    if (process.platform !== 'win32') {
      const counted = Bun.spawnSync(['wc', '-l', join(root, 'log.txt')]).stdout.toString().trim().split(/\s+/)[0]
      expect(String(log.totalLines)).toBe(counted)
    }

    const tail = await readText('log.txt', space.context, [2, 99])
    expect(tail).toMatchObject({ totalLines: 3, lines: [[2, 'two'], [3, 'three']], version: log.version })
    expect((await readText('log.txt', space.context, 3)).lines).toEqual([[3, 'three']])
    expect((await readText('log.txt', space.context, [1])).lines).toEqual([[1, 'one']])
    const [beyond] = (await fileOperations.read({ files: [{ path: 'log.txt', range: [4, 5] }, { path: 'log.txt' }] }, space.context)).files
    expect(beyond).toMatchObject({ path: 'log.txt', error: { code: 'VALIDATION', message: expect.stringContaining('只有 3 行，range 从第 4 行起') } })
  })

  test('INV-12 edits 的行号都按 read 那一版算：几处一起改不用自己算错位，给的顺序不要紧，插在最前、接在最后、删、换都行', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'lines.txt'), 'l1\nl2\nl3\nl4\nl5\n')
    const file = await readText('lines.txt', space.context)
    const result = await fileOperations.edit({
      files: [{
        path: 'lines.txt',
        version: file.version,
        edits: [
          { range: 4, text: '' },
          { after: 5, text: 'end1\nend2' },
          { range: [2, 3], text: 'two-three' },
          { after: 0, text: 'top' },
        ],
      }],
    }, space.context)
    expect(await readFile(join(root, 'lines.txt'), 'utf8')).toBe('top\nl1\ntwo-three\nl5\nend1\nend2\n')
    expect(result.files[0]?.totalLines).toBe(6)
  })

  test('INV-12 几处改动重叠（插入点落在被换掉的几行中间也算）就整批不写', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), '1\n2\n3\n4\n5\n')
    await writeFile(join(root, 'b.txt'), '1\n2\n3\n4\n5\n')
    const a = await readText('a.txt', space.context)
    const b = await readText('b.txt', space.context)
    const failure = await failureOf(fileOperations.edit({
      files: [
        { path: 'a.txt', version: a.version, edits: [{ range: [2, 3], text: 'x' }, { range: [3, 4], text: 'y' }] },
        { path: 'b.txt', version: b.version, edits: [{ range: [2, 4], text: 'x' }, { after: 3, text: 'y' }] },
      ],
    }, space.context))
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain(`files[0] ${join(root, 'a.txt')}：edits[0] 与 edits[1] 重叠了`)
    expect(failure.message).toContain(`files[1] ${join(root, 'b.txt')}：edits[1] 与 edits[0] 重叠了`)
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('1\n2\n3\n4\n5\n')
  })

  test('INV-12 按行号改必须带 version：不带的、版本过期的、行号越出文件的，整批不写', async () => {
    const space = diskSpace({ root })
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(root, name), 'one\ntwo\n')
    const c = await readText('c.txt', space.context)
    const d = await readText('d.txt', space.context)
    await writeFile(join(root, 'b.txt'), 'one\ntwo\nthree\n')
    const current = (await readText('b.txt', space.context)).version
    const failure = await failureOf(fileOperations.edit({
      files: [
        { path: 'a.txt', edits: [{ range: 1, text: 'x' }] },
        { path: 'b.txt', version: c.version, edits: [{ range: 1, text: 'x' }] },
        { path: 'c.txt', version: c.version, edits: [{ range: [2, 3], text: 'x' }] },
        { path: 'd.txt', version: d.version, edits: [{ after: 3, text: 'x' }] },
      ],
    }, space.context))
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('有 4 个问题')
    expect(failure.message).toContain(`files[0] ${join(root, 'a.txt')}：按行号改（edits）要带上 read 给的 version`)
    expect(failure.message).toContain(`现在是 ${current}`)
    expect(failure.message).toContain('edits[0].range 超出了文件：文件只有 2 行，这里要到第 3 行')
    expect(failure.message).toContain('edits[0].after 要 0–2 的整数')
    expect(space.commits).toHaveLength(0)
  })
})

describe('撤回', () => {
  test('INV-13 undo 把一次改动整次撤回：改过的回到改动前的字节，新建的删掉，经符号链接改的写回它指向的文件', async () => {
    const space = diskSpace({ root })
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('名字=旧\r\n端口=80\r\n', 'utf16le')])
    await writeFile(join(root, 'utf16.ini'), utf16)
    await writeFile(join(root, 'real.conf'), 'Host a\n')
    await symlink(join(root, 'real.conf'), join(root, 'link.conf'))
    const ini = await readText('utf16.ini', space.context)
    const change = await fileOperations.edit({
      files: [
        { path: 'utf16.ini', version: ini.version, edits: [{ range: 2, text: '端口=8080' }] },
        { path: 'link.conf', newText: 'Host b\n' },
        { path: 'made/fresh.txt', newText: 'new\n' },
      ],
    }, space.context)
    expect(change.undoable).toBe(true)

    const undone = await fileOperations.undo({ changeId: change.changeId }, space.context)
    expect(undone).toEqual({
      changeId: change.changeId,
      files: [
        { path: join(root, 'utf16.ini'), action: 'restored' },
        { path: join(root, 'link.conf'), target: join(root, 'real.conf'), action: 'restored' },
        { path: join(root, 'made', 'fresh.txt'), action: 'deleted' },
      ],
    })
    expect((await readFile(join(root, 'utf16.ini'))).equals(utf16)).toBe(true)
    expect(await readFile(join(root, 'real.conf'), 'utf8')).toBe('Host a\n')
    expect((await lstat(join(root, 'link.conf'))).isSymbolicLink()).toBe(true)
    expect(existsSync(join(root, 'made', 'fresh.txt'))).toBe(false)
  })

  test('INV-13 那次改动之后又被改过的文件有一个就整个不撤（FILES_UNDO_CONFLICT），一个文件都不动；改回那一版之后能撤', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const change = await fileOperations.edit({ files: [{ path: 'a.txt', newText: 'A\n' }, { path: 'b.txt', newText: 'B\n' }, { path: 'c.txt', newText: 'C\n' }] }, space.context)
    await writeFile(join(root, 'b.txt'), 'someone else\n')
    await unlink(join(root, 'c.txt'))
    const now = (await readText('b.txt', space.context)).version
    const conflict = await failureOf(fileOperations.undo({ changeId: change.changeId }, space.context))
    expect(conflict.code).toBe(FileErrorCodes.undoConflict)
    expect(conflict.message).toContain('一个文件都没撤')
    expect(conflict.message).toContain(`${join(root, 'b.txt')}（现在是 ${now}）`)
    // 那次新建、现在已经不在的文件不算冲突：撤回本来就是把它删掉（上一次撤回做了一半时就是这个样子）。
    expect(conflict.message).not.toContain(join(root, 'c.txt'))
    expect(conflict.message).not.toContain(join(root, 'a.txt'))
    expect(space.commits).toHaveLength(1)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('someone else\n')

    // 改回那次改完的样子，就又能撤了
    await writeFile(join(root, 'b.txt'), 'B\n')
    await writeFile(join(root, 'c.txt'), 'C\n')
    const undone = await fileOperations.undo({ changeId: change.changeId }, space.context)
    expect(undone.files.map((file) => file.action)).toEqual(['restored', 'restored', 'deleted'])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n')
    expect(existsSync(join(root, 'c.txt'))).toBe(false)
  })

  test('INV-13 撤过的再撤一次也成功、什么都不动（alreadyUndone）；号不对的是 NOT_FOUND', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    const change = await fileOperations.edit({ files: [{ path: 'a.txt', newText: 'A\n' }] }, space.context)
    await fileOperations.undo({ changeId: change.changeId }, space.context)
    await writeFile(join(root, 'a.txt'), 'later\n')
    expect(await fileOperations.undo({ changeId: change.changeId }, space.context)).toEqual({ changeId: change.changeId, alreadyUndone: true, files: [] })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('later\n')
    expect(space.commits).toHaveLength(2)
    const unknown = await failureOf(fileOperations.undo({ changeId: 'change-0-nothing' }, space.context))
    expect(unknown.code).toBe('NOT_FOUND')
    expect(unknown.message).toContain('change-0-nothing')
  })

  test('INV-13 改之前超过 2 MB 的原文不留：那次改动 undoable 为 false，undo 报 VALIDATION，文件照改过的样子', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'big.log'), 'x'.repeat(FileLimits.undoBytes + 1))
    await writeFile(join(root, 'small.txt'), 'small\n')
    const change = await fileOperations.edit({ files: [{ path: 'small.txt', newText: 'SMALL\n' }, { path: 'big.log', newText: 'short now\n' }] }, space.context)
    expect(change.undoable).toBe(false)
    const refused = await failureOf(fileOperations.undo({ changeId: change.changeId }, space.context))
    expect(refused.code).toBe('VALIDATION')
    expect(refused.message).toContain('撤不回')
    expect(await readFile(join(root, 'big.log'), 'utf8')).toBe('short now\n')
    expect(await readFile(join(root, 'small.txt'), 'utf8')).toBe('SMALL\n')

    // 正好 2 MB 的还留着原文
    await writeFile(join(root, 'edge.log'), 'y'.repeat(FileLimits.undoBytes))
    const edge = await fileOperations.edit({ files: [{ path: 'edge.log', newText: 'short\n' }] }, space.context)
    expect(edge.undoable).toBe(true)
    await fileOperations.undo({ changeId: edge.changeId }, space.context)
    expect((await readFile(join(root, 'edge.log'), 'utf8')).length).toBe(FileLimits.undoBytes)
  })

  test('INV-13 只留最近 50 次改动：更早的撤不回（NOT_FOUND），最近的还能撤', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'counter.txt'), '0\n')
    const first = await fileOperations.edit({ files: [{ path: 'counter.txt', newText: '1\n' }] }, space.context)
    let last = first
    for (let index = 2; index <= FileLimits.undoChanges + 1; index += 1) {
      last = await fileOperations.edit({ files: [{ path: 'counter.txt', newText: `${index}\n` }] }, space.context)
    }
    const expired = await failureOf(fileOperations.undo({ changeId: first.changeId }, space.context))
    expect(expired.code).toBe('NOT_FOUND')
    expect(expired.message).toContain(`只留最近 ${FileLimits.undoChanges} 次`)
    await fileOperations.undo({ changeId: last.changeId }, space.context)
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe(`${FileLimits.undoChanges}\n`)
  })
})
