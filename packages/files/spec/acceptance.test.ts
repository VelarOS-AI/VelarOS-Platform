/**
 * 文件能力的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 * 空间端口用 `spec/support.ts` 的真磁盘端口：作用域、审查、落盘都能按用例换。
 */

import { readFileSync } from 'node:fs'
import { lstat, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { codeProgramChecker } from '@velaros-ai/code-surface'

import { FileErrorCodes, FileLimits,fileOperations } from '../src/index'

import { asking, diskSpace, failureOf, runModelProgram, solidPng } from './support'

const PackageRoot = resolve(import.meta.dir, '..')
const Declarations = readFileSync(resolve(PackageRoot, '../../baselines/code-surface/files.d.ts'), 'utf8')

let root = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('写：一批一次成败', () => {
  test('INV-1 版本对不上就什么都不写，message 逐条点名，code 是 FILES_EDIT_UNRESOLVED', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    await writeFile(join(root, 'b.txt'), 'beta\n')
    const before = await fileOperations.read({ files: [{ path: 'a.txt' }, { path: 'b.txt' }] }, space.context)
    const [a, b] = before.files.map((file) => ('error' in file ? '' : file.version))
    // 拿到 version 之后别人又改了 b：整批不写，a 也不动
    await writeFile(join(root, 'b.txt'), 'beta changed\n')
    const failure = await failureOf(fileOperations.edit({
      files: [
        { path: 'a.txt', newText: 'alpha 2\n', version: a },
        { path: 'b.txt', newText: 'beta 2\n', version: b },
      ],
    }, space.context))
    expect(failure.code).toBe(FileErrorCodes.editUnresolved)
    expect(failure.message).toContain('一个文件都没写')
    expect(failure.message).toContain('files[1]')
    expect(failure.message).toContain('重新读一遍再改')
    expect(space.commits).toHaveLength(0)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('beta changed\n')
  })

  test('INV-1 同一个文件（经符号链接也算）在一批里出现两次，整批不写', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'real.txt'), 'one\n')
    await symlink(join(root, 'real.txt'), join(root, 'alias.txt'))
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'real.txt', newText: 'x\n' }, { path: 'alias.txt', newText: 'y\n' }] }, space.context))
    expect(failure.message).toContain('不止一次')
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('one\n')
  })

  test('INV-2 落盘时把计划时看到的字节交给空间核对：审批期间被同尺寸、同修改时间地改掉，也不覆盖', async () => {
    const plain = join(root, 'plain.txt')
    // 超过 64 KB：这么大的文件落盘前只看「大小 + 修改时间」，两样都没变就不重读（小文件一律重读，拦不到这里）。
    const original = `${'a'.repeat(100 * 1024)}\n`
    const concurrent = `${'z'.repeat(100 * 1024)}\n`
    await writeFile(plain, original)
    await writeFile(join(root, 'deploy.pem'), 'secret\n')
    // 修改时间先落在整数秒上：拨回去时才能分毫不差，否则纳秒级的差别会让印记核对自己就发现了
    const pinned = 1_700_000_000
    await utimes(plain, pinned, pinned)
    const space = diskSpace({
      root,
      reviewWrite: (target) => (target.endsWith('.pem') ? asking(target) : []),
      // 用户看确认卡的时候，别人把第一个文件改成同样长度的内容，并把修改时间拨回去
      answer: async () => {
        await writeFile(plain, concurrent)
        await utimes(plain, pinned, pinned)
      },
    })
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'plain.txt', newText: 'beta\n' }, { path: 'deploy.pem', newText: 'x\n' }] }, space.context))
    expect(failure.code).toBe('VALIDATION')
    expect(space.commits[0]?.[0]?.expected).toEqual({ exists: true, bytes: Buffer.from(original) })
    expect(await readFile(plain, 'utf8')).toBe(concurrent)
  })

  test('INV-2 新建的文件核对它仍不存在；写到一半出错时，message 点名哪几个已经写进去了', async () => {
    const space = diskSpace({ root })
    await fileOperations.edit({ files: [{ path: 'fresh/new.txt', newText: 'hi\n' }] }, space.context)
    expect(space.commits[0]?.[0]?.expected).toEqual({ exists: false })
    expect(await readFile(join(root, 'fresh', 'new.txt'), 'utf8')).toBe('hi\n')

    const broken = diskSpace({ root })
    broken.port.commit = async (writes) => {
      throw Object.assign(new Error('磁盘满了'), { code: 'PLATFORM', context: { applied: [writes[0]!.target] } })
    }
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'one.txt', newText: '1' }, { path: 'two.txt', newText: '2' }] }, broken.context))
    expect(failure.message).toContain('只写进去了一部分')
    expect(failure.message).toContain(join(root, 'one.txt'))
    expect(failure.message).not.toContain(join(root, 'two.txt'))
  })

  test('INV-3 文本改动无损：GBK 原样回写；二进制不许被 newText 覆盖；写的是符号链接指向的文件', async () => {
    const space = diskSpace({ root })
    const gbk = join(root, 'gbk.txt')
    await writeFile(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))
    const [got] = (await fileOperations.read({ files: [{ path: 'gbk.txt' }] }, space.context)).files
    if (!got || 'error' in got) throw new Error('应当读得到')
    expect(got.encoding).toBe('gb18030')
    await fileOperations.edit({ files: [{ path: 'gbk.txt', newText: `${got.content}中文\n` }] }, space.context)
    expect((await readFile(gbk)).subarray(0, 4)).toEqual(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))

    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const refused = await failureOf(fileOperations.edit({ files: [{ path: 'blob.bin', newText: 'text\n' }] }, space.context))
    expect(refused.code).toBe(FileErrorCodes.editUnresolved)
    expect(await readFile(join(root, 'blob.bin'))).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x00]))

    await writeFile(join(root, 'real.txt'), 'one\n')
    await symlink(join(root, 'real.txt'), join(root, 'link.txt'))
    const written = await fileOperations.edit({ files: [{ path: 'link.txt', newText: 'two\n' }] }, space.context)
    expect(written.files[0]).toMatchObject({ path: join(root, 'link.txt'), target: join(root, 'real.txt'), action: 'written' })
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('two\n')
    expect((await lstat(join(root, 'link.txt'))).isSymbolicLink()).toBe(true)
  })

  test('INV-3 改过的文件能回到改动前的版本，回滚本身也能再回滚', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'config.json'), '{"debug":false}\n')
    const first = await fileOperations.edit({ files: [{ path: 'config.json', newText: '{"debug":true}\n' }] }, space.context)
    const previous = first.files[0]?.previousVersion
    if (!previous) throw new Error('应当留下改动前的版本')
    const [old] = (await fileOperations.read({ files: [{ path: 'config.json', version: previous }] }, space.context)).files
    expect(old && !('error' in old) ? old.content : '').toBe('{"debug":false}\n')
    const restored = await fileOperations.edit({ files: [{ path: 'config.json', restore: previous }] }, space.context)
    expect(restored.files[0]).toMatchObject({ action: 'restored', version: previous })
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{"debug":false}\n')
    const again = restored.files[0]?.previousVersion
    if (!again) throw new Error('回滚前的内容也应当留下')
    await fileOperations.edit({ files: [{ path: 'config.json', restore: again }] }, space.context)
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{"debug":true}\n')
  })
})

