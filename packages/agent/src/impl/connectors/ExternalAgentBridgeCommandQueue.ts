import { timingSafeEqual } from 'node:crypto'

import { ExternalAgentBridgeLimits } from '../../contract/constants.js'
import type { ExternalAgentBridgeCommand } from '../../types/agent.js'


/** 一份配对码的有效期（ms），等价于 `ExternalAgentBridgeLimits.pairingLifetimeMs`。 */
export const ExternalAgentBridgePairingLifetimeMs: number = ExternalAgentBridgeLimits.pairingLifetimeMs
/** 未确认命令队列的堆积上限，等价于 `ExternalAgentBridgeLimits.maxCommands`。 */
export const ExternalAgentBridgeMaxCommands: number = ExternalAgentBridgeLimits.maxCommands
/** 已处理事件窗口的保留条数，等价于 `ExternalAgentBridgeLimits.maxProcessedEvents`。 */
export const ExternalAgentBridgeMaxProcessedEvents: number = ExternalAgentBridgeLimits.maxProcessedEvents
/** 进封禁前允许连续配对失败几次，等价于 `ExternalAgentBridgeLimits.pairingMaxFailures`。 */
export const ExternalAgentBridgePairingMaxFailures: number = ExternalAgentBridgeLimits.pairingMaxFailures
/** 配对失败超限后的封禁时长（ms），等价于 `ExternalAgentBridgeLimits.pairingBlockMs`。 */
export const ExternalAgentBridgePairingBlockMs: number = ExternalAgentBridgeLimits.pairingBlockMs

export function externalAgentBridgeTokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/**
 * 外部 Agent 桥发往对端的命令日志：每条命令拿一个递增序号，对端 ACK 之前一直留着，断线重连时按对端报上来的序号补发没收到的那几条。
 *
 * 实现是 `ExternalAgentBridgeCommandQueue`，桥的每条连接各持一个；只在内存里，最多留 `maxCommands` 条，挤爆了从最旧的丢（对端离线太久就得重新握手）。命令 payload 的语义归产品自己定，这里只管顺序和留存。
 */
export interface ExternalAgentBridgeCommandQueueApi<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  /** 到目前为止发出过的最大序号，也就是下一条命令会拿到的序号减一；重连握手时报给对端，让它知道自己落后多少。 */
  readonly sequence: number
  /** 追加一条待发命令：分配下一个序号、存进日志、把完整命令返回给调用方去发；日志超过上限时最旧的那条被挤掉。 */
  enqueue(type: TType, payload: TPayload): ExternalAgentBridgeCommand & {
    /** 命令类型，由产品自己定义的那套字面量之一。 */
    type: TType
    /** 命令参数，由产品自己定义形状；桥只负责原样传。 */
    payload: TPayload
  }
  /** 对端报告「序号 <= sequence 的都收到了」时调用，把这些命令从日志里删掉；sequence 不是整数、为负、或超过已发出的最大序号时抛错（说明对端在乱报）。 */
  acknowledge(sequence: number): void
  /** 取序号大于 sequence 的全部待发命令，按序号从小到大：重连后拿对端报的位置来补发。对端落后太多、缺的那几条已被挤掉时，这里只会给出还留着的部分。 */
  after(sequence: number): ReadonlyArray<ExternalAgentBridgeCommand & {
    /** 命令类型，由产品自己定义的那套字面量之一。 */
    type: TType
    /** 命令参数，由产品自己定义形状；桥只负责原样传。 */
    payload: TPayload
  }>
}

export class ExternalAgentBridgeCommandQueue<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> implements ExternalAgentBridgeCommandQueueApi<TType, TPayload> {
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
      throw new Error('External Agent Bridge 的确认序号超出范围：它必须是 0 到当前已派发的最大序号之间的整数。')
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



