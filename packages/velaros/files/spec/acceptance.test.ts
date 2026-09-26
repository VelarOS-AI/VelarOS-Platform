/**
 * 文件能力的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 空间端口用 `spec/support.ts` 的真磁盘端口：作用域、落盘都能按用例换；本机文件端口（`./local` 入口）的承诺用真端口测（INV-14～INV-16）。
 */

import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'
import { textCodec } from '@velaros-ai/core/text-files'
import type { TextEncoding } from '@velaros-ai/core/text-files/contracts'
import { codeProgramChecker } from '@velaros-ai/script'

import { VelarFilesModule } from '../contract/surface'
import type {
  FileEditStep,
  FileLineRange,
  FileOperationContext,
  FileReadItem,
  FileText,
} from '../index'
import { FileErrorCodes, FileLimits, fileOperations } from '../index'

import {
  Declarations,
  diskSpace,
  failureOf,
  localFileSpace,
  runModelProgram,
  submitModelProgram,
  UnitRoot,
} from './support'

let root = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 读一个文件，交回成功的那一项；读不到直接让用例挂掉。 */
async function readText(
  path: string,
  context: FileOperationContext,
  range?: FileLineRange
): Promise<FileText> {
  const item: FileReadItem = { path }
  if (range !== undefined) item.range = range
  const [file] = (await fileOperations.read({ files: [item] }, context)).files
  if (!file || 'error' in file)
    throw new Error(
      `应当读得到 ${path}：${file && 'error' in file ? file.error.message : '没有结果'}`
    )
  return file
}

/** 整份写的一步。 */
function writeStep(path: string, text: string): FileEditStep {
  return { action: 'write', path, text }
}

/** 把一段原文换掉的一步。 */
function replaceStep(path: string, oldText: string, newText: string): FileEditStep {
  return { action: 'replace', path, oldText, newText }
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

describe('写：一次改动一次成败', () => {
  test('INV-1 任何一步写不下去就一个文件都不写：code 是 FILES_EDIT_UNRESOLVED，message 逐条写明第几步、为什么（找不到的带上最像的几行，不唯一的带上在第几行）', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    await writeFile(join(root, 'b.txt'), 'beta\n  port = 80\n')
    await writeFile(join(root, 'c.txt'), 'x\ny\nx\n')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const failure = await failureOf(
      fileOperations.edit(
        {
          steps: [
            writeStep('a.txt', 'alpha 2\n'),
            replaceStep('b.txt', 'port = 80\n  host = a', 'port = 9090'),
            replaceStep('c.txt', 'x', 'z'),
            writeStep('blob.bin', 'text\n'),
            replaceStep('missing.txt', 'a', 'b'),
            writeStep('fresh/c.txt', 'c\n'),
            // b.txt 已经出了问题：它后面的几步不再看，也不再报
            replaceStep('b.txt', 'beta', 'BETA'),
          ],
        },
        space.context
      )
    )
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('这次改动一个文件都没写，有 4 个问题')
    expect(failure.message).toContain(
      `steps[1] ${join(root, 'b.txt')}：oldText 在文件里没有一模一样的原文，最像的是第 2 行「port = 80」`
    )
    expect(failure.message).toContain(
      `steps[2] ${join(root, 'c.txt')}：oldText 在文件里出现了 2 次（第 1、3 行）；多带几行上下文让它只出现一次`
    )
    expect(failure.message).toContain(`steps[3] ${join(root, 'blob.bin')}：现有文件不能当文本改`)
    expect(failure.message).toContain(
      `steps[4] ${join(root, 'missing.txt')}：文件不存在：${join(root, 'missing.txt')}；新建文件用 write`
    )
    for (const step of [0, 5, 6]) expect(failure.message).not.toContain(`steps[${step}]`)
    // 完整的问题清单另放在 context 里给宿主：每条只有第几步、哪个文件、哪一类、说明
    expect(failure.context).toEqual({
      executionOutcome: 'not-applied',
      problems: [
        {
          step: 1,
          path: join(root, 'b.txt'),
          reason: 'invalid',
          message: expect.stringContaining('最像的是'),
        },
        {
          step: 2,
          path: join(root, 'c.txt'),
          reason: 'invalid',
          message: expect.stringContaining('出现了 2 次'),
        },
        {
          step: 3,
          path: join(root, 'blob.bin'),
          reason: 'invalid',
          message: expect.stringContaining('二进制'),
        },
        {
          step: 4,
          path: join(root, 'missing.txt'),
          reason: 'invalid',
          message: expect.stringContaining('文件不存在'),
        },
      ],
    })
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta\n  port = 80\n')
    expect(existsSync(join(root, 'fresh'))).toBe(false)
  })

  test('INV-1 一步形状不对，同一个路径后面形状没毛病的几步不再报连带的问题；形状不对的照样逐条报', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const failure = await failureOf(
      fileOperations.edit(
        {
          steps: [
            { action: 'write', path: 'fresh.txt' },
            replaceStep('fresh.txt', 'new', 'newer'),
            { action: 'replace', path: 'fresh.txt', oldText: '', newText: 'x' },
            replaceStep('a.txt', 'alpha', 'ALPHA'),
          ],
        } as never,
        space.context
      )
    )
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.context).toMatchObject({
      problems: [
        { step: 0, message: expect.stringContaining('write 要 text') },
        { step: 2, message: expect.stringContaining('replace 要 oldText') },
      ],
    })
    expect(failure.message).not.toContain('steps[1]')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false)
  })

  test('INV-1 写得下去就整次交给空间落盘：files 是写到的每个文件（按第一次写到的顺序，同一个文件只一项），给一个 changeId', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const result = await fileOperations.edit(
      {
        steps: [
          replaceStep('a.txt', 'alpha', 'ALPHA'),
          writeStep('deep/new.txt', 'one\ntwo\n'),
          replaceStep('a.txt', 'ALPHA\n', 'ALPHA\nbeta\n'),
        ],
      },
      space.context
    )
    expect(result.changeId).not.toBe('')
    expect(result.undoable).toBe(true)
    expect(result.files).toEqual([
      { path: join(root, 'a.txt'), created: false, totalLines: 2 },
      { path: join(root, 'deep', 'new.txt'), created: true, totalLines: 2 },
    ])
    expect(space.commits).toHaveLength(1)
    expect(space.commits[0]?.map((write) => write.target)).toEqual([
      join(root, 'a.txt'),
      join(root, 'deep', 'new.txt'),
    ])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n')
    expect(await readFile(join(root, 'deep', 'new.txt'), 'utf8')).toBe('one\ntwo\n')
    // 回执里的行数就是之后 read 读到的行数
    expect((await readText('a.txt', space.context)).totalLines).toBe(2)
  })

  test('INV-1 同一个文件的几步按顺序接着改：后一步按前一步改完的算（先 write 新建再 replace、连着几次 replace），换个写法、经符号链接指向同一个的也是同一个文件', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'x.txt'), 'one\ntwo\n')
    await writeFile(join(root, 'real.conf'), 'Host a\n')
    await symlink(join(root, 'real.conf'), join(root, 'alias.conf'))
    await writeFile(join(root, 'a.pem'), 'key\n')
    const result = await fileOperations.edit(
      {
        steps: [
          writeStep('made/new.txt', 'a\nb\n'),
          replaceStep('x.txt', 'one', '1'),
          replaceStep('made/new.txt', 'b', 'B'),
          replaceStep('x.txt', '1\ntwo', '1\n2'),
          replaceStep('alias.conf', 'Host a', 'Host b'),
          replaceStep('real.conf', 'Host b', 'Host c'),
          writeStep('a.pem', 'x\n'),
          replaceStep('./sub/../a.pem', 'x', 'y'),
        ],
      },
      space.context
    )
    expect(result.files).toEqual([
      { path: join(root, 'made', 'new.txt'), created: true, totalLines: 2 },
      { path: join(root, 'x.txt'), created: false, totalLines: 2 },
      {
        path: join(root, 'alias.conf'),
        target: join(root, 'real.conf'),
        created: false,
        totalLines: 1,
      },
      { path: join(root, 'a.pem'), created: false, totalLines: 1 },
    ])
    expect(await readFile(join(root, 'made', 'new.txt'), 'utf8')).toBe('a\nB\n')
    expect(await readFile(join(root, 'x.txt'), 'utf8')).toBe('1\n2\n')
    expect(await readFile(join(root, 'real.conf'), 'utf8')).toBe('Host c\n')
    expect((await lstat(join(root, 'alias.conf'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(root, 'a.pem'), 'utf8')).toBe('y\n')
    // 每个文件只落盘一次，写的是几步都走完的样子
    expect(space.commits).toHaveLength(1)
    expect(space.commits[0]).toHaveLength(4)

    // 整次撤回回到第一步之前：改过的回到原样，新建的删掉
    await fileOperations.undo({ changeId: result.changeId }, space.context)
    expect(await readFile(join(root, 'x.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(await readFile(join(root, 'real.conf'), 'utf8')).toBe('Host a\n')
    expect(await readFile(join(root, 'a.pem'), 'utf8')).toBe('key\n')
    expect(existsSync(join(root, 'made', 'new.txt'))).toBe(false)
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
    const failure = await failureOf(
      fileOperations.edit(
        { steps: [writeStep('plain.txt', 'beta\n'), writeStep('second.txt', 'x\n')] },
        space.context
      )
    )
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('这次改动没有写进去')
    expect(failure.context).toEqual({ applied: [] })
    expect(space.commits[0]?.[0]?.expected).toEqual({ exists: true, bytes: Buffer.from(original) })
    expect(await readFile(plain, 'utf8')).toBe(concurrent)
    expect(await readFile(join(root, 'second.txt'), 'utf8')).toBe('second\n')
  })

  test('INV-2 定下改法之后、落盘之前已有的文件被别处改过：整次不写，问题记成 stale；重新提交，replace 按新的内容找原文', async () => {
    await writeFile(join(root, 'app.conf'), 'name=a\nport=80\n')
    await writeFile(join(root, 'second.txt'), 'second\n')
    const space = diskSpace({ root })
    const locate = space.port.locate
    let meddle = true
    space.port.locate = async (path) => {
      if (meddle && path === 'second.txt')
        await writeFile(join(root, 'app.conf'), 'name=b\nport=80\n')
      return locate(path)
    }
    const steps = [replaceStep('app.conf', 'port=80', 'port=81'), writeStep('second.txt', 'x\n')]
    const stale = await failureOf(fileOperations.edit({ steps }, space.context))
    expect(stale.code).toBe(FileErrorCodes.editUnresolved)
    expect(stale.message).toBe(
      `这次改动一个文件都没写，有 1 个问题。steps[0] ${join(root, 'app.conf')}：定下改法之后文件又被别处改过了；重新提交这次 edit（replace 会按新的内容找原文）`
    )
    expect(stale.context).toMatchObject({ problems: [{ step: 0, reason: 'stale' }] })
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'second.txt'), 'utf8')).toBe('second\n')

    // 原样再提交一次：按提交那一刻的内容找原文，别人改的那一行留着
    meddle = false
    await fileOperations.edit({ steps }, space.context)
    expect(await readFile(join(root, 'app.conf'), 'utf8')).toBe('name=b\nport=81\n')
  })

  test('INV-2 新建的核对它仍不存在：定改法期间或者落盘前一刻别人建了同名文件，都不覆盖', async () => {
    const created = diskSpace({ root })
    await fileOperations.edit({ steps: [writeStep('fresh/new.txt', 'hi\n')] }, created.context)
    expect(created.commits[0]?.[0]?.expected).toEqual({ exists: false })

    // 定第二个文件的改法时别人建了它：写之前再核一次，整次不写
    await writeFile(join(root, 'second.txt'), 'second\n')
    const waiting = diskSpace({ root })
    const locate = waiting.port.locate
    waiting.port.locate = async (path) => {
      if (path === 'second.txt') await writeFile(join(root, 'mine.txt'), 'theirs\n')
      return locate(path)
    }
    const stale = await failureOf(
      fileOperations.edit(
        { steps: [writeStep('mine.txt', 'mine\n'), writeStep('second.txt', 'x\n')] },
        waiting.context
      )
    )
    expect(stale.code).toBe(FileErrorCodes.editUnresolved)
    expect(stale.message).toContain(
      `steps[0] ${join(root, 'mine.txt')}：定下改法之后文件又被别处改过了`
    )
    expect(stale.context).toMatchObject({ problems: [{ step: 0, reason: 'stale' }] })
    expect(await readFile(join(root, 'mine.txt'), 'utf8')).toBe('theirs\n')

    // 核完到落盘之间别人建了它：空间拿 expected 核对，不覆盖
    const racing = diskSpace({ root })
    const commit = racing.port.commit
    racing.port.commit = async (writes) => {
      await writeFile(join(root, 'race.txt'), 'theirs\n')
      await commit(writes)
    }
    const raced = await failureOf(
      fileOperations.edit({ steps: [writeStep('race.txt', 'mine\n')] }, racing.context)
    )
    expect(raced.code).toBe('VALIDATION')
    expect(raced.message).toContain('这次改动没有写进去')
    expect(await readFile(join(root, 'race.txt'), 'utf8')).toBe('theirs\n')
  })

  test('INV-2 写到一半出错时，message 点名哪几个已经写进去了，并给出把它们整次撤回的 changeId', async () => {
    await writeFile(join(root, 'one.txt'), 'one\n')
    await writeFile(join(root, 'two.txt'), 'two\n')
    const broken = diskSpace({ root, failOn: (target) => target.endsWith('three.txt') })
    const failure = await failureOf(
      fileOperations.edit(
        {
          steps: [
            writeStep('one.txt', '1\n'),
            replaceStep('two.txt', 'two', '2'),
            writeStep('three.txt', '3\n'),
          ],
        },
        broken.context
      )
    )
    expect(failure.code).toBe('PLATFORM')
    expect(failure.message).toContain('这次改动只写进去了一部分')
    expect(/已经写入的：(.*?)；出错的原因/.exec(failure.message)?.[1]).toBe(
      `${join(root, 'one.txt')}、${join(root, 'two.txt')}`
    )
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
    const nothing = await failureOf(
      fileOperations.edit({ steps: [writeStep('three.txt', '3\n')] }, broken.context)
    )
    expect(nothing.message).toContain('这次改动没有写进去')
    expect(nothing.context).toEqual({ applied: [] })
  })

  test('INV-2 撤回同样核对：撤回前读到的字节在落盘时再核一次，核完之后被改过就不覆盖', async () => {
    await writeFile(join(root, 'deploy.pem'), 'secret\n')
    const change = await fileOperations.edit(
      { steps: [writeStep('deploy.pem', 'rotated\n')] },
      diskSpace({ root }).context
    )
    const space = diskSpace({ root })
    const commit = space.port.commit
    space.port.commit = async (writes) => {
      await writeFile(join(root, 'deploy.pem'), 'rotated again\n')
      await commit(writes)
    }
    const failure = await failureOf(
      fileOperations.undo({ changeId: change.changeId }, space.context)
    )
    expect(failure.code).toBe('VALIDATION')
    expect(space.commits[0]?.[0]).toEqual({
      target: join(root, 'deploy.pem'),
      bytes: Buffer.from('secret\n'),
      expected: { exists: true, bytes: Buffer.from('rotated\n') },
    })
    expect(await readFile(join(root, 'deploy.pem'), 'utf8')).toBe('rotated again\n')
  })
})

