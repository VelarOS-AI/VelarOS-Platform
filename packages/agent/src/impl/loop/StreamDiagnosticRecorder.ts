import type { TextStreamPart, ToolSet } from 'ai'

import type { StreamDiagnostics, StreamDiagnosticsSummary, StreamFinishReasonDiagnostic } from '../../types/loop.js'
import {
  buildAbnormalFinishReasonDiagnostic,
  buildNonDisplayableResponseMessage,
  createStreamDiagnostics,
  recordStreamPartDiagnostics,
  summarizeStreamDiagnostics,
} from '../../utils/stream/recorder'

/**
 * 一条 provider 流的诊断记录器：开账本、逐分片记账、收尾时给结论。
 *
 * 记账规则本身是纯函数（`utils/stream/recorder.ts`），这里只把它们收成一个可注入的记录件，
 * 让宿主换掉「记什么、怎么判异常收尾」时不必改流消费本身。记录器自己无状态：账本由
 * `createStreamDiagnostics` 开、每条流一份，逐次当参数传进来。
 */
export interface StreamDiagnosticRecorderApi {
  /** 开一条流的诊断账本；在消费第一个分片之前调，整条流共用这一份。 */
  createStreamDiagnostics(): StreamDiagnostics
  /** 逐分片记账（分片类型计数、正文/思考字符数、usage、finishReason、raw 样本）；每收到一个分片调一次，就地改账本，不改变流。 */
  recordStreamPartDiagnostics(diagnostics: StreamDiagnostics, part: TextStreamPart<ToolSet>): void
  /**
   * 整条流收完却没有任何可展示输出时，按账本生成一段解释性兜底文案交给用户。
   * `locale` 缺省中文；只组装文案，抛不抛空流错误由调用方决定。
   */
  buildNonDisplayableResponseMessage(
    diagnostics: StreamDiagnostics,
    locale?: 'zh-CN' | 'en-US'
  ): string
  /** 把账本压成一行可进日志的摘要（分片数、各类计数、token 账、raw 样本形状）；只在告警日志里用。 */
  summarizeStreamDiagnostics(diagnostics: StreamDiagnostics): StreamDiagnosticsSummary
  /**
   * 结束原因异常（如上游 `length` 截断）时产出一条可写进 provider 回合账本的诊断；正常收尾返回 null。
   * 调用方据此判断要不要抛可续写的截断错误。
   */
  buildAbnormalFinishReasonDiagnostic(
    diagnostics: StreamDiagnostics
  ): Nullable<StreamFinishReasonDiagnostic>
}

class StreamDiagnosticRecorder implements StreamDiagnosticRecorderApi {
  public createStreamDiagnostics(): StreamDiagnostics {
    return createStreamDiagnostics()
  }

  public recordStreamPartDiagnostics(diagnostics: StreamDiagnostics, part: TextStreamPart<ToolSet>): void {
    recordStreamPartDiagnostics(diagnostics, part)
  }

  public buildNonDisplayableResponseMessage(
    diagnostics: StreamDiagnostics,
    locale: 'zh-CN' | 'en-US' = 'zh-CN'
  ): string {
    return buildNonDisplayableResponseMessage(diagnostics, locale)
  }

  public summarizeStreamDiagnostics(diagnostics: StreamDiagnostics): StreamDiagnosticsSummary {
    return summarizeStreamDiagnostics(diagnostics)
  }

  public buildAbnormalFinishReasonDiagnostic(
    diagnostics: StreamDiagnostics
  ): Nullable<StreamFinishReasonDiagnostic> {
    return buildAbnormalFinishReasonDiagnostic(diagnostics)
  }
}

export { StreamDiagnosticRecorder }
export { StreamDiagnosticRecorder as AgentStreamDiagnosticRecorder }
