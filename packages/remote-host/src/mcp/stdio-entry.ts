// 域:`velaros-remote-mcp` 可执行入口——把一台远程能力节点接成本地 MCP stdio 服务器。
//
// 消费方是**不能改的** agent(Codex / Claude Code / 任何 MCP 客户端):它们在自己的配置里
// 把本命令登记成一个 MCP server,就得到了目标机器的全部工具面,而不需要认识 remote-node
// 协议。到 Host 的线仍然只有一条,认证与审计都在那一条上。
//
// stdout 是 MCP 的数据通道:**任何诊断都只能走 stderr**,往 stdout 打一个字节就会把
// JSON-RPC 帧撕坏,表现是客户端毫无征兆地断连。
import process from 'node:process'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isNonBlankString } from '@velaros-ai/core'

import {
  defaultRemoteNodeCredentialsPath,
  FileRemoteNodeCredentialStore,
  RemoteNodeClient,
} from '../client'

import { createRemoteNodeMcpServer } from './RemoteNodeMcpBridge'

interface EntryArguments {
  readonly url: string
  readonly hostSlug: string
  readonly clientName: string
  readonly pairingCode: Nullable<string>
}

function readArguments(argv: readonly string[]): EntryArguments {
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
function seizeStdout(): NodeJS.WriteStream {
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

export async function runRemoteNodeMcpStdio(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const mcpStdout = seizeStdout()
  const args = readArguments(argv)
  const client = new RemoteNodeClient({
    url: args.url,
    clientName: args.clientName,
    credentials: new FileRemoteNodeCredentialStore(
      defaultRemoteNodeCredentialsPath(args.hostSlug),
    ),
    pairingCode: args.pairingCode,
  })
  const server = createRemoteNodeMcpServer({ client })

  // 节点判死(协议不符 / 未授权 / 被顶替)时退出而不是空转:MCP 客户端看到进程结束会给出
  // 明确的失败,而一个连不上却还在应答 tools/list 的空服务器只会让人以为"这台机器没工具"。
  client.onStopped((error) => {
    process.stderr.write(`velaros-remote-mcp: ${error.code} — ${error.message}\n`)
    process.exitCode = 1
    void server.close()
  })

  await server.connect(new StdioServerTransport(process.stdin, mcpStdout))
}
