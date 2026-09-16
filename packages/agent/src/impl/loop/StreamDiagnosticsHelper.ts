import type { TextStreamPart, ToolSet } from 'ai'

import type { StreamDiagnostics, StreamDiagnosticsSummary, StreamFinishReasonDiagnostic } from '../../types/loop.js'

import { RawStreamText } from './AgentRawStreamTextExtractor'
import { StreamDiagnosticRecorder } from './StreamDiagnosticRecorder'

/**
 * 流诊断门面：`StreamConsumer` 消费一条 provider 流时的「随手记账 + raw 分片抢救」入口。
 *
 * 谁持有：`StreamConsumer` 每个实例一份（无状态，账本挂在传进来的 `StreamDiagnostics` 上，
 * 每条流一份、由 `createStreamDiagnostics` 开）。本类只是把 `utils/stream` 里的记录器与
 * 文本抽取器收口到一处，自己不判重试也不抛错——异常由调用方按诊断结论决定怎么收。
 */
export interface StreamDiagnosticsHelperApi {
  /** 开一条流的诊断账本；在消费第一个分片之前调，整条流共用这一份。 */
  createStreamDiagnostics(): StreamDiagnostics
  /** 逐分片记账（分片类型计数、usage、finishReason、raw 字符数）；每收到一个分片调一次，不改变流。 */
  recordStreamPartDiagnostics(diagnostics: StreamDiagnostics, part: TextStreamPart<ToolSet>): void
  /**
   * 整条流收完却没有任何可展示输出时，按账本生成一段解释性兜底文案交给用户。
   * `locale` 缺省中文；只组装文案，抛不抛空流错误由 `StreamConsumer` 决定。
   */
  buildNonDisplayableResponseMessage(
    diagnostics: StreamDiagnostics,
    locale?: 'zh-CN' | 'en-US'
  ): string
  /** 把账本压成一行可进日志的摘要（分片数、各类计数、token 账）；只在告警日志里用。 */
  summarizeStreamDiagnostics(diagnostics: StreamDiagnostics): StreamDiagnosticsSummary
  /**
   * 结束原因异常（如上游 `length` 截断）时产出一条可写进 provider 回合账本的诊断；正常收尾返回 null。
   * `StreamConsumer` 据此判断要不要抛可续写的截断错误。
   */
  buildAbnormalFinishReasonDiagnostic(
    diagnostics: StreamDiagnostics
  ): Nullable<StreamFinishReasonDiagnostic>
  /** 从 `raw` 分片里抢救思考文本；SDK 整条流都没给结构化 reasoning 时才作数，取不到返回空串。 */
  extractReasoningDeltaFromRawChunk(rawValue: unknown): string
  /** 从 `raw` 分片里抢救可见正文；同样只在 SDK 没给非空 text-delta 时兜底，取不到返回空串。 */
  extractVisibleTextFromRawChunk(rawValue: unknown): string
}

class StreamDiagnosticsHelper implements StreamDiagnosticsHelperApi {
  constructor(
    private readonly recorder = new StreamDiagnosticRecorder(),
    private readonly textExtractor = new RawStreamText(),
  ) {}

  public createStreamDiagnostics(): StreamDiagnostics {
    return this.recorder.createStreamDiagnostics()
  }

  public recordStreamPartDiagnostics(diagnostics: StreamDiagnostics, part: TextStreamPart<ToolSet>): void {
    this.recorder.recordStreamPartDiagnostics(diagnostics, part)
  }

  public buildNonDisplayableResponseMessage(
    diagnostics: StreamDiagnostics,
    locale: 'zh-CN' | 'en-US' = 'zh-CN'
  ): string {
    return this.recorder.buildNonDisplayableResponseMessage(diagnostics, locale)
  }

  public summarizeStreamDiagnostics(diagnostics: StreamDiagnostics): StreamDiagnosticsSummary {
    return this.recorder.summarizeStreamDiagnostics(diagnostics)
  }

  public buildAbnormalFinishReasonDiagnostic(
    diagnostics: StreamDiagnostics
  ): Nullable<StreamFinishReasonDiagnostic> {
    return this.recorder.buildAbnormalFinishReasonDiagnostic(diagnostics)
  }

  public extractReasoningDeltaFromRawChunk(rawValue: unknown): string {
    return this.textExtractor.extractReasoningDeltaFromRawChunk(rawValue)
  }

  public extractVisibleTextFromRawChunk(rawValue: unknown): string {
    return this.textExtractor.extractVisibleTextFromRawChunk(rawValue)
  }
}

export { StreamDiagnosticsHelper }
export { StreamDiagnosticsHelper as AgentStreamDiagnosticHelper }
