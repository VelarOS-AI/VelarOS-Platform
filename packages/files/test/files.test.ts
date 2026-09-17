/** 文件能力的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补编码、权限位、批量看图、特殊文件、图片头这些边角。 */

import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { asking, diskSpace, failureOf, solidPng } from '../spec/support'
import { FileHistory } from '../src/impl/FileHistory'
import { FileLimits, fileOperations } from '../src/index'
import { readImageSize } from '../src/utils/image'

let root = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-files-impl-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('读', () => {
  test('UTF-16 解码后换行原样保留', async () => {
    await writeFile(join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb', 'utf16le')]))
    const [file] = (await fileOperations.read({ files: [{ path: 'utf16.txt' }] }, diskSpace({ root }).context)).files
    expect(file).toMatchObject({ content: 'a\r\nb', encoding: 'utf16le' })
  })

  test('目录、其他二进制、设备文件都算失败；全部失败时整个调用报错', async () => {
    const { context } = diskSpace({ root })
    await expect(fileOperations.read({ files: [{ path: '.' }] }, context)).rejects.toThrow('路径是目录')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    await expect(fileOperations.read({ files: [{ path: 'blob.bin' }] }, context)).rejects.toThrow('二进制')
    if (process.platform !== 'win32') await expect(fileOperations.read({ files: [{ path: '/dev/null' }] }, context)).rejects.toThrow('不是普通文件')
  })

  test('预算用完之后的文件不读盘，那一项是失败条目', async () => {
    await writeFile(join(root, 'big.txt'), 'a'.repeat(FileLimits.readChars))
    await writeFile(join(root, 'note.txt'), 'here')
    const budget = await fileOperations.read({ files: [{ path: 'big.txt' }, { path: 'note.txt' }] }, diskSpace({ root }).context)
    expect(budget.files[1]).toMatchObject({ path: 'note.txt', error: { code: 'VALIDATION' } })
  }, 30_000)

  test('读被拒只是那一项失败；只有这一项时整个调用报出拒绝原因', async () => {
    await writeFile(join(root, 'deploy.pem'), 'key\n')
    await writeFile(join(root, 'note.txt'), 'here')
    const space = diskSpace({ root, reviewRead: (target) => (target.endsWith('.pem') ? asking(target) : []), answer: () => { throw new Error('user said no') } })
    const refused = await fileOperations.read({ files: [{ path: 'note.txt' }, { path: 'deploy.pem' }] }, space.context)
    expect(refused.files.map((entry) => ('error' in entry ? entry.error.message : entry.content))).toEqual(['here', 'user said no'])
    await expect(fileOperations.read({ files: [{ path: 'deploy.pem' }] }, space.context)).rejects.toThrow('user said no')
  })
})

describe('写', () => {
  test.skipIf(process.platform === 'win32')('已有文件的权限位原样保留，新文件的权限由 umask 定', async () => {
    const mask = process.umask(0o077)
    try {
      const { context } = diskSpace({ root })
      await writeFile(join(root, 'shared.sh'), 'echo one\n')
      await chmod(join(root, 'shared.sh'), 0o777)
      await fileOperations.edit({ files: [{ path: 'shared.sh', newText: 'echo two\n' }] }, context)
      expect((await stat(join(root, 'shared.sh'))).mode & 0o777).toBe(0o777)
      await fileOperations.edit({ files: [{ path: 'fresh.txt', newText: 'new\n' }] }, context)
      expect((await stat(join(root, 'fresh.txt'))).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(mask)
    }
  })

  test.skipIf(process.platform === 'win32')('命名管道不当文本改，也不会被换成普通文件', async () => {
    const pipe = join(root, 'pipe')
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
    const failure = await failureOf(fileOperations.edit({ files: [{ path: 'pipe', newText: 'x' }] }, diskSpace({ root }).context))
    expect(failure.message).toContain('不是普通文件')
    expect((await lstat(pipe)).isFIFO()).toBe(true)
  })

  test('多个硬链接的文件不碰；上级路径是文件时在计划期就报出来', async () => {
    const { context } = diskSpace({ root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    spawnSync('ln', [join(root, 'a.txt'), join(root, 'b.txt')])
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'a.txt', newText: 'x' }] }, context))).message).toContain('硬链接')
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'a.txt/child.txt', newText: 'x' }] }, context))).message).toContain('上级路径不是目录')
  })

  test('经符号链接改的版本，从真实路径和链接路径都能读回来', async () => {
    const { context } = diskSpace({ root })
    await writeFile(join(root, 'real.conf'), 'Host a\n')
    await symlink(join(root, 'real.conf'), join(root, 'link.conf'))
    const result = await fileOperations.edit({ files: [{ path: 'link.conf', newText: 'Host b\n' }] }, context)
    const previous = result.files[0]?.previousVersion ?? ''
    for (const path of ['real.conf', 'link.conf']) {
      const [file] = (await fileOperations.read({ files: [{ path, version: previous }] }, context)).files
      expect(file).toMatchObject({ content: 'Host a\n' })
    }
    expect(await readFile(join(root, 'real.conf'), 'utf8')).toBe('Host b\n')
  })

  test('newText 编不回原编码、带 NUL 字节，整批不写', async () => {
    const { context } = diskSpace({ root })
    await writeFile(join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0x0a]))
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'gbk.txt', newText: '\uD800' }] }, context))).message).toContain('无损写进')
    expect((await failureOf(fileOperations.edit({ files: [{ path: 'new.txt', newText: 'a\0b' }] }, context))).message).toContain('NUL')
  })
})

