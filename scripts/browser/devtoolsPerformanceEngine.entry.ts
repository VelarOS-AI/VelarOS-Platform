// Narrow public surface used by @velaros-ai/browser. Keep this entry aligned with
// packages/browser/vendor/devtools-performance-engine/devtoolsPerformanceEngine.d.mts.
import 'chrome-devtools-frontend/front_end/core/sdk/sdk-meta.js'
import 'chrome-devtools-frontend/front_end/models/workspace/workspace-meta.js'

export * as I18n from 'chrome-devtools-frontend/front_end/core/i18n/i18n.js'
export {
  PerformanceInsightFormatter,
} from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js'
export {
  PerformanceTraceFormatter,
} from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js'
export {
  AgentFocus,
} from 'chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js'
export * as TraceEngine from 'chrome-devtools-frontend/front_end/models/trace/trace.js'
