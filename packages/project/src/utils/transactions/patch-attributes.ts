/**
 * 补丁携带的文件属性（权限位、文本编码）：路径被删掉后重建、重命名到新路径时，靠补丁记下的属性还原，不依赖磁盘上还有没有原文件。
 */

import { isNumber } from '@velaros-ai/core'
import { textCodec } from '@velaros-ai/text-files'
import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import type { PreparedPatch } from '../../types/edit.js'
import type { FileAttributes } from '../../types/snapshot.js'

/** 重建路径所需的属性随补丁传递，不依赖该路径是否已在磁盘上存在。 */
export function patchFileAttributes(patch: PreparedPatch): FileAttributes {
  const mode = patch.metadata?.fileMode
  const encoding = patch.metadata?.textEncoding
  return {
    mode:
      isNumber(mode) && Number.isInteger(mode) && mode >= 0 && mode <= 0o777
        ? mode
        : undefined,
    textEncoding: textCodec.isEncoding(encoding) ? encoding : undefined,
  }
}

/** mode=recode 的补丁写入时改用目标编码；其余补丁沿用原文件编码，回滚始终恢复原字节。 */
export function patchTargetEncoding(patch: PreparedPatch): Optional<TextEncoding> {
  const metadata = patch.metadata
  if (metadata?.op !== "replace_content" || metadata.mode !== "recode") return undefined
  return textCodec.isEncoding(metadata.targetEncoding) ? metadata.targetEncoding : undefined
}

/** 把文件属性（权限位、文本编码）记进补丁的 metadata，返回新补丁。 */
export function withPatchFileAttributes(
  patch: PreparedPatch,
  attributes: FileAttributes,
): PreparedPatch {
  return {
    ...patch,
    metadata: {
      ...patch.metadata,
      fileMode: attributes.mode,
      textEncoding: attributes.textEncoding,
    },
  }
}
