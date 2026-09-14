import { isNumber } from '@velaros-ai/core'

import type { PreparedPatch } from '../types/edit.js'
import type { FileAttributes } from '../types/snapshot.js'
import type { ProjectTextEncoding } from '../types/text.js'
import { isProjectTextEncoding } from '../utils/text.js'

/** 重建路径所需的属性随补丁传递，不依赖该路径是否已在磁盘上存在。 */
export function patchFileAttributes(patch: PreparedPatch): FileAttributes {
  const mode = patch.metadata?.fileMode
  const encoding = patch.metadata?.textEncoding
  return {
    mode:
      isNumber(mode) && Number.isInteger(mode) && mode >= 0 && mode <= 0o777
        ? mode
        : undefined,
    textEncoding: isProjectTextEncoding(encoding) ? encoding : undefined,
  }
}

/** mode=recode 的补丁写入时改用目标编码；其余补丁沿用原文件编码，回滚始终恢复原字节。 */
export function patchTargetEncoding(patch: PreparedPatch): Optional<ProjectTextEncoding> {
  const metadata = patch.metadata
  if (metadata?.op !== "replace_content" || metadata.mode !== "recode") return undefined
  return isProjectTextEncoding(metadata.targetEncoding) ? metadata.targetEncoding : undefined
}

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
