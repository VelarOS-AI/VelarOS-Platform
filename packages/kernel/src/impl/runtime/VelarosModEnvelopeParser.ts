import type { VelarosModEnvelopeParseResult } from '../../types/wire'
import { parseVelarosModEnvelope } from '../../utils/wire/mod-envelope'

/**
 * mod 清单信封的唯一解析入口。
 *
 * 一次校验，之后各域只拿自己那一节；内核只认 `module` 节，别的节对它是不透明载荷。
 */
export interface VelarosModEnvelopeApi {
  /** 解析一份 `velaros.mod.json`；解析不了不抛错，原因在结果的 `diagnostics` 里。 */
  parse(
    input: unknown,
    options?: { readonly origin?: string },
  ): VelarosModEnvelopeParseResult
}

export class VelarosModEnvelopeParser implements VelarosModEnvelopeApi {
  public parse(
    input: unknown,
    options: { readonly origin?: string } = {},
  ): VelarosModEnvelopeParseResult {
    return parseVelarosModEnvelope(input, options)
  }
}

/** 整个进程共用的 mod 信封解析器；agent、Desktop、Termel 与打包脚本都用它。 */
export const velarosModEnvelopes: VelarosModEnvelopeApi = new VelarosModEnvelopeParser()
