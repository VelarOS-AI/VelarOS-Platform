/**
 * 文本文件公共件的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，只经根入口；实现细节的测试在 test/ 目录。
 */

import { spawnSync } from 'node:child_process'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  textCodec,
  type TextEncoding,
  TextEncodings,
  TextFileErrorCodes,
  textFileIo,
} from '../index'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'text-files-acceptance-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 一段覆盖 CRLF、中文、代理对、组合字符和字面转义的正文。 */
const Sample = 'long ascii content\r\n中文🙂é\\n\\uD800\r\n'

describe('解码', () => {
  test.each([
    Buffer.from([0xef, 0xbb, 0xbf, 0xf0, 0x9f]),
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from([0xfe, 0xff, 0xd8, 0x00]),
    Buffer.from([0xff, 0xfe, 0x00, 0xdc]),
    Buffer.concat([Buffer.from('long ascii content', 'utf16le'), Buffer.from([0x41])]),
    Buffer.from('name=caf\xe9', 'latin1'),
    Buffer.from([0x00, 0x01, 0x02, 0xff]),
  ])('INV-1 认不出、有非法字节、字节数不齐的都不当文本：%j', (bytes) => {
    expect(textCodec.decode(bytes)).toBeNull()
  })

  test.each(TextEncodings)('INV-1 %s 写出再读回，正文一个字不差', (encoding) => {
    const bytes = textCodec.encode(Sample, encoding)
    expect(textCodec.detect(bytes)).toBe(encoding)
    expect(textCodec.decode(bytes)).toEqual({ content: Sample, encoding })
  })

  test('INV-1 流式读遇到非法字节抛 notText，不凑出替换字符', async () => {
    const path = join(root, 'broken.txt')
    await writeFile(
      path,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok'), Buffer.from([0xf0, 0x9f])])
    )
    await expect(textFileIo.readText(path)).rejects.toMatchObject({
      code: TextFileErrorCodes.notText,
    })
    // 给错编码时照样严格：GB18030 的字节按 UTF-8 解不开。
    await writeFile(path, textCodec.encode('中文', 'gb18030'))
    await expect(textFileIo.readText(path, 'utf8')).rejects.toMatchObject({
      code: TextFileErrorCodes.notText,
    })
  })
})

describe('编码', () => {
  test.each([
    ['\uD800', 0, 0xd800],
    ['\uDC00', 0, 0xdc00],
    ['valid🙂then\uD800bad', 11, 0xd800],
    ['🙂\uDE00', 2, 0xde00],
  ] as const)('INV-2 孤立代理项抛 lossy 并给出位置：%j', (content, offset, codeUnit) => {
    expect(textCodec.findLoneSurrogate(content)).toEqual({ offset, codeUnit })
    for (const encoding of TextEncodings) {
      expect(() => textCodec.encode(content, encoding)).toThrow(
        expect.objectContaining({ code: TextFileErrorCodes.lossy, context: { offset, codeUnit } })
      )
    }
  })

  test('INV-2 GB18030 表示不了的字符抛 lossy，不静默替换', () => {
    expect(() => textCodec.encode('ok', 'gb18030')).toThrow(
      expect.objectContaining({
        code: TextFileErrorCodes.lossy,
        context: expect.objectContaining({ offset: 2 }),
      })
    )
    expect(textCodec.encode('ok', 'utf8')).toEqual(Buffer.from('ok'))
  })

  test('INV-2 GB18030 按原字节保留编码：没改的别名字节原样留下，拼出的字节读回来就是目标正文', () => {
    const original = Buffer.concat([
      Buffer.from([0x80]),
      Buffer.from(' old\r\n'),
      Buffer.from([0xfe, 0x59]),
      Buffer.from(' middle\n'),
      Buffer.from([0x80]),
    ])
    const before = textCodec.decode(original)!
    expect(before.encoding).toBe('gb18030')
    const after = before.content.replace('old', 'new')
    const preserved = textCodec.encodePreserving(original, before.content, after, 'gb18030')
    expect(preserved).toEqual(
      Buffer.concat([
        Buffer.from([0x80]),
        Buffer.from(' new\r\n'),
        Buffer.from([0xfe, 0x59]),
        Buffer.from(' middle\n'),
        Buffer.from([0x80]),
      ])
    )
    // 直接重新编码会把别名字节换成标准写法：正文一样，字节不一样。
    expect(textCodec.encode(after, 'gb18030')).not.toEqual(preserved)
    expect(textCodec.decode(preserved)?.content).toBe(after)
    expect(() =>
      textCodec.encodePreserving(original, `${before.content}x`, after, 'gb18030')
    ).toThrow(expect.objectContaining({ code: TextFileErrorCodes.lossy }))
  })
})

