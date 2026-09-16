// 子 Agent 引导转达：提示词组装与转达计划的解析、归一。
import type { BuildGuidanceRelayPromptInput, GuidanceRelayPlan, SubAgentGuidanceRelayWorkerSnapshot } from '../../types/records'
import { buildGuidanceRelayPrompt, normalizeGuidanceRelayPlan, parseGuidanceRelayPlan, resolveMainAgentGuidanceMessage } from '../../utils/records/guidance-relay'

/**
 * 引导转达的纯数据面：宿主实现 `ExecutionGuidanceRelayPlanner` 时用它组提示词、解模型回复。
 *
 * 计划的 zod schema 不出包，外面一律经 `parsePlan` 解析。无状态，进程内共用一份。
 */
export interface GuidanceRelayKitApi {
  /** 把当前在跑的子 Agent 与用户插话组装成转达提示词。 */
  buildPrompt(input: BuildGuidanceRelayPromptInput): string
  /** 解析模型给的转达计划；形状不对按错误码抛。 */
  parsePlan(raw: unknown): GuidanceRelayPlan
  /** 把转达计划归一：丢掉已经收尾的线程、去重、限长。 */
  normalizePlan(plan: GuidanceRelayPlan, workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]): GuidanceRelayPlan
  /** 解出这次转达要回灌给主 Agent 的那条消息；没有就返回 null。 */
  resolveMainAgentMessage(plan: GuidanceRelayPlan): Nullable<string>
}

/** 方法逐个转调 utils/records/guidance-relay 里的纯函数；这里只负责把它们收成一件对外能力。 */
class GuidanceRelayKit implements GuidanceRelayKitApi {
  public buildPrompt(input: BuildGuidanceRelayPromptInput): string {
    return buildGuidanceRelayPrompt(input)
  }

  public parsePlan(raw: unknown): GuidanceRelayPlan {
    return parseGuidanceRelayPlan(raw)
  }

  public normalizePlan(plan: GuidanceRelayPlan, workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]): GuidanceRelayPlan {
    return normalizeGuidanceRelayPlan(plan, workers)
  }

  public resolveMainAgentMessage(plan: GuidanceRelayPlan): Nullable<string> {
    return resolveMainAgentGuidanceMessage(plan)
  }
}

/** 引导转达的组装与解析面（无状态，进程内共用一份）。 */
export const guidanceRelay: GuidanceRelayKitApi = new GuidanceRelayKit()