describe('文本无损', () => {
  test('INV-3 编码原样保留：UTF-8（带不带 BOM）、UTF-16 两种字节序（带不带 BOM）、GB18030 改完还是原编码，没换到的地方字节不变', async () => {
    const space = diskSpace({ root })
    const before = 'first line\r\n中文第二行\r\n'
    const after = '改过的第一行\r\n中文第二行\r\n'
    const fixtures: Array<{
      name: string
      encoding: TextEncoding
      bytes: (text: string) => Buffer
    }> = [
      { name: 'plain.txt', encoding: 'utf8', bytes: (text) => Buffer.from(text, 'utf8') },
      {
        name: 'bom.txt',
        encoding: 'utf8-bom',
        bytes: (text) =>
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
      },
      {
        name: 'le.txt',
        encoding: 'utf16le',
        bytes: (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
      },
      {
        name: 'be.txt',
        encoding: 'utf16be',
        bytes: (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]),
      },
      {
        name: 'le-nobom.txt',
        encoding: 'utf16le-nobom',
        bytes: (text) => Buffer.from(text, 'utf16le'),
      },
      { name: 'be-nobom.txt', encoding: 'utf16be-nobom', bytes: utf16be },
    ]
    for (const fixture of fixtures) {
      await writeFile(join(root, fixture.name), fixture.bytes(before))
      const file = await readText(fixture.name, space.context)
      expect(`${fixture.name}:${file.encoding}`).toBe(`${fixture.name}:${fixture.encoding}`)
      expect(file.text).toBe('first line\n中文第二行\n')
      await fileOperations.edit(
        { steps: [replaceStep(fixture.name, 'first line', '改过的第一行')] },
        space.context
      )
      expect((await readFile(join(root, fixture.name))).equals(fixture.bytes(after))).toBe(true)
    }

    // GB18030（GBK）：「中文」是 D6D0 CEC4；换进去的新文按 GB18030 编，没换到的地方原样
    const secondLine = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])
    await writeFile(
      join(root, 'gbk.txt'),
      Buffer.concat([Buffer.from('first line\r\n'), secondLine])
    )
    const gbk = await readText('gbk.txt', space.context)
    expect(gbk.encoding).toBe('gb18030')
    expect(gbk.text).toBe('first line\n中文\n')
    await fileOperations.edit(
      { steps: [replaceStep('gbk.txt', 'first line', '改过')] },
      space.context
    )
    expect(
      (await readFile(join(root, 'gbk.txt'))).equals(
        Buffer.concat([textCodec.encode('改过\r\n', 'gb18030'), secondLine])
      )
    ).toBe(true)
    // write 整份写也按原编码
    await fileOperations.edit({ steps: [writeStep('le.txt', '整份\n写\n')] }, space.context)
    expect(
      (await readFile(join(root, 'le.txt'))).equals(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('整份\r\n写\r\n', 'utf16le')])
      )
    ).toBe(true)
  })

  test('INV-3 认不出的不当文本：读是那一项失败（图片指向 velaros:images），已有的二进制文件不许被覆盖、也不许按原文换', async () => {
    const space = diskSpace({ root })
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ])
    await writeFile(join(root, 'shot.png'), png)
    await writeFile(join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
    // 真 PDF 里有二进制流；只是以 %PDF- 开头的文本仍按文本读（见下面的 notes.txt）。
    await writeFile(
      join(root, 'doc.pdf'),
      Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0x9f, 0x00, 0xff])])
    )
    await writeFile(join(root, 'notes.txt'), 'GIF89a is an image format\n')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    await writeFile(join(root, 'ok.txt'), 'ok\n')
    const { files } = await fileOperations.read(
      {
        files: [
          { path: 'shot.png' },
          { path: 'photo.jpg' },
          { path: 'doc.pdf' },
          { path: 'blob.bin' },
          { path: '.' },
          { path: 'ok.txt' },
          { path: 'notes.txt' },
        ],
      },
      space.context
    )
    expect(
      files.map((file) => ('error' in file ? `${file.error.code} ${file.error.message}` : 'ok'))
    ).toEqual([
      expect.stringMatching(/^VALIDATION .*是图片，用 velaros:images 的 view 看/),
      expect.stringMatching(/^VALIDATION .*用 velaros:images/),
      expect.stringMatching(/^VALIDATION .*是 PDF/),
      expect.stringMatching(/^VALIDATION 文件是二进制的/),
      expect.stringMatching(/^VALIDATION 路径是目录/),
      'ok',
      'ok',
    ])

    for (const name of ['blob.bin', 'shot.png']) {
      const original = await readFile(join(root, name))
      for (const step of [writeStep(name, 'text\n'), replaceStep(name, 'PNG', 'text')]) {
        const refused = await failureOf(fileOperations.edit({ steps: [step] }, space.context))
        expect(refused.code).toBe(FileErrorCodes.editUnresolved)
        expect(refused.message).toContain('二进制文件用命令替换')
      }
      expect((await readFile(join(root, name))).equals(original)).toBe(true)
    }
    expect(space.commits).toHaveLength(0)
  })

  test('INV-3 新内容编不回原编码、带 NUL 字节，整次不写，不静默换成替换字符', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0x0a]))
    await writeFile(join(root, 'ok.txt'), 'ok\n')
    const lossy = await failureOf(
      fileOperations.edit(
        {
          steps: [writeStep('ok.txt', 'fine\n'), replaceStep('gbk.txt', '中', '孤立代理项\uD800')],
        },
        space.context
      )
    )
    expect(lossy.code).toBe(FileErrorCodes.editUnresolved)
    expect(lossy.message).toContain(
      `steps[1] ${join(root, 'gbk.txt')}：新内容不能按 gb18030 无损写进这个文件`
    )
    const nul = await failureOf(
      fileOperations.edit(
        { steps: [writeStep('new.txt', 'a\0b'), replaceStep('ok.txt', 'ok', 'o\0k')] },
        space.context
      )
    )
    expect(nul.message).toContain('有 2 个问题')
    expect(nul.message).toContain(`steps[0] ${join(root, 'new.txt')}：新内容里有 NUL 字节`)
    expect(nul.message).toContain(`steps[1] ${join(root, 'ok.txt')}：新内容里有 NUL 字节`)
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'ok.txt'), 'utf8')).toBe('ok\n')
    expect((await readFile(join(root, 'gbk.txt'))).equals(Buffer.from([0xd6, 0xd0, 0x0a]))).toBe(
      true
    )
    expect(existsSync(join(root, 'new.txt'))).toBe(false)
  })

  test('INV-3 符号链接读写它指向的文件，链接本身不变；回执里带上真正读写的 target', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'real.conf'), 'Host a\n')
    await symlink(join(root, 'real.conf'), join(root, 'link.conf'))
    const read = await readText('link.conf', space.context)
    expect(read).toMatchObject({
      path: join(root, 'link.conf'),
      target: join(root, 'real.conf'),
      text: 'Host a\n',
    })
    expect(await readText('real.conf', space.context)).not.toHaveProperty('target')
    const written = await fileOperations.edit(
      { steps: [replaceStep('link.conf', 'Host a', 'Host b')] },
      space.context
    )
    expect(written.files).toEqual([
      {
        path: join(root, 'link.conf'),
        target: join(root, 'real.conf'),
        created: false,
        totalLines: 1,
      },
    ])
    expect(await readFile(join(root, 'real.conf'), 'utf8')).toBe('Host b\n')
    expect((await lstat(join(root, 'link.conf'))).isSymbolicLink()).toBe(true)
  })

  test('INV-3 换行风格照原文件：没换到的行留着自己的换行符，replace 换进去的新文与 write 的 text 按文件为主的换行存；新文件照写', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
    expect((await readText('crlf.txt', space.context)).text).toBe('a\nb\nc\n')
    await fileOperations.edit({ steps: [replaceStep('crlf.txt', 'b', 'B1\nB2')] }, space.context)
    expect(await readFile(join(root, 'crlf.txt'), 'utf8')).toBe('a\r\nB1\r\nB2\r\nc\r\n')
    await fileOperations.edit({ steps: [writeStep('crlf.txt', 'x\ny\n')] }, space.context)
    expect(await readFile(join(root, 'crlf.txt'), 'utf8')).toBe('x\r\ny\r\n')

    // 混着的：CRLF 为主；第二行原来是 \n，没换到就还是 \n
    await writeFile(join(root, 'mixed.txt'), 'one\r\ntwo\nthree\r\n')
    expect((await readText('mixed.txt', space.context)).text).toBe('one\ntwo\nthree\n')
    await fileOperations.edit(
      { steps: [replaceStep('mixed.txt', 'three', 'THREE\nfour')] },
      space.context
    )
    expect(await readFile(join(root, 'mixed.txt'), 'utf8')).toBe('one\r\ntwo\nTHREE\r\nfour\r\n')
    // 换掉的一段跨过了那个 \n：它跟着被换掉，换进去的新文用为主的 \r\n
    await fileOperations.edit(
      { steps: [replaceStep('mixed.txt', 'two\nTHREE', '2\n3')] },
      space.context
    )
    expect(await readFile(join(root, 'mixed.txt'), 'utf8')).toBe('one\r\n2\r\n3\r\nfour\r\n')

    // \n 为主的：夹在中间的 \r\n 没换到就还是 \r\n
    await writeFile(join(root, 'lf-mixed.txt'), 'one\ntwo\r\nthree\n')
    await fileOperations.edit(
      { steps: [replaceStep('lf-mixed.txt', 'one', 'ONE\nnew')] },
      space.context
    )
    expect(await readFile(join(root, 'lf-mixed.txt'), 'utf8')).toBe('ONE\nnew\ntwo\r\nthree\n')

    // 新文件没有原来的风格可照，给什么写什么（UTF-8）
    await fileOperations.edit({ steps: [writeStep('new.txt', 'a\r\nb\n中')] }, space.context)
    expect((await readFile(join(root, 'new.txt'))).equals(Buffer.from('a\r\nb\n中', 'utf8'))).toBe(
      true
    )
  })

  test('INV-3 replace 没换到的地方连结尾有没有换行都照旧；oldText 带上了结尾的换行，换完结尾就照 newText 的样子', async () => {
    const space = diskSpace({ root })
    // [文件, 原文, oldText, newText, 换完的样子]
    const cases: Array<[string, string, string, string, string]> = [
      ['open.txt', 'a\nb', 'b', 'c', 'a\nc'],
      ['open-append.txt', 'a\nb', 'b', 'b\nc', 'a\nb\nc'],
      ['open-first.txt', 'a\nb', 'a', 'x\ny', 'x\ny\nb'],
      ['closed-append.txt', 'a\nb\n', 'b', 'b\nc', 'a\nb\nc\n'],
      ['closed-first.txt', 'a\nb\n', 'a', 'x', 'x\nb\n'],
      ['delete-last.txt', 'a\nb\n', 'b\n', '', 'a\n'],
      ['open-delete-last.txt', 'a\nb', '\nb', '', 'a'],
      ['consume.txt', 'a\nb\n', 'b\n', 'b', 'a\nb'],
      ['crlf-consume.txt', 'a\r\nb\r\n', 'b\n', 'b', 'a\r\nb'],
      ['crlf-open.txt', 'a\r\nb', 'b', 'b\nc', 'a\r\nb\r\nc'],
    ]
    for (const [name, content, oldText, newText, expected] of cases) {
      await writeFile(join(root, name), content)
      const result = await fileOperations.edit(
        { steps: [replaceStep(name, oldText, newText)] },
        space.context
      )
      expect(`${name}:${JSON.stringify(await readFile(join(root, name), 'utf8'))}`).toBe(
        `${name}:${JSON.stringify(expected)}`
      )
      expect(result.files[0]?.totalLines).toBe((await readText(name, space.context)).totalLines)
    }
  })
})