describe('原子写入', () => {
  test.each(TextEncodings)(
    'INV-3 %s 文件按原编码写回，权限位与符号链接不变，不留临时文件',
    async (encoding) => {
      const path = join(root, 'source.txt')
      await writeFile(path, textCodec.encode(Sample, encoding))
      await chmod(path, 0o751)
      const originalMode = (await stat(path)).mode & 0o777
      await symlink('source.txt', join(root, 'alias.txt'))
      const changed = Sample.replace('long', 'changed')
      await textFileIo.writeText(join(root, 'alias.txt'), changed)
      expect((await lstat(join(root, 'alias.txt'))).isSymbolicLink()).toBe(true)
      expect((await stat(path)).mode & 0o777).toBe(originalMode)
      expect(await readFile(path)).toEqual(textCodec.encode(changed, encoding))
      expect((await readdir(root)).sort()).toEqual(['alias.txt', 'source.txt'])
    }
  )

  test.each(['\uD800', '\uDC00', 'valid🙂then\uD800bad'])(
    'INV-3 写不成的正文在动磁盘之前就被拒：%j',
    async (content) => {
      const path = join(root, 'source.txt')
      const original = Buffer.from('﻿original\r\n', 'utf16le')
      await writeFile(path, original)
      await expect(textFileIo.writeText(path, content)).rejects.toMatchObject({
        code: TextFileErrorCodes.lossy,
      })
      expect(await readFile(path)).toEqual(original)
      expect(await readdir(root)).toEqual(['source.txt'])
    }
  )

  test('INV-3 认不出编码的已有文件不许按文本覆盖，给了缺省编码也不行', async () => {
    const path = join(root, 'invalid.txt')
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0xd8])
    await writeFile(path, bytes)
    await expect(
      textFileIo.writeText(path, 'replacement', { fallbackEncoding: 'utf8' })
    ).rejects.toMatchObject({ code: TextFileErrorCodes.notText })
    expect(await readFile(path)).toEqual(bytes)
  })

  test('INV-3 有多个硬链接的文件拒写，其余链接不会和它分家', async () => {
    await writeFile(join(root, 'source.txt'), 'original')
    await link(join(root, 'source.txt'), join(root, 'alias.txt'))
    await expect(textFileIo.writeText(join(root, 'source.txt'), 'changed')).rejects.toMatchObject({
      code: TextFileErrorCodes.notRegular,
    })
    await expect(
      textFileIo.writeBytes(join(root, 'alias.txt'), Buffer.from('changed'))
    ).rejects.toMatchObject({ code: TextFileErrorCodes.notRegular })
    expect(await readFile(join(root, 'alias.txt'), 'utf8')).toBe('original')
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original')
  })

  test.skipIf(process.platform === 'win32')(
    'INV-3 POSIX 权限不受 umask 影响，新文件不给权限时由 umask 定',
    async () => {
      const mask = process.umask(0o077)
      try {
        await textFileIo.writeText(join(root, 'restored.sh'), 'original', { mode: 0o751 })
        await textFileIo.writeBytes(join(root, 'wide.txt'), Buffer.from('wide'), { mode: 0o666 })
        await textFileIo.writeText(join(root, 'new.txt'), 'new')
        expect((await stat(join(root, 'restored.sh'))).mode & 0o777).toBe(0o751)
        expect((await stat(join(root, 'wide.txt'))).mode & 0o777).toBe(0o666)
        expect((await stat(join(root, 'new.txt'))).mode & 0o777).toBe(0o600)
        // 已有文件改写后原来的权限位原样留下，umask 收不走。
        await chmod(join(root, 'wide.txt'), 0o777)
        await textFileIo.writeText(join(root, 'wide.txt'), 'still wide')
        expect((await stat(join(root, 'wide.txt'))).mode & 0o777).toBe(0o777)
      } finally {
        process.umask(mask)
      }
    }
  )
})

test('INV-3 权限位越界在所有平台拒写', async () => {
  for (const mode of [-1, 0o1000, 0o4755, 1.5]) {
    await expect(
      textFileIo.writeText(join(root, 'invalid.txt'), 'bad', { mode })
    ).rejects.toMatchObject({ code: TextFileErrorCodes.invalidMode })
  }
  expect(await Bun.file(join(root, 'invalid.txt')).exists()).toBe(false)
})

