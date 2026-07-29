/**
 * 手写窄类型声明：只覆盖 BrowserTraceEngine 实际用到的引擎面。
 * 引擎内部结构（parsedTrace/insights 等）刻意保持 opaque，避免追着上游类型跑。
 */

/** 引擎解析产物；对我们是不透明句柄，只在引擎 API 之间流转。 */
export interface DevtoolsParsedTrace {
  insights: DevtoolsTraceInsightSets | null
  data: unknown
  metadata: Record<string, unknown>
}

/** insight 集合：key 为 insightSetId（通常是导航 id 或 NO_NAVIGATION）。 */
export type DevtoolsTraceInsightSets = Map<
  string,
  {
    id: string
    url: URL | string
    model: Record<string, unknown>
  }
>

export interface DevtoolsTraceModel {
  resetProcessor(): void
  parse(
    events: unknown[],
    options?: { metadata?: Record<string, unknown> }
  ): Promise<void>
  parsedTrace(): DevtoolsParsedTrace | null
}

export namespace TraceEngine {
  namespace TraceModel {
    const Model: {
      createWithAllHandlers(): DevtoolsTraceModel
    }
  }
}

export interface DevtoolsAgentFocus {
  parsedTrace: DevtoolsParsedTrace
}

export const AgentFocus: {
  fromParsedTrace(parsedTrace: DevtoolsParsedTrace): DevtoolsAgentFocus
}

export class PerformanceTraceFormatter {
  constructor(focus: DevtoolsAgentFocus, deviceScope?: unknown)
  formatTraceSummary(): string
}

export class PerformanceInsightFormatter {
  constructor(focus: DevtoolsAgentFocus, insight: unknown, deviceScope?: unknown)
  formatInsight(): string
}

/** i18n 引导面：insight runner 依赖 locale 初始化，未引导会整体抛错。 */
export namespace I18n {
  namespace DevToolsLocale {
    const DevToolsLocale: {
      instance(options: {
        create: boolean
        data: {
          navigatorLanguage: string
          settingLanguage: string
          lookupClosestDevToolsLocale: (locale: string) => string
        }
      }): unknown
    }
  }
  namespace i18n {
    function registerLocaleDataForTest(locale: string, data: Record<string, unknown>): void
  }
}
