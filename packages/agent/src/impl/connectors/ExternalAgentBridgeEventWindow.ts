import { ExternalAgentBridgeMaxProcessedEvents } from './ExternalAgentBridgeCommandQueue'

/** 返回 true 表示首次事件；窗口满后按到达顺序淘汰最旧 id。 */
export class ExternalAgentBridgeEventWindow {
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