describe('看图', () => {
  test('一批里混着图和不存在的文件：失败只标记它那一项，交出的图按顺序、标签里带着它在这批里的位置', async () => {
    const png = solidPng(40, 30)
    await writeFile(join(root, 'shot.png'), png)
    await writeFile(join(root, 'again.png'), png)
    const space = diskSpace({ root })
    const batch = await fileOperations.view({ files: [{ path: 'shot.png' }, { path: 'missing.png' }, { path: 'again.png' }] }, space.context)
    expect(batch.files.map((entry) => ('error' in entry ? entry.error.code : entry.mediaType))).toEqual(['image/png', 'NOT_FOUND', 'image/png'])
    expect(space.attached.map((image) => image.label.split('：')[0])).toEqual(['图片 1/3', '图片 3/3'])
    expect(space.attached[0]).toEqual({ mediaType: 'image/png', data: png.toString('base64'), label: `图片 1/3：${join(root, 'shot.png')}（原图 40×30，给你的是 40×30）` })
    await expect(fileOperations.view({ files: [{ path: 'a.png' }, { path: 'b.png' }] }, space.context)).rejects.toThrow('不存在')
    await writeFile(join(root, 'report.pdf'), '%PDF-1.4\n%fake\n')
    await expect(fileOperations.view({ files: [{ path: 'report.pdf' }] }, space.context)).rejects.toThrow('view 只看图片')
  })

  test('图片头：JPEG 顺着段找帧头，GIF 与扩展 WebP（VP8X）头都认得出宽高', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03])
    expect(readImageSize(jpeg, 'image/jpeg')).toEqual({ width: 600, height: 300 })
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1')
    expect(readImageSize(gif, 'image/gif')).toEqual({ width: 320, height: 240 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBPVP8X', 8, 'ascii')
    webp.writeUIntLE(799, 24, 3)
    webp.writeUIntLE(599, 27, 3)
    expect(readImageSize(webp, 'image/webp')).toEqual({ width: 800, height: 600 })
  })
})

describe('版本历史', () => {
  test('同样的内容只留一份；每个文件只留最近几份；太大的不留', () => {
    const history = new FileHistory()
    const first = history.remember('/a', Buffer.from('one'))
    expect(history.remember('/a', Buffer.from('one'))).toBe(first)
    for (let index = 0; index < 12; index += 1) history.remember('/a', Buffer.from(`v${index}`))
    expect(history.recall('/a', first ?? '')).toBeNull()
    expect(history.remember('/b', Buffer.alloc(FileLimits.versionedBytes + 1))).toBeNull()
  })
})
