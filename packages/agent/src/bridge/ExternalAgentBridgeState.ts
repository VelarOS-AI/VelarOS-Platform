import { timingSafeEqual } from 'node:crypto'

import type { ExternalAgentBridgeCommand } from '../protocol/external-agent-bridge'

export const ExternalAgentBridgePairingLifetimeMs = 5 * 60_000
export const ExternalAgentBridgeMaxCommands = 100
export const ExternalAgentBridgeMaxProcessedEvents = 256
export const ExternalAgentBridgePairingMaxFailures = 5
export const ExternalAgentBridgePairingBlockMs = 30_000

export function externalAgentBridgeTokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/** 有界、可 ACK/replay 的命令日志；产品只决定命令 payload 的语义。 */
export class ExternalAgentBridgeCommandQueue<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  private sequenceValue = 0
  private entries: Array<ExternalAgentBridgeCommand & { type: TType; payload: TPayload }> = []

  public constructor(private readonly maxCommands = ExternalAgentBridgeMaxCommands) {}

  public get sequence(): number {
    return this.sequenceValue
  }

  public enqueue(type: TType, payload: TPayload): ExternalAgentBridgeCommand & {
    type: TType
    payload: TPayload
  } {
    const command = { sequence: ++this.sequenceValue, type, payload }
    this.entries = [...this.entries, command].slice(-this.maxCommands)
    return command
  }

  public acknowledge(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > this.sequenceValue) {
      throw new Error('External Agent Bridge acknowledgement is out of range')
    }
    this.entries = this.entries.filter((command) => command.sequence > sequence)
  }

  public after(sequence: number): ReadonlyArray<ExternalAgentBridgeCommand & {
    type: TType
    payload: TPayload
  }> {
    return this.entries.filter((command) => command.sequence > sequence)
  }
}

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

/** 两个产品共用的配对爆破节流状态机；配对码和 expiry timer 仍由产品展示层拥有。 */
export class ExternalAgentBridgePairingThrottle {
  private failures = 0
  private blockedUntilValue = 0

  public constructor(private readonly now: () => number = Date.now) {}

  public get blockedUntil(): number {
    return this.blockedUntilValue
  }

  public get isBlocked(): boolean {
    return this.blockedUntilValue > this.now()
  }

  public reject(): void {
    this.failures += 1
    if (this.failures < ExternalAgentBridgePairingMaxFailures) return
    this.failures = 0
    this.blockedUntilValue = this.now() + ExternalAgentBridgePairingBlockMs
  }

  public reset(): void {
    this.failures = 0
    this.blockedUntilValue = 0
  }
}
