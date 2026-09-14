import { type FileHandle, open } from 'node:fs/promises'

import { ProjectError } from '../errors.js'
import { createProjectTextDecoder, type ProjectTextEncoding,ProjectTextEncodingProbe } from '../utils/text.js'

const ChunkBytes = 64 * 1024

/** 对同一文件句柄做常量内存的完整判定，避免长 ASCII 前缀掩盖后续旧编码字符。 */
async function inspectEncoding(handle: FileHandle): Promise<ProjectTextEncoding> {
  const probe = new ProjectTextEncodingProbe()
  const bytes = new Uint8Array(ChunkBytes)
  let position = 0
  while (true) {
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, position)
    if (bytesRead === 0) break
    probe.push(bytes.subarray(0, bytesRead))
    position += bytesRead
  }
  const encoding = probe.finish()
  if (!encoding) throw new ProjectError('NOT_SUPPORTED', '文件无法无损解码为项目文本。')
  return encoding
}

/** 单次读取绑定一个严格解码器；跨块字节由解码器保留，提前结束也会关闭文件句柄。 */
export async function* readProjectTextChunks(
  path: string,
  knownEncoding?: ProjectTextEncoding,
): AsyncGenerator<{ content: string; byteOffset: number }> {
  const handle = await open(path, 'r')
  try {
    const decoder = createProjectTextDecoder(knownEncoding ?? await inspectEncoding(handle))
    const bytes = new Uint8Array(ChunkBytes)
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      yield { content: decoder.decode(bytes.subarray(0, bytesRead), { stream: true }), byteOffset: position }
    }
    yield { content: decoder.decode(), byteOffset: position }
  } finally {
    await handle.close()
  }
}

/** 完整文本读取与窗口读取共享同一解码边界。 */
export async function readProjectTextFile(path: string, encoding?: ProjectTextEncoding): Promise<string> {
  const parts: string[] = []
  for await (const part of readProjectTextChunks(path, encoding)) parts.push(part.content)
  return parts.join('')
}
