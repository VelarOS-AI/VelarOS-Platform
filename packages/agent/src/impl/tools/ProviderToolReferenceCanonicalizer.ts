import { isEmpty } from '@velaros-ai/core'

import type { ProviderToolReferenceCanonicalizer as ProviderToolReferenceCanonicalizerContract } from '../../types/tools.js'
import { ProviderToolIdentityTokenCharacters, rewriteProviderToolReferences } from '../../utils/tools/tool-identity'

/**
 * 一条流式还原通道：把供应商侧的工具别名换回 canonical identity token。
 *
 * 由 `createProviderToolReferenceCanonicalizer` 按一次请求的别名映射建一条，状态（尚未闭合的尾巴）
 * 只属于这条通道，正文必须按到达顺序喂进来，收尾时调 `flush` 把尾巴吐干净。
 * 形状与对外公开的 `ProviderToolReferenceCanonicalizer` 同源，这里只把它挪到类上方当本类的接口。
 */
export interface ProviderToolReferenceCanonicalizerApi extends ProviderToolReferenceCanonicalizerContract {}

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
): ProviderToolReferenceCanonicalizerContract {
  return new ProviderToolReferenceCanonicalizer(providerToCanonical)
}

export { createProviderToolReferenceCanonicalizer }
