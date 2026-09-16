import { serializeTurnToolResultForModel } from '../../utils/history/turn'

/**
 * 工具结果的模型面序列化口：把任意一份工具返回值翻成写进历史的字符串。
 *
 * 序列化规则本身是纯函数（`utils/history/turn.ts`），这里只把它收成一个可注入的件：
 * 同一份结果在「写回历史」「拼 error-text」「比对模型内容是否就是结果本身」三处必须是同一种写法，
 * 换写法只换这一个件。无状态，导出的 {@link agentToolResultHelper} 是全进程共用的那一份。
 */
export interface ToolResultsApi {
  /** 序列化一份工具结果；`toolInput` 是该次调用的原始入参，用来推序列化提示（缺省时按默认写法）。 */
  serializeForModel(result: unknown, toolInput?: unknown): string
}

class ToolResults implements ToolResultsApi {
  public serializeForModel(result: unknown, toolInput?: unknown): string {
    return serializeTurnToolResultForModel(result, toolInput)
  }
}

/** 全进程共用的工具结果序列化件。 */
export const agentToolResultHelper: ToolResultsApi = new ToolResults()

export { ToolResults as AgentToolResultHelper,ToolResults }
