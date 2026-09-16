import { extractReasoningDeltaFromRawChunk, extractVisibleTextFromRawChunk } from '../../utils/stream/raw-text'

/**
 * Agent stream 对 provider raw chunk 的容错文本投影。
 *
 * 这是 Agent 流消费语义，不依赖具体 Model registry/provider 创建实现。投影规则本身是纯函数
 * （`utils/stream/raw-text.ts`），这里只把它们收成一个可注入的抽取件：`StreamDiagnosticsHelper`
 * 持有一份，宿主要换掉「raw 分片怎么读」时不必改流消费本身。无状态，可重复调用。
 */
export interface AgentRawStreamTextExtractorApi {
  /** 从一条 raw 分片里抢救思考文本；只在 SDK 没给结构化 reasoning 时作兜底，认不出形状返回空串，不抛错。 */
  extractReasoningDeltaFromRawChunk(rawValue: unknown): string
  /** 从一条 raw 分片里抢救可见正文；只在 SDK 没给非空 text-delta 时作兜底，认不出形状返回空串，不抛错。 */
  extractVisibleTextFromRawChunk(rawValue: unknown): string
}

class AgentRawStreamTextExtractor implements AgentRawStreamTextExtractorApi {
  public extractReasoningDeltaFromRawChunk(rawValue: unknown): string {
    return extractReasoningDeltaFromRawChunk(rawValue)
  }

  public extractVisibleTextFromRawChunk(rawValue: unknown): string {
    return extractVisibleTextFromRawChunk(rawValue)
  }
}

export { AgentRawStreamTextExtractor }
export { AgentRawStreamTextExtractor as RawStreamText }
