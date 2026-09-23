/**
 * 磁盘文本的读写：`TextFileIo` 与整个进程唯一的 `textFileIo`。接口 `TextFileIoApi` 在本文件的类上方。
 * 原子替换、有界读、读文件头这些用不着编解码的步骤是 `utils/file-io.ts` 的函数；这个类把它们和编解码接起来，是本包读写文件的唯一出口。
 */

import type { FileHandle } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'

import { TextFileErrorCodes } from '../contract/constants.js'
import type { ExpectedBytes, TextChunk, TextEncoding } from '../types/text-files.js'
import { decodeStrictly } from '../utils/encoding.js'
import {
  assertBytesOnDisk,
  openRegularFile,
  readBoundedBytes,
  readHeadBytes,
  replaceFileAtomically,
} from '../utils/file-io.js'
import { TextFileTuning } from '../utils/tuning.js'

import type { TextCodecApi } from './TextCodec.js'
import { textCodec } from './TextCodec.js'

/**
 * 磁盘文本的读写，实例是 `textFileIo`：原子替换写入、按原编码写文本、有界读、读文件头、流式读正文、核对原字节。
 * 写入一律是同目录临时文件加改名的原子替换：写完 fsync、改名后 fsync 目录，已有文件的权限位精确恢复，符号链接写到它指向的普通文件、链接本身不动，多硬链接的文件拒写。
 * 失败抛 `AppError`，code 是 `TextFileErrorCodes` 里的码；文件系统自己的 errno 错误原样抛出。
 */
export interface TextFileIoApi {
  /**
   * 原子替换一个文件的全部字节，路径是符号链接时写到它指向的普通文件：同目录临时文件 → 写完 fsync → 改名覆盖 → fsync 目录（Windows 不做最后一步）。
   * 已有文件精确恢复它的权限位；新文件用 mode 并精确设上，不给就由 umask 定。给了 expected 时写前、改名前各核对一次磁盘上的字节，对不上抛 externalEdit、什么都不写。
   * 已有的不是普通文件或有多个硬链接抛 notRegular；mode 不在 0–0777 抛 invalidMode；上级目录不存在、没有权限这类文件系统错误原样抛出。
   */
  writeBytes(
    path: string,
    bytes: Uint8Array,
    options?: { mode?: number; expected?: ExpectedBytes }
  ): Promise<void>
  /**
   * 原子写一段正文：已有文件按它自己的编码（连同 BOM）写，认不出它的编码时抛 notText、不动它；新文件用 fallbackEncoding，缺省 utf8。
   * 正文写不成那种编码（孤立代理项、GB18030 表示不了的字符）时抛 lossy，磁盘不动；其余同 writeBytes。
   */
  writeText(
    path: string,
    content: string,
    options?: { fallbackEncoding?: TextEncoding; mode?: number }
  ): Promise<void>
  /** 在同一个句柄上有界读整个文件：不存在返回 undefined；不是普通文件抛 notRegular；超过 maxBytes 抛 tooLarge，不分配超大缓冲；读的过程中文件变长抛 externalEdit。 */
  readBounded(path: string, maxBytes: number): Promise<Buffer | undefined>
  /** 读文件开头最多 bytes 个字节（认编码、判二进制用），不把整个文件读进来；不是普通文件抛 notRegular，不存在时抛文件系统的 ENOENT。 */
  readHead(path: string, bytes: number): Promise<Buffer>
  /**
   * 流式读正文：不给 encoding 就先在同一个句柄上流式认完整个文件的编码（很长的 ASCII 开头不会让后面的 GB18030 被误当成 UTF-8），再按块严格解码；
   * 认不出抛 notText，解码途中遇到非法字节（文件被改了，或给的编码不对）也抛 notText；不是普通文件抛 notRegular。提前结束迭代同样会关句柄。
   */
  readTextChunks(path: string, encoding?: TextEncoding): AsyncGenerator<TextChunk>
  /** 整读正文，与 readTextChunks 走同一条解码路径、同样的失败。 */
  readText(path: string, encoding?: TextEncoding): Promise<string>
  /** 核对磁盘上的字节还是 expected 那一份：按预期的长度有界读，多出字节、类型变了、内容不同都抛 externalEdit。 */
  assertUnchanged(path: string, expected: ExpectedBytes): Promise<void>
}

