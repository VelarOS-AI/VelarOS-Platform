import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { KernelArtifactExtractor } from '../../contract/requires'
import type { KernelArtifactExtractionContext } from '../../types/updater'
import { kernelArtifactFileName } from '../../utils/updater/manifest'
/**
 * 缺省解包器：把制品当成一个不透明文件原样拷进暂存目录。
 *
 * 展开 tar / zip 需要内核不愿意背的第三方实现，所以发 `tar.gz`、`tar.zst`、`zip` 制品的部署
 * 自己注入一个解包器；实例由 `KernelUpdater` 在没人注入时兜底建一个。
 */
export class PassthroughKernelArtifactExtractor implements KernelArtifactExtractor {
  public async extract(context: KernelArtifactExtractionContext): Promise<void> {
    await copyFile(
      context.payloadPath,
      join(context.destinationDirectory, kernelArtifactFileName(context.artifact))
    )
  }
}
