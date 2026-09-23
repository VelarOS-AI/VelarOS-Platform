/** 文件读写的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补读文件头、新文件的编码与权限、改名前的第二次核对。 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { textCodec, TextFileErrorCodes, textFileIo } from '../index'
import { replaceFileAtomically } from '../utils/file-io'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'text-files-io-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('读文件头', () => {
  test('只读开头最多那么多字节；不存在抛 ENOENT；目录不是普通文件', async () => {
    const path = join(root, 'head.txt')
    await writeFile(path, 'gitdir: ../elsewhere\n')
    expect((await textFileIo.readHead(path, 6)).toString()).toBe('gitdir')
    expect((await textFileIo.readHead(path, 4096)).toString()).toBe('gitdir: ../elsewhere\n')
    await expect(textFileIo.readHead(join(root, 'missing.txt'), 6)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await mkdir(join(root, 'directory'))
    await expect(textFileIo.readHead(join(root, 'directory'), 6)).rejects.toMatchObject({
      code: TextFileErrorCodes.notRegular,
    })
  })
})

describe('新文件', () => {
  test('新文件用给的缺省编码；已有文件无视缺省编码，按它自己的写', async () => {
    const fresh = join(root, 'fresh.txt')
    await textFileIo.writeText(fresh, '中文\n', { fallbackEncoding: 'utf16le' })
    expect(await readFile(fresh)).toEqual(textCodec.encode('中文\n', 'utf16le'))
    await textFileIo.writeText(fresh, '改了\n', { fallbackEncoding: 'gb18030' })
    expect(await readFile(fresh)).toEqual(textCodec.encode('改了\n', 'utf16le'))
    const plain = join(root, 'plain.txt')
    await textFileIo.writeText(plain, 'plain\n')
    expect(await readFile(plain, 'utf8')).toBe('plain\n')
  })

  test('上级目录不存在时原样抛文件系统错误，不留临时文件', async () => {
    await expect(
      textFileIo.writeBytes(join(root, 'missing', 'a.txt'), Buffer.from('x'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([])
  })

  test('新文件给了权限位就精确设上', async () => {
    const path = join(root, 'script.sh')
    await textFileIo.writeBytes(path, Buffer.from('#!/bin/sh\n'), { mode: 0o700 })
    expect((await stat(path)).mode & 0o777).toBe(0o700)
  })
})

describe('改名前的第二次核对', () => {
  test('写临时文件期间外部改了文件：改名前核对不上，外部内容留着，临时文件清掉', async () => {
    const path = join(root, 'target.txt')
    await writeFile(path, 'original')
    await expect(
      replaceFileAtomically(
        path,
        async (target) => {
          await writeFile(target, 'external')
          return Buffer.from('mine')
        },
        { expected: { exists: true, bytes: Buffer.from('original') } }
      )
    ).rejects.toMatchObject({ code: TextFileErrorCodes.externalEdit })
    expect(await readFile(path, 'utf8')).toBe('external')
    expect(await readdir(root)).toEqual(['target.txt'])
  })
})

describe('流式读', () => {
  test('提前结束迭代也会关句柄，之后照常读写', async () => {
    const path = join(root, 'long.txt')
    await writeFile(path, 'x'.repeat(200_000))
    for await (const chunk of textFileIo.readTextChunks(path)) {
      expect(chunk.content.length).toBeGreaterThan(0)
      break
    }
    await textFileIo.writeText(path, 'short')
    expect(await textFileIo.readText(path)).toBe('short')
  })
})
