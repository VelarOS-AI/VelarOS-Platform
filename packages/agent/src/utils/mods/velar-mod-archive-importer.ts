// VelarModArchiveImporter 用到的纯函数（不碰实例状态）。
import type { JSZipObject } from 'jszip'

import type { ZipSizeData } from '../../types/mods.js'

/** 读一个 zip 条目的压缩前后字节数，用来在解压前拦住超限的包。 */
export function readZipSizes(entry: JSZipObject): { compressed: number; expanded: number } {
  const data = (entry as JSZipObject & { _data?: ZipSizeData })._data
  return {
    compressed: Number(data?.compressedSize ?? 0),
    expanded: Number(data?.uncompressedSize ?? 0),
  }
}