describe('写前核对', () => {
  test('INV-4 磁盘上的字节对不上预期就抛 externalEdit，什么都不写', async () => {
    const path = join(root, 'target.txt')
    const original = Buffer.from('original\n')
    await writeFile(path, original)
    const expected = { exists: true, bytes: Buffer.from(original) }
    for (const external of [
      Buffer.from('original\n!'),
      Buffer.from('original'),
      Buffer.from('0riginal\n'),
    ]) {
      await writeFile(path, external)
      await expect(
        textFileIo.writeBytes(path, Buffer.from('mine'), { expected })
      ).rejects.toMatchObject({ code: TextFileErrorCodes.externalEdit })
      await expect(textFileIo.assertUnchanged(path, expected)).rejects.toMatchObject({
        code: TextFileErrorCodes.externalEdit,
      })
      expect(await readFile(path)).toEqual(external)
    }
    await rm(path)
    await expect(
      textFileIo.writeBytes(path, Buffer.from('mine'), { expected })
    ).rejects.toMatchObject({ code: TextFileErrorCodes.externalEdit })
    expect(await Bun.file(path).exists()).toBe(false)
    await writeFile(path, '')
    await expect(
      textFileIo.writeBytes(path, Buffer.from('mine'), { expected: { exists: false } })
    ).rejects.toMatchObject({ code: TextFileErrorCodes.externalEdit })
    await expect(textFileIo.assertUnchanged(path, { exists: false })).rejects.toMatchObject({
      code: TextFileErrorCodes.externalEdit,
    })
    expect(await readFile(path)).toEqual(Buffer.alloc(0))
    expect((await readdir(root)).sort()).toEqual(['target.txt'])
    // 对得上就照常写。
    await textFileIo.writeBytes(path, Buffer.from('mine'), {
      expected: { exists: true, bytes: Buffer.alloc(0) },
    })
    await textFileIo.assertUnchanged(path, { exists: true, bytes: Buffer.from('mine') })
    await textFileIo.assertUnchanged(join(root, 'missing.txt'), { exists: false })
    expect(await readFile(path, 'utf8')).toBe('mine')
  })
})

describe('有界读', () => {
  test('INV-5 超过上限抛 tooLarge 而不分配超大缓冲；不存在返回 undefined；目录不是普通文件', async () => {
    const path = join(root, 'large.txt')
    await writeFile(path, 'old')
    await truncate(path, 64 * 1024 * 1024)
    await expect(textFileIo.readBounded(path, 3)).rejects.toMatchObject({
      code: TextFileErrorCodes.tooLarge,
      context: expect.objectContaining({ size: 64 * 1024 * 1024, maxBytes: 3 }),
    })
    expect((await stat(path)).size).toBe(64 * 1024 * 1024)
    await writeFile(path, 'old')
    expect(await textFileIo.readBounded(path, 3)).toEqual(Buffer.from('old'))
    expect(await textFileIo.readBounded(join(root, 'missing.txt'), 3)).toBeUndefined()
    await mkdir(join(root, 'directory'))
    await expect(textFileIo.readBounded(join(root, 'directory'), 3)).rejects.toMatchObject({
      code: TextFileErrorCodes.notRegular,
    })
  })

  test.skipIf(process.platform === 'win32')(
    'INV-5 命名管道不是普通文件：读、写都立刻拒绝，不会卡在等写端',
    async () => {
      const fifo = join(root, 'pipe')
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
      await expect(textFileIo.readBounded(fifo, 3)).rejects.toMatchObject({
        code: TextFileErrorCodes.notRegular,
      })
      await expect(textFileIo.readHead(fifo, 3)).rejects.toMatchObject({
        code: TextFileErrorCodes.notRegular,
      })
      await expect(textFileIo.readText(fifo)).rejects.toMatchObject({
        code: TextFileErrorCodes.notRegular,
      })
      await expect(textFileIo.writeText(fifo, 'x')).rejects.toMatchObject({
        code: TextFileErrorCodes.notRegular,
      })
    }
  )
})

describe('流式读', () => {
  test.each(TextEncodings)(
    'INV-6 %s 跨 64 KiB 块边界的字符不被切坏，流式读与整读逐字一致',
    async (encoding: TextEncoding) => {
      const content = `${'a'.repeat(65534)}中文🙂\n${'skip this line\n'.repeat(10000)}last 中文🙂\\n\n`
      const path = join(root, 'source.txt')
      const bytes = textCodec.encode(content, encoding)
      await writeFile(path, bytes)
      expect(await textFileIo.readText(path)).toBe(content)
      const chunks = []
      for await (const chunk of textFileIo.readTextChunks(path)) chunks.push(chunk)
      expect(chunks.map((chunk) => chunk.content).join('')).toBe(content)
      expect(chunks.at(-1)?.byteOffset).toBe(bytes.length)
    }
  )

  test.each([65535, 65534, 65533])(
    'INV-6 GB18030 的字被 64 KiB 块边界切开也不丢（前面 %i 个 ASCII）',
    async (prefix) => {
      const content = `${'a'.repeat(prefix)}中🙂文\n`
      const path = join(root, 'split.txt')
      await writeFile(path, textCodec.encode(content, 'gb18030'))
      expect(await textFileIo.readText(path)).toBe(content)
      expect(await textFileIo.readText(path, 'gb18030')).toBe(content)
    }
  )

  test('INV-6 很长的 ASCII 开头不会让后面的 GB18030 被误当成 UTF-8', async () => {
    const path = join(root, 'legacy.txt')
    const content = `${'a'.repeat(100000)}中文\n`
    await writeFile(path, textCodec.encode(content, 'gb18030'))
    expect(await textFileIo.readText(path)).toBe(content)
    expect(textCodec.detect(await textFileIo.readHead(path, 8), { partial: true })).toBe('utf8')
  })
})
