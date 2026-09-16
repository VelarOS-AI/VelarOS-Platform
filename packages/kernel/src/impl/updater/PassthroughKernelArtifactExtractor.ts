import { copyFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { KernelArtifactExtractor } from '../../contract/requires'
import type { KernelArtifact, KernelArtifactExtractionContext } from '../../types/updater'
/**
 * 缺省解包器：把制品当成一个不透明文件原样拷进暂存目录。
 *
 * 展开 tar / zip 需要内核不愿意背的第三方实现，所以发 `tar.gz`、`tar.zst`、`zip` 制品的部署
 * 自己注入一个解包器；实例由 `KernelUpdater` 在没人注入时兜底建一个。
 */
export class PassthroughKernelArtifactExtractor
implements KernelArtifactExtractor {
  public async extract(
    context: KernelArtifactExtractionContext,
  ): Promise<void> {
    await copyFile(
      context.payloadPath,
      join(context.destinationDirectory, kernelArtifactFileName(context.artifact)),
    )
  }
}

/**
 * 制品落盘时用的文件名：从制品地址的末段取，非法字符换成 `-`。
 *
 * 取不出能用的名字（空、`.`、`..`）就退回 `kernel-payload`，绝不让制品地址决定往哪写。
 */
export function kernelArtifactFileName(artifact: KernelArtifact): string {
  const pathname = URL.canParse(artifact.url)
    ? new URL(artifact.url).pathname
    : artifact.url.split(/[?#]/)[0] ?? ''
  const candidate = basename(pathname)
    .replaceAll(/[^A-Za-z0-9._-]/g, '-')
  return candidate.length > 0 && candidate !== '.' && candidate !== '..'
    ? candidate
    : 'kernel-payload'
}