export class TextFileIo implements TextFileIoApi {
  /** assertUnchanged 对不上时的说明。 */
  private static readonly UnchangedMismatch = '文件的字节与预期不一致，已被外部修改。'
  private readonly codec: TextCodecApi

  constructor(codec: TextCodecApi) {
    this.codec = codec
  }

  public async writeBytes(
    path: string,
    bytes: Uint8Array,
    options: { mode?: number; expected?: ExpectedBytes } = {}
  ): Promise<void> {
    await replaceFileAtomically(path, () => bytes, options)
  }

  public async writeText(
    path: string,
    content: string,
    options: { fallbackEncoding?: TextEncoding; mode?: number } = {}
  ): Promise<void> {
    await replaceFileAtomically(
      path,
      async (target, exists) =>
        this.codec.encode(
          content,
          exists ? await this.existingEncoding(target) : (options.fallbackEncoding ?? 'utf8')
        ),
      { mode: options.mode }
    )
  }

  public readBounded(path: string, maxBytes: number): Promise<Buffer | undefined> {
    return readBoundedBytes(path, maxBytes)
  }

  public readHead(path: string, bytes: number): Promise<Buffer> {
    return readHeadBytes(path, bytes)
  }

  public async *readTextChunks(path: string, encoding?: TextEncoding): AsyncGenerator<TextChunk> {
    const handle = await openRegularFile(path)
    try {
      const known = encoding ?? (await this.inspect(handle))
      if (!known)
        throw new AppError(TextFileErrorCodes.notText, '文件无法无损解码为文本。', undefined, {
          path,
        })
      const decoder = this.codec.createDecoder(known)
      const source = { path, encoding: known }
      const chunk = new Uint8Array(TextFileTuning.stream.chunkBytes)
      let position = 0
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        const content = decodeStrictly(() => decoder.push(chunk.subarray(0, bytesRead)), source)
        yield { content, byteOffset: position }
      }
      yield { content: decodeStrictly(() => decoder.finish(), source), byteOffset: position }
    } finally {
      await handle.close()
    }
  }

  public async readText(path: string, encoding?: TextEncoding): Promise<string> {
    const parts: string[] = []
    for await (const chunk of this.readTextChunks(path, encoding)) parts.push(chunk.content)
    return parts.join('')
  }

  public async assertUnchanged(path: string, expected: ExpectedBytes): Promise<void> {
    await assertBytesOnDisk(path, expected, TextFileIo.UnchangedMismatch)
  }

  /** 在同一个句柄上从头流式认完整个文件的编码，常量内存；认不出返回 null。 */
  private async inspect(handle: FileHandle): Promise<Nullable<TextEncoding>> {
    const probe = this.codec.createProbe()
    const chunk = new Uint8Array(TextFileTuning.stream.chunkBytes)
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      probe.push(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    return probe.finish()
  }

  /** 已有文件自己的编码：流式认完整个文件；认不出抛 notText，写入就此作罢。 */
  private async existingEncoding(path: string): Promise<TextEncoding> {
    const handle = await openRegularFile(path)
    try {
      const encoding = await this.inspect(handle)
      if (!encoding)
        throw new AppError(
          TextFileErrorCodes.notText,
          '现有文件无法无损解码，拒绝文本覆盖。',
          undefined,
          { path }
        )
      return encoding
    } finally {
      await handle.close()
    }
  }
}

/** 整个进程只有一份的文件读写，编解码用 `textCodec`。 */
export const textFileIo: TextFileIoApi = new TextFileIo(textCodec)