describe('大小分档', () => {
  test('INV-4 20 MB 以内整份读、整份改；多一个字节读写都拒，指向用命令；读的字符预算与文件字节上限是同一个数', async () => {
    // 两个上限是同一个数：否则会漏出一段「字节放行、字符拒绝」的文件，读不了也改不了
    expect(FileLimits.readChars).toBe(FileLimits.fileBytes)
    const space = diskSpace({ root })
    // 正好顶到上限：每行 1 KB，最后一行与别的不一样，好让 replace 只找到它
    const line = `${'x'.repeat(1023)}\n`
    const count = FileLimits.fileBytes / line.length
    await writeFile(join(root, 'edge.log'), `${line.repeat(count - 1)}${'y'.repeat(1023)}\n`)
    const edge = await readText('edge.log', space.context)
    expect(edge.totalLines).toBe(count)
    expect(edge.text.length).toBe(FileLimits.fileBytes)
    // 改完正好还是 20 MB：照改
    const written = await fileOperations.edit(
      { steps: [replaceStep('edge.log', 'y'.repeat(1023), 'z'.repeat(1023))] },
      space.context
    )
    expect(written.files[0]?.totalLines).toBe(count)
    const edited = await readFile(join(root, 'edge.log'))
    expect(edited.byteLength).toBe(FileLimits.fileBytes)
    expect(edited.subarray(-1024).toString('utf8')).toBe(`${'z'.repeat(1023)}\n`)
    // 新写正好 20 MB 的也照写；多一个字节就不写
    await fileOperations.edit(
      { steps: [writeStep('fresh.log', 'w'.repeat(FileLimits.fileBytes))] },
      space.context
    )
    expect((await stat(join(root, 'fresh.log'))).size).toBe(FileLimits.fileBytes)
    const over = await failureOf(
      fileOperations.edit(
        { steps: [writeStep('over.log', 'w'.repeat(FileLimits.fileBytes + 1))] },
        space.context
      )
    )
    expect(over.message).toContain(`超过 ${FileLimits.fileBytes} 字节的上限`)
    expect(existsSync(join(root, 'over.log'))).toBe(false)

    await writeFile(join(root, 'huge.log'), Buffer.alloc(FileLimits.fileBytes + 1, 0x61))
    const [huge, first] = (
      await fileOperations.read(
        { files: [{ path: 'huge.log' }, { path: 'edge.log', range: 1 }] },
        space.context
      )
    ).files
    expect(huge).toEqual({
      path: 'huge.log',
      error: { code: 'VALIDATION', message: expect.stringContaining('用 run 取片段') },
    })
    expect(first).toMatchObject({ startLine: 1, text: 'x'.repeat(1023) })
    for (const step of [writeStep('huge.log', 'x'), replaceStep('huge.log', 'a', 'b')]) {
      const refused = await failureOf(fileOperations.edit({ steps: [step] }, space.context))
      expect(refused.code).toBe(FileErrorCodes.editUnresolved)
      expect(refused.message).toContain('现有文件太大')
      expect(refused.message).toContain('用命令就地改')
    }
  }, 60_000)

  test('INV-4 一批读好几个时，读不下的那个单独算失败、绝不回半份；单独放进一次 read 照样读得下', async () => {
    const space = diskSpace({ root })
    // ASCII：一个字节一个字符，两份 11 MB 加起来才压得过 20 MB 的字符预算
    const body = `${'x'.repeat(1023)}\n`.repeat(11 * 1024)
    await writeFile(join(root, 'first.log'), body)
    await writeFile(join(root, 'second.log'), body)
    await writeFile(join(root, 'note.txt'), 'here\n')
    const batch = await fileOperations.read(
      { files: [{ path: 'first.log' }, { path: 'second.log' }, { path: 'note.txt' }] },
      space.context
    )
    const [first, second, note] = batch.files
    expect(first && 'text' in first ? [first.totalLines, first.text === body] : null).toEqual([
      11 * 1024,
      true,
    ])
    expect(second).toEqual({
      path: 'second.log',
      error: { code: 'VALIDATION', message: expect.stringContaining('单独放进一次 read') },
    })
    expect(note).toMatchObject({ text: 'here\n' })
    const alone = await readText('second.log', space.context)
    expect([alone.totalLines, alone.text === body]).toEqual([11 * 1024, true])
  }, 60_000)
})

