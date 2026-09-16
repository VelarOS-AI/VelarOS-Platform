import { timingSafeEqual } from 'node:crypto'

import type { ExternalAgentBridgeCommand } from '../../types/agent.js'


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



