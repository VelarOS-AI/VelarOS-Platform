interface StreamRawChunkDiagnostic {
  type: Nullable<string>
  keys: string[]
  choiceCount: Nullable<number>
  deltaType: Nullable<string>
  deltaKeys: string[]
  contentBlockType: Nullable<string>
  contentBlockKeys: string[]
  messageStopReason: Nullable<string>
  messageModel: Nullable<string>
  messageContentCount: Nullable<number>
  messageUsageInputTokens: Nullable<number>
  messageUsageOutputTokens: Nullable<number>
  messageKeys: string[]
  messageContentTypes: string[]
  itemType: Nullable<string>
  itemKeys: string[]
}

interface StreamDiagnostics {
  totalChunks: number
  partTypes: Record<string, number>
  textDeltaChars: number
  reasoningDeltaChars: number
  rawVisibleChars: number
  rawReasoningChars: number
  toolCallCount: number
  finishReasons: string[]
  rawFinishReasons: string[]
  inputTokens: Nullable<number>
  outputTokens: Nullable<number>
  visibleOutputTokens: Nullable<number>
  totalTokens: Nullable<number>
  reasoningTokens: Nullable<number>
  cachedInputTokens: Nullable<number>
  cacheReadInputTokens?: LooseOptional<number>
  cacheWriteInputTokens?: LooseOptional<number>
  costUsd: Nullable<number>
  rawSamples: StreamRawChunkDiagnostic[]
}

interface StreamFinishReasonDiagnostic {
  code: 'provider-finish-reason'
  message: string
  details: {
    finishReason: string
    normalizedFinishReason: string
    finishReasons: string[]
    rawFinishReasons: string[]
  }
}

type StreamDiagnosticsSummary = Omit<StreamDiagnostics, 'rawSamples'> & {
  rawSamples: StreamRawChunkDiagnostic[]
  rawSampleSummaries: string[]
}

export type {
  StreamDiagnostics,
  StreamDiagnosticsSummary,
  StreamFinishReasonDiagnostic,
  StreamRawChunkDiagnostic,
}