describe('作用域由空间注入', () => {
  test('INV-5 越出空间范围的路径（经符号链接越出去的也算）：读的那一项失败，写的那一次整次不写，code 是 FILES_EDIT_DENIED', async () => {
    const space = diskSpace({ root, clamp: true })
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-outside-')))
    try {
      await writeFile(join(outside, 'x.txt'), 'outside\n')
      await symlink(join(outside, 'x.txt'), join(root, 'escape.txt'))
      await writeFile(join(root, 'in.txt'), 'inside\n')
      const read = await fileOperations.read(
        { files: [{ path: join(outside, 'x.txt') }, { path: 'escape.txt' }, { path: 'in.txt' }] },
        space.context
      )
      expect(read.files[0]).toMatchObject({ error: { code: 'PERMISSION' } })
      expect(read.files[1]).toMatchObject({ path: 'escape.txt', error: { code: 'PERMISSION' } })
      expect(read.files[2]).toMatchObject({ path: 'in.txt', text: 'inside\n' })

      for (const escaping of [
        writeStep('../escape-new.txt', 'x\n'),
        replaceStep('escape.txt', 'outside', 'x'),
      ]) {
        const failure = await failureOf(
          fileOperations.edit(
            { steps: [writeStep('in.txt', 'changed\n'), escaping] },
            space.context
          )
        )
        expect(failure.code).toBe(FileErrorCodes.editDenied)
        expect(failure.message).toContain(`steps[1] ${escaping.path}：`)
        expect(failure.context).toMatchObject({ problems: [{ step: 1, reason: 'denied' }] })
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
  test('INV-6 模型写的程序照生成的声明调到真实操作：读真文件、在程序里按 startLine 数行号筛、只交出要的', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1\n// TODO: 补这里\n')
    await writeFile(join(root, 'b.ts'), '干净文件，没有待办\n')
    const result = await runModelProgram(
      diskSpace({ root, clamp: true }),
      `import { read } from 'velaros:files'
const r = await read({ files: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'missing.ts' }] })
export default r.files.flatMap((f) => ('error' in f ? [\`\${f.path}: \${f.error.code}\`] : f.text.split('\\n').flatMap((text, index) => (text.includes('TODO') ? [\`\${f.path}:\${f.startLine + index}\`] : []))))`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual(['a.ts:2', 'missing.ts: NOT_FOUND'])
  }, 60_000)

  test('INV-6 语法错的程序过不了检查，一行都不执行', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const space = diskSpace({ root, clamp: true })
    const outcome = await submitModelProgram(
      space,
      `import { edit, read } from 'velaros:files'
await edit({ steps: [{ action: 'write', path: 'made.txt', text: '这一行不该跑' }] })
const [file] = (await read({ files: [{ path: 'a.txt' }] })).files
export default file.text.length)`
    )
    if (outcome.checked || !('check' in outcome)) throw new Error('应当被检查挡回去')
    expect([...new Set(outcome.check.diagnostics.map((diagnostic) => diagnostic.line))]).toEqual([
      4,
    ])
    expect(existsSync(join(root, 'made.txt'))).toBe(false)
    expect(space.located).toHaveLength(0)
    expect(space.commits).toHaveLength(0)
  }, 60_000)

  test('INV-6 程序里按路径改、拿 changeId 再撤回：两段程序走的都是真操作，同一个文件的两步接着改，换行风格原样', async () => {
    const original = 'name=demo\r\nport=8080\r\n'
    await writeFile(join(root, 'app.conf'), original)
    const space = diskSpace({ root, clamp: true })
    const edited = await runModelProgram(
      space,
      `import { edit, read } from 'velaros:files'
const [file] = (await read({ files: [{ path: 'app.conf' }] })).files
if ('error' in file) throw new Error(file.error.message)
const port = file.text.split('\\n').find((text) => text.startsWith('port='))
if (!port) throw new Error('没有 port 这一行')
const result = await edit({
  steps: [
    { action: 'replace', path: 'app.conf', oldText: port, newText: 'port=9090' },
    { action: 'replace', path: 'app.conf', oldText: 'port=9090\\n', newText: 'port=9090\\ndebug=true\\n' },
  ],
})
export default { changeId: result.changeId, files: result.files.map((f) => \`\${f.path} \${f.totalLines}\`) }`
    )
    expect(edited.failed).toBeUndefined()
    const { changeId, files } = edited.value as { changeId: string; files: string[] }
    expect(files).toEqual(['app.conf 3'])
    expect(await readFile(join(root, 'app.conf'), 'utf8')).toBe(
      'name=demo\r\nport=9090\r\ndebug=true\r\n'
    )

    const reverted = await runModelProgram(
      space,
      `import { undo } from 'velaros:files'
const result = await undo({ changeId: ${JSON.stringify(changeId)} })
export default result.files.map((f) => \`\${f.path} \${f.action}\`)`
    )
    expect(reverted.value).toEqual(['app.conf restored'])
    expect(await readFile(join(root, 'app.conf'), 'utf8')).toBe(original)
  }, 60_000)

  test('INV-6 大文件穿过隔离：十几 MB 的正文读进程序、在程序里改好整份写回去，模型只看到一行摘要', async () => {
    const lines = Array.from(
      { length: 400_000 },
      (_, index) => `${index % 997 === 0 ? 'ERROR' : 'INFO '} line ${index} ${'-'.repeat(12)}`
    )
    await writeFile(join(root, 'big.log'), `${lines.join('\n')}\n`)
    const result = await runModelProgram(
      diskSpace({ root }),
      `import { edit, read } from 'velaros:files'
const [file] = (await read({ files: [{ path: 'big.log' }] })).files
if ('error' in file) throw new Error(file.error.message)
const fixed = file.text.split('\\n').filter((text) => text.startsWith('ERROR')).length
const written = await edit({ steps: [{ action: 'write', path: 'big.log', text: file.text.replace(/^ERROR/gm, 'FIXED') }] })
export default { chars: file.text.length, fixed, undoable: written.undoable, totalLines: written.files[0].totalLines }`,
      60_000
    )
    expect(result.failed).toBeUndefined()
    const value = result.value as {
      chars: number
      fixed: number
      undoable: boolean
      totalLines: number
    }
    expect(value.chars).toBeGreaterThan(10_000_000)
    expect(value.fixed).toBe(402)
    expect(value.totalLines).toBe(400_000)
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
    const result = await runModelProgram(
      diskSpace({ root }),
      `import { edit, undo } from 'velaros:files'
const outcome = []
try {
  await edit({ steps: [{ action: 'replace', path: 'a.txt', oldText: 'alpha\\nbeta', newText: 'x' }] })
  outcome.push('没拦住')
} catch (error) {
  outcome.push({ code: error.code, near: error.message.includes('最像的是第 1 行「alpha」') })
}
try {
  await undo({ changeId: 'change-0-nothing' })
  outcome.push('没拦住')
} catch (error) {
  outcome.push({ code: error.code })
}
export default outcome`
    )
    expect(result.value).toEqual([
      { code: FileErrorCodes.editUnresolved, near: true },
      { code: 'NOT_FOUND' },
    ])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
  }, 60_000)
})

describe('入参', () => {
  test('INV-7 一批的形状不对一律 VALIDATION：不是对象、files / steps 不是数组、空批、项不是对象、超过批量或步数上限，碰不到空间', async () => {
    const space = diskSpace({ root })
    const shapes = (key: string): unknown[] => [
      undefined,
      null,
      'x',
      [],
      { [key]: '不是数组' },
      { [key]: [] },
      { [key]: ['a.txt'] },
      { [key]: [null] },
    ]
    for (const input of shapes('files'))
      expect((await failureOf(fileOperations.read(input as never, space.context))).code).toBe(
        'VALIDATION'
      )
    for (const input of shapes('steps'))
      expect((await failureOf(fileOperations.edit(input as never, space.context))).code).toBe(
        'VALIDATION'
      )
    // 旧写法（每个文件一项、newText 整份写）不认：没有 steps
    expect(
      (
        await failureOf(
          fileOperations.edit({ files: [{ path: 'a.txt', newText: 'x' }] } as never, space.context)
        )
      ).message
    ).toBe('缺少 steps：edit 要 { steps: [...] }，每步一项')
    const reads = Array.from({ length: FileLimits.readFiles + 1 }, (_, index) => ({
      path: `${index}.txt`,
    }))
    expect(
      (await failureOf(fileOperations.read({ files: reads }, space.context))).message
    ).toContain(`最多 ${FileLimits.readFiles} 个文件`)
    const steps = Array.from({ length: FileLimits.editSteps + 1 }, () => writeStep('a.txt', 'x'))
    expect((await failureOf(fileOperations.edit({ steps }, space.context))).message).toBe(
      `edit 一次最多 ${FileLimits.editSteps} 步，这里给了 ${FileLimits.editSteps + 1} 步；分几次调用`
    )
    expect(space.located).toHaveLength(0)
    expect(space.commits).toHaveLength(0)
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  test('INV-7 一次碰到的文件超过上限是 VALIDATION、一个文件都不写；正好到上限（20 个文件、一共 1000 步）照样一次改完', async () => {
    const space = diskSpace({ root })
    const tooMany = Array.from({ length: FileLimits.editFiles + 1 }, (_, index) =>
      writeStep(`${index}.txt`, 'x\n')
    )
    const refused = await failureOf(fileOperations.edit({ steps: tooMany }, space.context))
    expect(refused.code).toBe('VALIDATION')
    expect(refused.message).toBe(
      `edit 一次最多改 ${FileLimits.editFiles} 个文件，steps[${FileLimits.editFiles}] 碰到了第 ${FileLimits.editFiles + 1} 个；分几次调用`
    )
    expect(space.commits).toHaveLength(0)
    expect(existsSync(join(root, '0.txt'))).toBe(false)

    // 每个文件先 write 新建，再一步一步往上数：同一个文件的几步只算一个文件
    const perFile = FileLimits.editSteps / FileLimits.editFiles
    const steps = Array.from({ length: FileLimits.editFiles }, (_, file) => [
      writeStep(`${file}.txt`, '0\n'),
      ...Array.from({ length: perFile - 1 }, (_, index) =>
        replaceStep(`${file}.txt`, `${index}\n`, `${index + 1}\n`)
      ),
    ]).flat()
    expect(steps).toHaveLength(FileLimits.editSteps)
    const result = await fileOperations.edit({ steps }, space.context)
    expect(result.files).toHaveLength(FileLimits.editFiles)
    expect(await readFile(join(root, '0.txt'), 'utf8')).toBe(`${perFile - 1}\n`)
    expect(await readFile(join(root, `${FileLimits.editFiles - 1}.txt`), 'utf8')).toBe(
      `${perFile - 1}\n`
    )
  }, 30_000)

  test('INV-7 读的一项不合法只那一项失败：path 不是字符串、range 不是合法的行号；全都不合法时整个调用报 VALIDATION', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\nb\n')
    const items = [
      { path: 3 },
      { path: '' },
      { path: 'a.txt', range: 0 },
      { path: 'a.txt', range: [2, 1] },
      { path: 'a.txt', range: '1-2' },
      { path: 'a.txt', range: [1, 2, 3] },
      { path: 'a.txt', range: 1.5 },
      { path: 'a.txt', range: [1, 2] },
    ]
    const result = await fileOperations.read({ files: items } as never, space.context)
    expect(result.files.map((file) => ('error' in file ? file.error.code : 'ok'))).toEqual([
      ...Array.from({ length: 7 }, () => 'VALIDATION'),
      'ok',
    ])
    expect(result.files[3]).toMatchObject({
      error: { message: expect.stringContaining('range 要行号或 [首行, 末行]') },
    })
    expect(
      (await failureOf(fileOperations.read({ files: [{ path: 3 }] } as never, space.context))).code
    ).toBe('VALIDATION')
  })

  test('INV-7 写的一步不合法进 FILES_EDIT_UNRESOLVED 的问题清单：action 不认得、path / text / newText 不是字符串、oldText 是空的，逐条点名，一个文件都不写', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    const failure = await failureOf(
      fileOperations.edit(
        {
          steps: [
            { action: 'write', path: 3, text: 'x' },
            { action: 'insert', path: 'n1.txt', text: 'x' },
            { action: 'write', path: 'n2.txt' },
            { action: 'write', path: 'n3.txt', text: 42 },
            { action: 'replace', path: 'a.txt', oldText: '', newText: 'x' },
            { action: 'replace', path: 'a.txt', oldText: 7, newText: 'x' },
            { action: 'replace', path: 'b.txt', oldText: 'b', newText: 3 },
            { path: 'n4.txt', newText: 'x' },
            { action: 'replace', path: '  ', oldText: 'a', newText: 'x' },
          ],
        } as never,
        space.context
      )
    )
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('有 9 个问题')
    for (const [index, reason] of [
      '每一步都要有 path（字符串）',
      'action 要 write（整份写）或 replace（把一段原文换掉），这里给的是 "insert"',
      'write 要 text（字符串）',
      'write 要 text（字符串）',
      'replace 要 oldText（非空字符串）',
      'replace 要 oldText（非空字符串）',
      'replace 要 newText（字符串）',
      '这里给的是 undefined',
      '每一步都要有 path（字符串）',
    ].entries()) {
      expect(failure.message).toMatch(
        new RegExp(`steps\\[${index}\\] [^；]*${reason.replace(/[[\]()]/g, '\\$&')}`)
      )
    }
    expect(failure.context).toMatchObject({
      problems: Array.from({ length: 9 }, (_, step) => ({ step, reason: 'invalid' })),
    })
    // 形状不对的步碰不到空间：一个路径都没定位
    expect(space.located).toHaveLength(0)
    expect(space.commits).toHaveLength(0)
    expect(
      ['n1.txt', 'n2.txt', 'n3.txt', 'n4.txt'].some((name) => existsSync(join(root, name)))
    ).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n')
  })

  test('INV-7 什么样的入参都不会让操作半途崩：抛出来的一律是带码的 AppError；undo 没给 changeId 是 VALIDATION', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    const junk: unknown[] = [
      undefined,
      0,
      {},
      { steps: null },
      { steps: [{}] },
      { steps: [{ action: 'write' }] },
      { steps: [{ action: 'write', path: null, text: 'x' }] },
      { steps: [{ action: 'write', path: 'a.txt', text: {} }] },
      { steps: [{ action: ['write'], path: 'a.txt', text: 'x' }] },
      { steps: [{ action: 'write', path: '.', text: 'x' }] },
      { steps: [{ action: 'replace', path: {}, oldText: 'a', newText: 'x' }] },
      { steps: [{ action: 'replace', path: 'a.txt', oldText: null, newText: 'x' }] },
      { steps: [{ action: 'replace', path: 'a.txt', oldText: 'a', newText: [] }] },
      { steps: [{ action: 'replace', path: 'a.txt', oldText: 'zzz', newText: 'x' }] },
      {
        steps: Array.from({ length: FileLimits.editSteps + 1 }, () =>
          writeStep('a.txt', 'overwritten\n')
        ),
      },
      { files: null },
      { files: [{}] },
      { files: [{ path: null }] },
      { files: [{ path: 'a.txt', range: {} }] },
      { files: [{ path: 'a.txt', newText: 'x', version: {} }] },
      { changeId: {} },
      { changeId: '' },
    ]
    for (const input of junk) {
      const operations = [
        () => fileOperations.read(input as never, space.context),
        () => fileOperations.edit(input as never, space.context),
        () => fileOperations.undo(input as never, space.context),
      ]
      for (const operation of operations) {
        const outcome = await operation().then(
          () => null,
          (error: unknown) => error
        )
        if (outcome === null) continue
        expect(outcome).toBeInstanceOf(AppError)
        expect(['VALIDATION', FileErrorCodes.editUnresolved]).toContain((outcome as AppError).code)
      }
    }
    for (const input of [undefined, null, 'x', {}, { changeId: 3 }, { changeId: '  ' }]) {
      expect((await failureOf(fileOperations.undo(input as never, space.context))).code).toBe(
        'VALIDATION'
      )
    }
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n')
  })
})

describe('模型面', () => {
  test('INV-9 代码模版整份照真实声明过类型检查，import 只写一次；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(resolve(UnitRoot, 'template.js'), 'utf8')
    const checked = codeProgramChecker.typecheck({
      source: template,
      granted: [{ namespace: 'files', declarations: Declarations }],
    })
    expect(checked.ok ? [] : checked.diagnostics).toEqual([])
    expect(template.match(/^import /gm)).toHaveLength(1)
    expect(VelarFilesModule.template).toBe(template.trim())
    expect(Declarations).not.toContain('的代码模版')
  })

  test('INV-10 声明里写的上限与错误码和常量表一致；模型面上没有空间端口、调用上下文，也没有看图', () => {
    const mb = (bytes: number): string => `${bytes / 1024 / 1024} MB`
    expect(docBefore('interface FileReadInput')).toContain(`一批最多 ${FileLimits.readFiles} 个`)
    expect(docBefore('interface FileEditInput')).toContain(
      `一次最多 ${FileLimits.editSteps} 步、${FileLimits.editFiles} 个文件`
    )
    expect(docBefore('interface FileReadItem')).toContain(
      `单个文件最大 ${mb(FileLimits.fileBytes)}`
    )
    expect(docBefore('export function read')).toContain(`超过 ${mb(FileLimits.fileBytes)} 的文件`)
    expect(docBefore('interface FileEditResult')).toContain(`超过 ${mb(FileLimits.undoBytes)}`)
    expect(docBefore('interface FileUndoInput')).toContain(`只留最近 ${FileLimits.undoChanges} 次`)
    expect(docBefore('export function undo')).toContain(`只留最近 ${FileLimits.undoChanges} 次`)
    expect(docBefore('interface FileEditResult')).toContain(FileErrorCodes.editUnresolved)
    expect(docBefore('interface FileEditResult')).toContain(FileErrorCodes.editDenied)
    expect(docBefore('interface FileUndoResult')).toContain(FileErrorCodes.undoConflict)
    // 声明只有三个方法，签名里没有宿主的上下文
    expect(Declarations.match(/export function \w+/g)).toEqual([
      'export function read',
      'export function edit',
      'export function undo',
    ])
    expect(Declarations).toContain(
      'export function read(input: FileReadInput): Promise<FileReadResult>'
    )
    for (const hidden of [
      'FileSpacePort',
      'FileOperationContext',
      'FileWrite',
      'FileLocation',
      'locate',
      'commit',
      'abortSignal',
    ]) {
      expect(`${hidden}:${Declarations.includes(hidden)}`).toBe(`${hidden}:false`)
    }
    expect(Declarations).toContain('看图片用 `velaros:images`')
  })
})

describe('行：数法、连续正文与按原文换', () => {
  test('INV-12 行号的数法和 wc -l 一样：结尾的换行不多出一行，最后一行没换行也算一行，空文件是 0 行；read 交回连续的正文，换行一律是 \\n', async () => {
    const space = diskSpace({ root })
    // [文件, 原文, 行数, 读到的正文]
    const cases: Array<[string, string, number, string]> = [
      ['closed.txt', 'a\nb\n', 2, 'a\nb\n'],
      ['open.txt', 'a\nb', 2, 'a\nb'],
      ['empty.txt', '', 0, ''],
      ['blank.txt', '\n', 1, '\n'],
      ['blanks.txt', '\r\n\r\n', 2, '\n\n'],
      ['crlf.txt', 'a\r\nb', 2, 'a\nb'],
    ]
    for (const [name, content, totalLines, text] of cases) {
      await writeFile(join(root, name), content)
      const file = await readText(name, space.context)
      expect(`${name}:${file.totalLines}:${file.startLine}:${JSON.stringify(file.text)}`).toBe(
        `${name}:${totalLines}:1:${JSON.stringify(text)}`
      )
      // 只交正文与第一行的行号：没有逐行的 [行号, 原文]，也没有 version
      expect(Object.keys(file).sort()).toEqual([
        'encoding',
        'path',
        'startLine',
        'text',
        'totalLines',
      ])
    }
    // 结尾有换行的文件，行数就是 wc -l 数出来的
    await writeFile(join(root, 'log.txt'), 'one\ntwo\nthree\n')
    const log = await readText('log.txt', space.context)
    if (process.platform !== 'win32') {
      const counted = Bun.spawnSync(['wc', '-l', join(root, 'log.txt')])
        .stdout.toString()
        .trim()
        .split(/\s+/)[0]
      expect(String(log.totalLines)).toBe(counted)
    }
  })

  test('INV-12 range 只交那几行：startLine 是首行的行号，读到文件末尾时结尾的换行照原样在；末行超出就收到最后一行，首行超出就那一项失败', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'log.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(root, 'open.txt'), 'one\ntwo')
    await writeFile(join(root, 'empty.txt'), '')
    expect(await readText('log.txt', space.context, [2, 99])).toMatchObject({
      totalLines: 3,
      startLine: 2,
      text: 'two\nthree\n',
    })
    expect(await readText('log.txt', space.context, 3)).toMatchObject({
      startLine: 3,
      text: 'three\n',
    })
    expect(await readText('log.txt', space.context, [1])).toMatchObject({
      startLine: 1,
      text: 'one',
    })
    expect(await readText('log.txt', space.context, [1, 2])).toMatchObject({
      startLine: 1,
      text: 'one\ntwo',
    })
    expect(await readText('open.txt', space.context, [2, 5])).toMatchObject({
      totalLines: 2,
      startLine: 2,
      text: 'two',
    })
    expect(await readText('empty.txt', space.context, 1)).toMatchObject({
      totalLines: 0,
      startLine: 1,
      text: '',
    })
    const [beyond, emptyBeyond, whole] = (
      await fileOperations.read(
        {
          files: [
            { path: 'log.txt', range: [4, 5] },
            { path: 'empty.txt', range: 2 },
            { path: 'log.txt' },
          ],
        },
        space.context
      )
    ).files
    expect(beyond).toMatchObject({
      path: 'log.txt',
      error: {
        code: 'VALIDATION',
        message: expect.stringContaining('只有 3 行，range 从第 4 行起'),
      },
    })
    expect(emptyBeyond).toMatchObject({
      error: { message: expect.stringContaining('只有 0 行，range 从第 2 行起') },
    })
    expect(whole).toMatchObject({ startLine: 1, text: 'one\ntwo\nthree\n' })
  })

  test('INV-12 整份读出来原样 write 回去字节不变：LF、CRLF、结尾没有换行、空文件、全是空行，带 BOM 的 UTF-16 与 GB18030 也一样', async () => {
    const space = diskSpace({ root })
    const fixtures: Array<[string, Buffer]> = [
      ['lf.txt', Buffer.from('a\nb\n')],
      ['crlf.txt', Buffer.from('a\r\nb\r\n')],
      ['open.txt', Buffer.from('a\nb')],
      ['crlf-open.txt', Buffer.from('a\r\nb')],
      ['empty.txt', Buffer.alloc(0)],
      ['blanks.txt', Buffer.from('\n\n\n')],
      // 混着 CRLF 与 LF 的、行里夹着零碎 \r 的：原样写回来什么都不动，不换成为主的那种换行
      ['mixed.txt', Buffer.from('one\r\ntwo\nthree\r\n')],
      ['stray-cr.txt', Buffer.from('a\r\r\nb\n')],
      [
        'utf16.txt',
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('名字\r\n端口\r\n', 'utf16le')]),
      ],
      // 0x80 在 GB18030 里解成 €，重新编码却写成 A2 E3：原样写回去也得留着 0x80
      ['gb.txt', Buffer.from([0x80, 0x0d, 0x0a, 0xd6, 0xd0, 0x0d, 0x0a])],
    ]
    for (const [name, bytes] of fixtures) {
      await writeFile(join(root, name), bytes)
      const file = await readText(name, space.context)
      const result = await fileOperations.edit(
        { steps: [writeStep(name, file.text)] },
        space.context
      )
      expect(`${name}:${(await readFile(join(root, name))).equals(bytes)}`).toBe(`${name}:true`)
      expect(result.files[0]?.totalLines).toBe(file.totalLines)
    }
  })

  test('INV-12 replace 按 \\n 比对原文：文件里的 \\r\\n 看成 \\n，读到的正文原样抄进 oldText 就对得上；要在提交那一刻的内容里一模一样地出现且只出现一次', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'app.ini'), '[a]\r\nkey=1\r\n[b]\r\nkey=1\r\n')
    const ini = await readText('app.ini', space.context)
    // 只抄一行：两处都有，不唯一，说出在第几行
    const twice = await failureOf(
      fileOperations.edit({ steps: [replaceStep('app.ini', 'key=1', 'key=2')] }, space.context)
    )
    expect(twice.message).toContain(
      'oldText 在文件里出现了 2 次（第 2、4 行）；多带几行上下文让它只出现一次'
    )
    // 多抄一行上下文（跨过换行）就唯一了
    const section = ini.text.split('\n').slice(2, 4).join('\n')
    expect(section).toBe('[b]\nkey=1')
    await fileOperations.edit(
      { steps: [replaceStep('app.ini', section, '[b]\nkey=2')] },
      space.context
    )
    expect(await readFile(join(root, 'app.ini'), 'utf8')).toBe('[a]\r\nkey=1\r\n[b]\r\nkey=2\r\n')
    // 空白要一模一样：多一个空格就找不到，说明里给出最像的那一行
    const spaced = await failureOf(
      fileOperations.edit({ steps: [replaceStep('app.ini', '[a] \nkey=1', 'x')] }, space.context)
    )
    expect(spaced.message).toContain(
      'oldText 在文件里没有一模一样的原文，最像的是第 1 行「[a]」；照那里的原文写 oldText'
    )

    // 读完之后别处又改了：replace 按提交那一刻的内容找原文，别处改的留着；要换的那段被改掉了就找不到
    await writeFile(join(root, 'notes.txt'), 'port=80\nname=a\n')
    const notes = await readText('notes.txt', space.context)
    await writeFile(join(root, 'notes.txt'), 'port=80\nname=b\n')
    await fileOperations.edit(
      { steps: [replaceStep('notes.txt', notes.text.split('\n')[0]!, 'port=81')] },
      space.context
    )
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('port=81\nname=b\n')
    const gone = await failureOf(
      fileOperations.edit({ steps: [replaceStep('notes.txt', 'name=a', 'name=c')] }, space.context)
    )
    expect(gone.code).toBe(FileErrorCodes.editUnresolved)
    expect(gone.message).toContain('没有一模一样的原文')
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('port=81\nname=b\n')
  })
})