describe('读：整份、分三档', () => {
  test('INV-4 20 MB 以内整份读写，一批读不下的单独失败、绝不回半份，更大的指向命令', async () => {
    // 两个上限是同一个数：否则会漏出一段「字节放行、字符拒绝」的文件，读不了也改不了
    expect(FileLimits.readChars).toBe(FileLimits.fileBytes)
    const space = diskSpace({ root })

    const line = 'INFO 这一行是填充用的日志\n'
    const body = line.repeat(Math.floor((12 * 1024 * 1024) / Buffer.byteLength(line)))
    await writeFile(join(root, 'big.log'), `${body}ERROR 真正要找的那一行\n`)
    const [big] = (await fileOperations.read({ files: [{ path: 'big.log' }] }, space.context)).files
    if (!big || 'error' in big) throw new Error('应当读得到')
    expect(big.content.endsWith('ERROR 真正要找的那一行\n')).toBe(true)
    const next = big.content.replace('ERROR 真正要找的那一行', 'ERROR 已处理')
    const written = await fileOperations.edit({ files: [{ path: 'big.log', newText: next, version: big.version }] }, space.context)
    expect((await readFile(join(root, 'big.log'), 'utf8')).endsWith('ERROR 已处理\n')).toBe(true)
    // 超过 2 MB 的能写，但不留回滚版本
    expect(written.files[0]?.previousVersion).toBeNull()

    // 用 ASCII：一个字节一个字符，两份 11 MB 加起来才压得过 20 MB 的字符预算
    const ascii = 'x'.repeat(11 * 1024 * 1024)
    await writeFile(join(root, 'first.log'), ascii)
    await writeFile(join(root, 'second.log'), ascii)
    const batch = await fileOperations.read({ files: [{ path: 'first.log' }, { path: 'second.log' }] }, space.context)
    expect('content' in batch.files[0]! && batch.files[0].content.length).toBeGreaterThan(0)
    expect('error' in batch.files[1]! && batch.files[1].error.message).toContain('单独放进一次 read')
    expect(batch.files[1]).not.toHaveProperty('content')

    await writeFile(join(root, 'huge.log'), Buffer.alloc(FileLimits.fileBytes + 1, 0x61))
    const refused = await failureOf(fileOperations.read({ files: [{ path: 'huge.log' }] }, space.context))
    expect(refused.message).toContain('用 run 取片段')
  }, 60_000)

  test('INV-4 图片、PDF、目录各自算失败并说清楚该用什么', async () => {
    const space = diskSpace({ root })
    await writeFile(join(root, 'shot.png'), solidPng(4, 4))
    await writeFile(join(root, 'doc.pdf'), '%PDF-1.7\n')
    await writeFile(join(root, 'ok.txt'), 'ok\n')
    const { files } = await fileOperations.read({ files: [{ path: 'shot.png' }, { path: 'doc.pdf' }, { path: '.' }, { path: 'ok.txt' }] }, space.context)
    expect(files.map((file) => ('error' in file ? file.error.message : 'ok'))).toEqual([
      expect.stringContaining('用 view 看'),
      expect.stringContaining('是 PDF'),
      expect.stringContaining('是目录'),
      'ok',
    ])
  })
})

