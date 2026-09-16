import { isUndefined } from '@velaros-ai/core'

import type { KernelArtifactSignatureVerifier } from '../../contract/requires'
import type { KernelArtifactSignatureContext, KernelArtifactSignatureResult } from '../../types/updater'
/**
 * 缺省签名校验器：一律报「没校验」，但不拦安装。
 *
 * 实例由 `KernelUpdater` 在没人注入校验器时兜底建一个；要真的拦下来，部署方注入自己的校验器
 * 并打开 `requireSignature`。
 */
export class UnverifiedKernelArtifactSignatureVerifier
implements KernelArtifactSignatureVerifier {
  public verify(
    context: KernelArtifactSignatureContext,
  ): Promise<KernelArtifactSignatureResult> {
    return Promise.resolve({
      verified: false,
      method: 'none',
      reason: isUndefined(context.artifact.signature)
        ? '没有装签名校验器'
        : '制品带了签名，但本机没有装校验器',
    })
  }
}