describe('撤回', () => {
  test('INV-13 undo 把一次改动整次撤回：改过的回到改动前的字节，新建的删掉，经符号链接改的写回它指向的文件', async () => {
    const space = diskSpace({ root })
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('名字=旧\r\n端口=80\r\n', 'utf16le'),
    ])
    await writeFile(join(root, 'utf16.ini'), utf16)
    await writeFile(join(root, 'real.conf'), 'Host a\n')
    await symlink(join(root, 'real.conf'), join(root, 'link.conf'))
    const change = await fileOperations.edit(
      {
        steps: [
          replaceStep('utf16.ini', '端口=80', '端口=8080'),
          writeStep('link.conf', 'Host b\n'),
          writeStep('made/fresh.txt', 'new\n'),
        ],
      },
      space.context
    )
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
    const change = await fileOperations.edit(
      {
        steps: [writeStep('a.txt', 'A\n'), writeStep('b.txt', 'B\n'), writeStep('c.txt', 'C\n')],
      },
      space.context
    )
    await writeFile(join(root, 'b.txt'), 'someone else\n')
    await unlink(join(root, 'c.txt'))
    const conflict = await failureOf(
      fileOperations.undo({ changeId: change.changeId }, space.context)
    )
    expect(conflict.code).toBe(FileErrorCodes.undoConflict)
    expect(conflict.message).toContain('一个文件都没撤')
    // message 点名又被改过的是哪几个
    expect(conflict.message).toContain(join(root, 'b.txt'))
    // 那次新建、现在已经不在的文件不算冲突：撤回本来就是把它删掉（上一次撤回做了一半时就是这个样子）。
    expect(conflict.message).not.toContain(join(root, 'c.txt'))
    expect(conflict.message).not.toContain(join(root, 'a.txt'))
    // 模型面上没有版本号，说明里也不写哈希
    expect(conflict.message).not.toMatch(/[0-9a-f]{12}/)
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
    const change = await fileOperations.edit(
      { steps: [replaceStep('a.txt', 'a', 'A')] },
      space.context
    )
    await fileOperations.undo({ changeId: change.changeId }, space.context)
    await writeFile(join(root, 'a.txt'), 'later\n')
    expect(await fileOperations.undo({ changeId: change.changeId }, space.context)).toEqual({
      changeId: change.changeId,
      alreadyUndone: true,
      files: [],
    })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('later\n')
    expect(space.commits).toHaveLength(2)
    const unknown = await failureOf(
      fileOperations.undo({ changeId: 'change-0-nothing' }, space.context)
    )
    expect(unknown.code).toBe('NOT_FOUND')
    expect(unknown.message).toContain('change-0-nothing')
  })

  test('INV-13 改之前超过 2 MB 的原文不留：那次改动 undoable 为 false，undo 报 VALIDATION，文件照改过的样子', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'big.log'), 'x'.repeat(FileLimits.undoBytes + 1))
    await writeFile(join(root, 'small.txt'), 'small\n')
    const change = await fileOperations.edit(
      { steps: [writeStep('small.txt', 'SMALL\n'), writeStep('big.log', 'short now\n')] },
      space.context
    )
    expect(change.undoable).toBe(false)
    const refused = await failureOf(
      fileOperations.undo({ changeId: change.changeId }, space.context)
    )
    expect(refused.code).toBe('VALIDATION')
    expect(refused.message).toContain('撤不回')
    expect(await readFile(join(root, 'big.log'), 'utf8')).toBe('short now\n')
    expect(await readFile(join(root, 'small.txt'), 'utf8')).toBe('SMALL\n')

    // 正好 2 MB 的还留着原文
    await writeFile(join(root, 'edge.log'), 'y'.repeat(FileLimits.undoBytes))
    const edge = await fileOperations.edit(
      { steps: [writeStep('edge.log', 'short\n')] },
      space.context
    )
    expect(edge.undoable).toBe(true)
    await fileOperations.undo({ changeId: edge.changeId }, space.context)
    expect((await readFile(join(root, 'edge.log'), 'utf8')).length).toBe(FileLimits.undoBytes)
  })

  test('INV-13 只留最近 50 次改动：更早的撤不回（NOT_FOUND），最近的还能撤', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'counter.txt'), '0\n')
    const first = await fileOperations.edit(
      { steps: [writeStep('counter.txt', '1\n')] },
      space.context
    )
    let last = first
    for (let index = 2; index <= FileLimits.undoChanges + 1; index += 1) {
      last = await fileOperations.edit(
        { steps: [replaceStep('counter.txt', `${index - 1}\n`, `${index}\n`)] },
        space.context
      )
    }
    const expired = await failureOf(
      fileOperations.undo({ changeId: first.changeId }, space.context)
    )
    expect(expired.code).toBe('NOT_FOUND')
    expect(expired.message).toContain(`只留最近 ${FileLimits.undoChanges} 次`)
    await fileOperations.undo({ changeId: last.changeId }, space.context)
    expect(await readFile(join(root, 'counter.txt'), 'utf8')).toBe(`${FileLimits.undoChanges}\n`)
  })
})

