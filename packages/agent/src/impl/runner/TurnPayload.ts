import type { StreamTurnContextPayload } from '../../types/agent'
import type { BuildTurnContextPayloadArgs } from '../../types/runner.js'
import { buildTurnContextPayload } from '../../utils/runner/turn-payload'

/**
 * 单轮 turn 的调试上下文载荷构造器。
 *
 * 供执行协调器 / 渲染进程调试面板展示：本轮角色、系统提示词片段、
 * 可见工具、消息快照等；不参与模型推理本身。
 *
 * 组装规则本身是纯函数（utils/runner/turn-payload.ts），这里只把它收成一件可注入的东西。
 */
export interface TurnPayloadApi {
  /**
   * 组装本轮的调试载荷：角色解析结果、系统提示词与片段、真实可用的工具与类别、消息快照与各路遥测。
   * 消息快照会滤掉内部追问消息，重复轮里较早的长用户消息只留省略提示与开头预览，
   * 图片与文件只留体积摘要——省的都是调试载荷，真实历史不受影响。
   */
  build(args: BuildTurnContextPayloadArgs): StreamTurnContextPayload
}

class TurnPayload implements TurnPayloadApi {
  public build(args: BuildTurnContextPayloadArgs): StreamTurnContextPayload {
    return buildTurnContextPayload(args)
  }
}

export { TurnPayload }
export { TurnPayload as AgentTurnContextPayloadBuilder }