describe('作用域与策略由空间注入', () => {
  test('INV-5 越出空间范围的路径：读的那一项失败，写的那一批整批不写，code 是 FILES_EDIT_DENIED', async () => {
    const space = diskSpace({ root, clamp: true })
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-outside-')))
    try {
      await writeFile(join(outside, 'x.txt'), 'outside\n')
      await writeFile(join(root, 'in.txt'), 'inside\n')
      const read = await fileOperations.read({ files: [{ path: join(outside, 'x.txt') }, { path: 'in.txt' }] }, space.context)
      expect(read.files[0]).toMatchObject({ error: { code: 'PERMISSION' } })
      expect(read.files[1]).toMatchObject({ path: 'in.txt', content: 'inside\n' })

      const failure = await failureOf(fileOperations.edit({ files: [{ path: 'in.txt', newText: 'changed\n' }, { path: '../escape.txt', newText: 'x' }] }, space.context))
      expect(failure.code).toBe(FileErrorCodes.editDenied)
      expect(await readFile(join(root, 'in.txt'), 'utf8')).toBe('inside\n')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('INV-5 空间要问的就问，按真实路径问；第一次被拒就停，后面的不再打扰，整批不写', async () => {
    await writeFile(join(root, 'deploy.pem'), 'secret\n')
    await symlink(join(root, 'deploy.pem'), join(root, 'notes.txt'))
    await writeFile(join(root, 'other.pem'), 'secret 2\n')
    await writeFile(join(root, 'plain.txt'), 'alpha\n')
    const space = diskSpace({
      root,
      reviewWrite: (target) => (target.endsWith('.pem') ? asking(target) : []),
      answer: () => {
        throw new Error('用户没同意')
      },
    })
    // 普通文件不问
    await fileOperations.edit({ files: [{ path: 'plain.txt', newText: 'beta\n' }] }, space.context)
    expect(space.confirmations).toHaveLength(0)
    // 凭证文件藏在符号链接后面也要问（问的是它指向的那个）；被拒整批不写，第二个凭证文件不再问
    const failure = await failureOf(fileOperations.edit({
      files: [{ path: 'plain.txt', newText: 'gamma\n' }, { path: 'notes.txt', newText: 'x\n' }, { path: 'other.pem', newText: 'y\n' }],
    }, space.context))
    expect(failure.code).toBe(FileErrorCodes.editDenied)
    expect(failure.message).toContain('用户没同意')
    expect(space.confirmations).toEqual([`要动 ${join(root, 'deploy.pem')} 吗？`])
    expect(await readFile(join(root, 'plain.txt'), 'utf8')).toBe('beta\n')
    expect(await readFile(join(root, 'deploy.pem'), 'utf8')).toBe('secret\n')

    // 读被拒只是那一项失败
    const reading = diskSpace({ root, reviewRead: (target) => (target.endsWith('.pem') ? asking(target) : []), answer: () => { throw new Error('不给看') } })
    const read = await fileOperations.read({ files: [{ path: 'notes.txt' }, { path: 'plain.txt' }] }, reading.context)
    expect(read.files[0]).toMatchObject({ error: { message: '不给看' } })
    expect(read.files[1]).toMatchObject({ content: 'beta\n' })
  })
})

describe('代码面 files 命名空间', () => {
  test('INV-6 模型写的程序照生成的声明调到真实操作：读真文件、在程序里筛、只交出要的', async () => {
    await writeFile(join(root, 'a.ts'), 'const a = 1\n// TODO: 补这里\n')
    await writeFile(join(root, 'b.ts'), '干净文件，没有待办\n')
    const result = await runModelProgram(diskSpace({ root, clamp: true }), Declarations, `import { read } from 'velar:files'
const r = await read({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] })
export default r.files.filter((f) => !('error' in f) && f.content.includes('TODO')).map((f) => f.path)`)
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual(['a.ts'])
  }, 60_000)

  test('INV-6 大文件穿过隔离：12 MB 读进程序、在程序里改、写回去，模型只看到一行摘要', async () => {
    const lines = Array.from({ length: 400_000 }, (_, index) => `${index % 997 === 0 ? 'ERROR' : 'INFO '} line ${index} ${'-'.repeat(12)}`)
    await writeFile(join(root, 'big.log'), `${lines.join('\n')}\n`)
    const result = await runModelProgram(diskSpace({ root }), Declarations, `import { read, edit } from 'velar:files'
const [file] = (await read({ files: [{ path: 'big.log' }] })).files
if ('error' in file) throw new Error(file.error.message)
await edit({ files: [{ path: 'big.log', newText: file.content.replaceAll('ERROR', 'FIXED'), version: file.version }] })
export default { chars: file.content.length, fixed: file.content.split('ERROR').length - 1 }`, 60_000)
    expect(result.failed).toBeUndefined()
    const value = result.value as { chars: number; fixed: number }
    expect(value.chars).toBeGreaterThan(10_000_000)
    expect(value.fixed).toBe(402)
    expect(JSON.stringify(result).length).toBeLessThan(500)
    const after = await readFile(join(root, 'big.log'), 'utf8')
    expect(after.includes('ERROR')).toBe(false)
  }, 120_000)

  test('INV-6 写不下去时程序接得住：error.code 与 message 就是模型能看见的全部', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const legal = await runModelProgram(diskSpace({ root }), Declarations, `import { edit } from 'velar:files'
let outcome
try {
  await edit({ files: [{ path: 'a.txt', newText: 'x', version: 'not-the-version' }] })
  outcome = '没拦住'
} catch (error) {
  outcome = { code: error.code, stale: error.message.includes('被改过') }
}
export default outcome`)
    expect(legal.value).toEqual({ code: FileErrorCodes.editUnresolved, stale: true })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('alpha\n')
  }, 60_000)

  test('INV-7 入参不合法由操作方法自己拦：形状不对直接 VALIDATION，不会半途崩', async () => {
    const space = diskSpace({ root })
    for (const input of [undefined, null, 'x', { files: '不是数组' }, { files: [] }, { files: ['a.txt'] }, { files: [{ path: 3 }] }]) {
      const failure = await failureOf(fileOperations.read(input as never, space.context))
      expect(failure.code).toBe('VALIDATION')
    }
    const tooMany = Array.from({ length: FileLimits.editFiles + 1 }, (_, index) => ({ path: `${index}.txt`, newText: '' }))
    expect((await failureOf(fileOperations.edit({ files: tooMany }, space.context))).message).toContain(`最多 ${FileLimits.editFiles} 个`)
    const both = await failureOf(fileOperations.edit({ files: [{ path: 'a.txt', newText: 'x', restore: 'v' }] }, space.context))
    expect(both.message).toContain('只能用一种')
  })
})

describe('看图', () => {
  test('INV-8 在范围内的图原样交出，不碰缩放器；结果里只有尺寸，没有像素', async () => {
    await writeFile(join(root, 'small.png'), solidPng(800, 600))
    const space = diskSpace({ root, resize: async () => { throw new Error('不该被调') } })
    const result = await fileOperations.view({ files: [{ path: 'small.png' }] }, space.context)
    expect(result.files[0]).toEqual({ path: join(root, 'small.png'), mediaType: 'image/png', width: 800, height: 600, sent: { width: 800, height: 600 } })
    expect(JSON.stringify(result)).not.toContain('iVBOR')
    expect(space.resized).toHaveLength(0)
    expect(space.attached).toHaveLength(1)
    expect(space.attached[0]!.label).toContain('原图 800×600')
    expect(Buffer.from(space.attached[0]!.data, 'base64').equals(await readFile(join(root, 'small.png')))).toBe(true)
  })

  test('INV-8 超出长边才请宿主压；要了 region 才请宿主裁，整块在图外直接拒', async () => {
    await writeFile(join(root, 'big.png'), solidPng(4000, 3000))
    const shrunk = solidPng(2000, 1500)
    const space = diskSpace({ root, resize: async () => ({ data: shrunk, mediaType: 'image/png', width: 2000, height: 1500 }) })
    const whole = await fileOperations.view({ files: [{ path: 'big.png' }] }, space.context)
    expect(whole.files[0]).toMatchObject({ width: 4000, height: 3000, sent: { width: 2000, height: 1500 } })
    expect(space.resized[0]).toMatchObject({ longEdge: FileLimits.imageEdge })
    await fileOperations.view({ files: [{ path: 'big.png', region: { x: 3000, y: 0, width: 5000, height: 500 } }] }, space.context)
    // region 超出图的部分收进来：x 从 3000 起，最多到 4000
    expect(space.resized[1]).toMatchObject({ region: { x: 3000, y: 0, width: 1000, height: 500 } })
    await expect(fileOperations.view({ files: [{ path: 'big.png', region: { x: 5000, y: 0, width: 10, height: 10 } }] }, space.context)).rejects.toThrow('整块都在图外')
  })

  test('INV-8 宿主压不了时，超限的图明说并给出命令；没有交图通道时 view 直接不可用；不是图就说清楚', async () => {
    await writeFile(join(root, 'big.png'), solidPng(3000, 2000))
    await expect(fileOperations.view({ files: [{ path: 'big.png' }] }, diskSpace({ root }).context)).rejects.toThrow('sips -Z')
    await expect(fileOperations.view({ files: [{ path: 'big.png' }] }, diskSpace({ root, attach: false }).context)).rejects.toThrow('没有把图交给模型的通道')
    await writeFile(join(root, 'note.txt'), '不是图')
    await expect(fileOperations.view({ files: [{ path: 'note.txt' }] }, diskSpace({ root }).context)).rejects.toThrow('不是模型能看的图片')
  })
})

describe('模型面', () => {
  test('INV-9 代码模版整份照真实声明过类型检查，声明里嵌的就是这份文件', () => {
    const template = readFileSync(resolve(PackageRoot, 'templates/files.js'), 'utf8')
    const checked = codeProgramChecker.check({ source: template, granted: [{ namespace: 'files', declarations: Declarations }] })
    expect(checked.ok ? [] : checked.diagnostics).toEqual([])
    for (const line of template.trim().split('\n').filter((text) => text.trim().length > 0)) {
      expect(Declarations).toContain(line)
    }
  })

  test('INV-10 声明里写的上限与错误码和常量表一致；模型面上没有空间端口的影子', () => {
    for (const code of Object.values(FileErrorCodes)) expect(Declarations).toContain(code)
    for (const [name, value] of Object.entries({ readFiles: FileLimits.readFiles, viewFiles: FileLimits.viewFiles, editFiles: FileLimits.editFiles, imageEdge: FileLimits.imageEdge })) {
      expect(`${name}:${Declarations.includes(String(value))}`).toBe(`${name}:true`)
    }
    expect(Declarations).toContain(`${FileLimits.fileBytes / 1024 / 1024} MB`)
    expect(Declarations).toContain(`${FileLimits.versionedBytes / 1024 / 1024} MB`)
    expect(Declarations).toContain(`${FileLimits.imageBase64Bytes / 1024 / 1024} MB`)
    for (const hidden of ['FileSpacePort', 'locate', 'reviewWrite', 'commit', 'FileOperationContext']) expect(Declarations).not.toContain(hidden)
  })
})