describe('本机文件端口', () => {
  test('INV-14 读写凭证文件与系统敏感路径不问用户：经符号链接改私钥、读私钥、撤回照常，`~/.ssh` 里的新建、读、撤回也一样', async () => {
    // 家目录换成用例自己的临时目录：`~` 展开到这里，和宿主给的 resolvePath 一样。上下文里本来就没有审批端口，问不了人。
    const home = join(root, 'home')
    await mkdir(join(home, '.ssh'), { recursive: true })
    const { context } = localFileSpace({ cwd: root, home })
    await writeFile(join(root, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n')
    await symlink(join(root, 'deploy.pem'), join(root, 'notes.txt'))
    const edited = await fileOperations.edit(
      { steps: [replaceStep('notes.txt', 'abc', 'rotated')] },
      context
    )
    expect(edited.files).toMatchObject([
      { path: join(root, 'notes.txt'), target: join(root, 'deploy.pem') },
    ])
    expect(await readFile(join(root, 'deploy.pem'), 'utf8')).toBe(
      '-----BEGIN PRIVATE KEY-----\nrotated\n'
    )
    expect((await lstat(join(root, 'notes.txt'))).isSymbolicLink()).toBe(true)
    expect((await readText('deploy.pem', context)).text).toBe(
      '-----BEGIN PRIVATE KEY-----\nrotated\n'
    )
    const undone = await fileOperations.undo({ changeId: edited.changeId }, context)
    expect(undone.files).toMatchObject([{ action: 'restored' }])
    expect(await readFile(join(root, 'deploy.pem'), 'utf8')).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc\n'
    )

    const created = await fileOperations.edit(
      { steps: [writeStep('~/.ssh/id_ed25519', 'KEY\n')] },
      context
    )
    expect(created.files).toMatchObject([{ path: join(home, '.ssh', 'id_ed25519'), created: true }])
    expect((await readText('~/.ssh/id_ed25519', context)).text).toBe('KEY\n')
    await fileOperations.undo({ changeId: created.changeId }, context)
    expect(existsSync(join(home, '.ssh', 'id_ed25519'))).toBe(false)
  })

  test('INV-15 落盘核对计划时的字节：定下改法之后文件被同尺寸、同修改时间地改掉，也不覆盖（VALIDATION，message 说明被别人改了）', async () => {
    const plain = join(root, 'plain.txt')
    // 超过 64 KB：这么大的文件落盘前只看「大小 + 修改时间」，两样都没变就不重读（小文件一律重读，拦不到这里）。
    const concurrent = `${'z'.repeat(100 * 1024)}\n`
    const pinned = 1_700_000_000
    // 定第二个文件的改法时，别人把第一个文件改成同样长度的内容，并把修改时间拨回整数秒。
    const { context } = localFileSpace({
      cwd: root,
      onResolve: (path) => {
        if (path !== 'second.txt') return
        writeFileSync(plain, concurrent)
        utimesSync(plain, pinned, pinned)
      },
    })
    await writeFile(plain, `${'a'.repeat(100 * 1024)}\n`)
    await utimes(plain, pinned, pinned)
    await writeFile(join(root, 'second.txt'), 'second\n')
    const failure = await failureOf(
      fileOperations.edit(
        { steps: [writeStep('plain.txt', 'beta\n'), writeStep('second.txt', 'x\n')] },
        context
      )
    )
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('被别人改了')
    expect(await readFile(plain, 'utf8')).toBe(concurrent)
    expect(await readFile(join(root, 'second.txt'), 'utf8')).toBe('second\n')
  })

  test('INV-15 新建的核对它仍不存在：落盘那一刻同名文件已经有了就不覆盖（VALIDATION）；缺的上级目录补建', async () => {
    const { port } = localFileSpace({ cwd: root })
    const fresh = join(root, 'fresh.txt')
    await writeFile(fresh, 'someone else\n')
    const refused = await failureOf(
      port.commit([{ target: fresh, bytes: Buffer.from('mine\n'), expected: { exists: false } }])
    )
    expect(refused).toMatchObject({ code: 'VALIDATION', context: { applied: [] } })
    expect(refused.message).toContain('被别人改了')
    expect(await readFile(fresh, 'utf8')).toBe('someone else\n')
    const nested = join(root, 'deep', 'er', 'new.txt')
    await port.commit([
      { target: nested, bytes: Buffer.from('mine\n'), expected: { exists: false } },
    ])
    expect(await readFile(nested, 'utf8')).toBe('mine\n')
  })

  test('INV-16 撤回写回改之前的字节、删掉那次新建的文件；那之后别人又改过就整个不撤（FILES_UNDO_CONFLICT）；整份写照原文件的换行风格存', async () => {
    const { context } = localFileSpace({ cwd: root })
    await writeFile(join(root, 'kept.txt'), 'one\r\ntwo\r\n')
    const edited = await fileOperations.edit(
      { steps: [writeStep('kept.txt', 'uno\ndos\n'), writeStep('fresh/new.txt', 'hello\n')] },
      context
    )
    // 整份写照原文件的换行风格存：原来是 CRLF 的还是 CRLF。
    expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('uno\r\ndos\r\n')
    const undone = await fileOperations.undo({ changeId: edited.changeId }, context)
    expect(undone.files).toMatchObject([{ action: 'restored' }, { action: 'deleted' }])
    expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
    expect(existsSync(join(root, 'fresh/new.txt'))).toBe(false)
    // 改动之后别人又动过：整个不撤，一个文件都不动。
    const again = await fileOperations.edit({ steps: [writeStep('kept.txt', 'tres\n')] }, context)
    await writeFile(join(root, 'kept.txt'), 'someone else\n')
    const refused = await failureOf(fileOperations.undo({ changeId: again.changeId }, context))
    expect(refused.code).toBe(FileErrorCodes.undoConflict)
    expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('someone else\n')
  })

  test('INV-16 删掉那次新建的文件之前核对它还是那次写下的内容：对不上就不删（VALIDATION），对得上才删', async () => {
    const { port } = localFileSpace({ cwd: root })
    const target = join(root, 'made.txt')
    const written = { exists: true, bytes: Buffer.from('hello\n') }
    await writeFile(target, 'changed by someone\n')
    const refused = await failureOf(port.commit([{ target, bytes: null, expected: written }]))
    expect(refused).toMatchObject({ code: 'VALIDATION', context: { applied: [] } })
    expect(await readFile(target, 'utf8')).toBe('changed by someone\n')
    await writeFile(target, 'hello\n')
    await port.commit([{ target, bytes: null, expected: written }])
    expect(existsSync(target)).toBe(false)
  })
})
