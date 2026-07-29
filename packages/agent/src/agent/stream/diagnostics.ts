import type { TextStreamPart, ToolSet } from 'ai'

import { RawStreamText } from './raw-text'
import { StreamDiagnosticRecorder } from './recorder'
import type {
  StreamDiagnostics,
  StreamDiagnosticsSummary,
  StreamFinishReasonDiagnostic,
} from './types'

class StreamDiagnosticsHelper {
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
export type {
  StreamDiagnostics,
  StreamDiagnosticsSummary,
  StreamFinishReasonDiagnostic,
  StreamRawChunkDiagnostic,
} from './types'
export { StreamDiagnosticsHelper as AgentStreamDiagnosticHelper }
