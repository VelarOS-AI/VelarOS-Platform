import { isEmpty } from '@velaros-ai/core'

import type { ProviderToolReferenceCanonicalizer as ProviderToolReferenceCanonicalizerApi } from '../../types/tools.js'
import { ProviderToolIdentityTokenCharacters, rewriteProviderToolReferences } from '../../utils/tools/tool-identity'

/**
 * 流式正文按完整 identity token 还原，避免别名跨 chunk 时漏回用户界面或持久历史。
 * 只暂存末尾尚未闭合的 token；空映射时完全透传。
 */
class ProviderToolReferenceCanonicalizer implements ProviderToolReferenceCanonicalizerApi {
  /** 映射为空时整条通道透传，不做任何改写。 */
  private readonly enabled: boolean
  /** 末尾尚未闭合的 identity token；下一片到达时与它拼接后再判定。 */
  private pending = ''

  constructor(private readonly providerToCanonical: Readonly<Record<string, string>>) {
    this.enabled = !isEmpty(Object.keys(providerToCanonical))
  }

  /** 吃进一片流式正文，返回已经可以安全还原的部分。 */
  public push(text: string): string {
    if (!this.enabled) return text
    this.pending += text
    const incompleteToken = new RegExp(`[${ProviderToolIdentityTokenCharacters}]+$`, 'u').exec(
      this.pending
    )
    const stableEnd = incompleteToken?.index ?? this.pending.length
    const stable = this.pending.slice(0, stableEnd)
    this.pending = this.pending.slice(stableEnd)
    return rewriteProviderToolReferences(stable, this.providerToCanonical)
  }

  /** 收尾：把暂存的尾巴还原并清空。 */
  public flush(): string {
    const output = rewriteProviderToolReferences(this.pending, this.providerToCanonical)
    this.pending = ''
    return output
  }
}

/** 按一次请求的别名映射开一条还原通道。 */
function createProviderToolReferenceCanonicalizer(
  providerToCanonical: Readonly<Record<string, string>>
): ProviderToolReferenceCanonicalizerApi {
  return new ProviderToolReferenceCanonicalizer(providerToCanonical)
}

export { createProviderToolReferenceCanonicalizer }
