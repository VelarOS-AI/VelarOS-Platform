// 域：执行会话运行时的宿主边界端口。
//
// 执行会话运行时（ExecutionService / ManagedExecutionRunner）本体 host 无关，只认端口不认实现：
// 准入断言、执行记录落盘路径、资源作用域解析、协作信号、协作者账本、子 Agent 引导 relay 规划器
// 全部由产品宿主在装配处提供具体实现。这样桌面、headless、BYOK 和 Web 等宿主
// 可注入各自实现，而不会把某个产品的服务拖进内核执行链路。
import type { GuidanceRelayPlan, SubAgentGuidanceRelayWorkerSnapshot } from '../../execution'
import type { ExecutionResourceProvider } from '../../execution'

/**
 * 准入断言端口。
 *
 * 语义 = 「当前进程是否处于已授权运行态」的单点断言，把执行域对具体登录判定源
 * 直接依赖收拢成一个窄接口：执行域只认端口，装配层注入实现。headless 或 BYOK 宿主可提供
 * 与其部署模型匹配的授权策略。
 */
export interface AuthGatePort {
  /** 未处于已验证登录态时抛 `AppError('AUTH')`。 */
  assertAuthenticated(): void
}

/**
 * 执行记录落盘路径端口。
 *
 * 把 ExecutionStore 持久化路径对具体存储服务的依赖收拢成一个窄接口。
 */
export interface ExecutionRecordsPathPort {
  /** 返回执行记录持久化文件路径。 */
  getExecutionRecordsPath(): string
}

/**
 * 执行资源端口。资源可表示项目、页面、设备或宿主任意可寻址对象。
 */
export interface ExecutionResourcePort extends ExecutionResourceProvider {
  /** 解析指定会话的可选执行资源标识。 */
  getExecutionResourceId(sessionId?: string): Nullable<string>
}

/**
 * 执行活动信号端口。宿主可在执行期间保持监听器或遥测会话。
 */
export interface ExecutionActivitySignalsPort {
  /** 保活指定会话的宿主活动信号，返回释放函数。 */
  beginExecutionSession(sessionId: string): () => void
}

/** {@link ExecutionCollaborationPort.registerActor} 入参：主 Agent 执行者登记。 */
export interface ExecutionCollaborationActorInput {
  actorId: string
  kind: 'main-agent'
  resourceId: Nullable<string>
  sessionId: string
  executionId: string
  status: 'active'
  summary: string
}

/** {@link ExecutionCollaborationPort.registerActor} 返回的执行者句柄。 */
export interface ExecutionCollaborationActorHandle {
  /** 标记执行者完成，释放其协作占用。 */
  complete(): void
}

/**
 * 执行协作端口。
 *
 * 把托管执行者登记进宿主协作账本，收尾时通过句柄标记完成。
 */
export interface ExecutionCollaborationPort {
  registerActor(input: ExecutionCollaborationActorInput): ExecutionCollaborationActorHandle
}

/** {@link ExecutionGuidanceRelayPlanner.planRelay} 入参。 */
export interface ExecutionGuidanceRelayPlanInput {
  userGuidance: string
  workers: readonly SubAgentGuidanceRelayWorkerSnapshot[]
}

/** {@link ExecutionGuidanceRelayPlanner.planRelay} 返回的 relay 规划。 */
export interface ExecutionGuidanceRelayPlan {
  relays: GuidanceRelayPlan['relays']
  mainAgentMessage: Nullable<string>
}

/**
 * 子 Agent 引导 relay 规划器端口。
 *
 * 用户对运行中会话追加引导时，规划面向各活跃子 Agent 的改写 relay 与主控消息。
 * 产品宿主可注入使用辅助模型或确定性规则的 relay 规划器。
 */
export interface ExecutionGuidanceRelayPlanner {
  planRelay(input: ExecutionGuidanceRelayPlanInput): Promise<ExecutionGuidanceRelayPlan>
}
