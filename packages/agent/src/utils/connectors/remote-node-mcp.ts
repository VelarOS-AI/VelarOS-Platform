import { isPresent, isString, stringifyPretty } from '@velaros-ai/core'
import { Log } from '@velaros-ai/core/logger'
import type { RemoteNodeToolDescriptor } from '@velaros-ai/kernel/contracts/protocol'
import { RemoteNodeClientError } from '@velaros-ai/kernel/remote/client'

export const log = Log.tag('RemoteNodeMcpBridge')

/**
 * MCP 工具名的合法字符面比我们的 canonical id 窄,且各家客户端宽严不一。
 *
 * 节点侧的名字可能自带冒号(`domain:operation`),这里压成下划线。压平是单向的,
 * 所以必须留一张反查表——不能靠再解析一次名字把它还原回去。
 */
export function toMcpToolName(descriptor: RemoteNodeToolDescriptor): string {
  return descriptor.name.replaceAll(/[^a-zA-Z\d_-]/gu, '_')
}

/**
 * 拼远程节点工具在 MCP 面上的描述：固定前缀点明"跑在远程主机 X 上、跨机调用、不作用于本机"，后接节点自报的说明（去首尾空白）。
 * 前缀不能省——这一条正是模型最容易搞错的地方：把跨机工具当本机工具用，会在错误的机器上改文件或跑命令。
 */
export function describeTool(
  descriptor: RemoteNodeToolDescriptor,
  nodeName: string,
): string {
  const summary = descriptor.description.trim()
  return `在远程主机「${nodeName}」上执行(跨机调用,不作用于本机)。${summary}`
}

/**
 * 失败文本。
 *
 * 「结果未知」必须原样穿过 MCP 边界:MCP 只有 isError 一个布尔位,如果把半执行压成普通
 * 报错,读到它的 agent 下一步几乎必然是重试——而一次可能已经跑了一半的签名或构建,重试
 * 正是最不该自动做的动作。所以这一档在文本里说死。
 */
export function explainFailure(error: unknown, nodeName: string): string {
  if (error instanceof RemoteNodeClientError && error.resultUnknown) return `与远程主机「${nodeName}」的连接在调用期间中断,该操作**可能已经执行了一部分**。`
      + '不要直接重试:先在目标机器上确认当前状态,再决定是否重来。'
  if (error instanceof RemoteNodeClientError) return isPresent(error.nodeError)
      ? `远程调用失败(${error.code}):${error.nodeError.message}`
      : `远程调用失败(${error.code}):${error.message}`
  return `远程调用失败:${error instanceof Error ? error.message : String(error)}`
}

/**
 * 把远程工具的输出摊成一段可读文本：本来就是字符串就原样返回，否则做美化序列化。
 * 序列化抛错（输出里混进循环引用或 BigInt）时**不把这次调用判失败**——调用本身已经成功了，
 * 为一个序列化问题谎报失败会诱导调用方重试一次已经执行过的远程操作。这一档退回 `String(output)`，故障只留在 debug 日志里。
 */
export function stringifyOutput(output: unknown): string {
  if (isString(output)) return output
  try {
    return stringifyPretty(output) ?? String(output)
  } catch (error) {
    // 能力输出里混进循环引用或 BigInt 时不该把整次调用判失败:调用本身已经成功了,
    // 退回可读的字符串形式,并把序列化故障留在日志里。
    log.debug('Remote tool output could not be serialized', { error })
    return String(output)
  }
}
