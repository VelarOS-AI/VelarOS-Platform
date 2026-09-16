import { ExternalAgentBridgeMaxProcessedEvents } from './ExternalAgentBridgeCommandQueue'

/**
 * 外部 Agent 桥的事件去重窗口：桥两端会重发同一条事件（重连补发、客户端重试），这里按事件 id 记住最近见过的一批，让同一条只被处理一次。
 *
 * 实现是 `ExternalAgentBridgeEventWindow`，桥的每条连接各持一个，只在内存里、随连接消失；窗口满了按到达顺序丢最旧的 id，所以极老的事件重放会被当成首次。
 */
export interface ExternalAgentBridgeEventWindowApi {
  /** 登记一条刚到的事件：这条 id 在窗口里没见过就记下并返回 true（调用方该处理它），见过就返回 false（调用方直接丢弃）。 */
  accept(eventId: string): boolean
}

export class ExternalAgentBridgeEventWindow implements ExternalAgentBridgeEventWindowApi {
  private readonly ids = new Set<string>()

  public constructor(private readonly maxEvents = ExternalAgentBridgeMaxProcessedEvents) {}

  public accept(eventId: string): boolean {
    if (this.ids.has(eventId)) return false
    this.ids.add(eventId)
    if (this.ids.size > this.maxEvents) {
      const oldest = this.ids.values().next().value
      if (oldest) this.ids.delete(oldest)
    }
    return true
  }
}

/** 开一个已处理事件窗口，用于去重与重放判定。 */
export function createExternalAgentBridgeEventWindow(maxEvents: number = ExternalAgentBridgeMaxProcessedEvents): ExternalAgentBridgeEventWindowApi {
  return new ExternalAgentBridgeEventWindow(maxEvents)
}
