// 域:`velaros-remote-mcp` 可执行入口的纯函数部分——参数解析与 stdout 夺取。
//
// stdout 是 MCP 的数据通道:**任何诊断都只能走 stderr**,往 stdout 打一个字节就会把
// JSON-RPC 帧撕坏,表现是客户端毫无征兆地断连。
import process from 'node:process'

import { isNonBlankString } from '@velaros-ai/core'

import type { EntryArguments } from '../../types/connectors.js'

/**
 * 解析 `velaros-remote-mcp` 的命令行参数（`--key=value` 形式），缺的项回落环境变量。
 *
 * 节点地址是硬要求，拿不到就直接抛错而不是空转;配对码只在首次配对用一次，允许走环境变量是为了
 * 不让它进 shell 历史和进程列表——命令行参数在同机上是所有进程可见的。
 */
export function readArguments(argv: readonly string[]): EntryArguments {
  const values = new Map<string, string>()
  for (const entry of argv) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(entry)
    if (match) values.set(match[1]!, match[2]!)
  }
  const url = values.get('url') ?? process.env.VELAROS_REMOTE_NODE_URL
  if (!isNonBlankString(url)) {
    throw new Error(
      'Missing --url=<ws://host:port/v1/remote-node/ws> (or VELAROS_REMOTE_NODE_URL).',
    )
  }
  const hostSlug = values.get('host') ?? 'default'
  // 配对码只在首次配对用一次。允许走环境变量是为了不让它进 shell 历史和进程列表——
  // 命令行参数在同机上是所有进程可见的。
  const pairingCode = values.get('pairing-code')
    ?? process.env.VELAROS_REMOTE_NODE_PAIRING_CODE
  return {
    url: url.trim(),
    hostSlug,
    clientName: values.get('client-name') ?? `MCP client (${process.pid})`,
    pairingCode: isNonBlankString(pairingCode) ? pairingCode.trim() : null,
  }
}

/**
 * 把真 stdout 让给 MCP,其余全部改道 stderr。
 *
 * 不是洁癖:`@velaros-ai/core` 的 Log 把 info/debug 写 stdout,凭据落盘那一行就足以把
 * JSON-RPC 帧撕断,表现是客户端毫无征兆地断连(这个 bug 是冒烟测试抓出来的)。与其逐个
 * 库去关日志——传递依赖里随时会冒出新的写者——不如在进程口子上一次性夺走 stdout。
 *
 * 返回被夺走的真 stdout,只交给 MCP 传输。
 */
export function seizeStdout(): NodeJS.WriteStream {
  const realStdout = process.stdout
  const write = realStdout.write.bind(realStdout)
  Object.defineProperty(process, 'stdout', {
    configurable: true,
    get: () => process.stderr,
  })
  return Object.assign(Object.create(realStdout) as NodeJS.WriteStream, {
    write,
  })
}
