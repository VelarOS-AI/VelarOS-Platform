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

import {
  createRemoteNodeClient,
  createRemoteNodeClientCredentialStore,
} from '@velaros-ai/kernel/remote'

import { readArguments, seizeStdout } from '../../utils/connectors/stdio-entry'

import { createRemoteNodeMcpServer } from './RemoteNodeMcpServer'

/**
 * `velaros-remote-mcp` 这个可执行入口本身:接命令行参数、建 remote-node 客户端、把它包成 MCP
 * 服务器,然后挂到进程的 stdin/stdout 上。
 *
 * 一个进程跑一次(文件末尾那个 `runRemoteNodeMcpStdio` 就是它的启动口)。启动时第一件事是夺走
 * stdout 只留给 MCP 传输,其余输出一律改道 stderr;节点被判死时设置 exitCode 并关闭服务器,
 * 而不是留一个连不上却还在应答 tools/list 的空壳。
 */
export interface RemoteNodeMcpStdioEntryApi {
  /**
   * 跑起这个入口。`argv` 缺省取 `process.argv.slice(2)`;参数不全（没有节点地址）直接抛错退出。
   * 返回的 Promise 在 MCP 传输接上后即完成——服务随后由传输层驱动,进程靠 stdin 关闭而结束。
   */
  run(argv?: readonly string[]): Promise<void>
}

class RemoteNodeMcpStdioEntry implements RemoteNodeMcpStdioEntryApi {
  public async run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const mcpStdout = seizeStdout()
    const args = readArguments(argv)
    const client = createRemoteNodeClient({
      url: args.url,
      clientName: args.clientName,
      credentials: createRemoteNodeClientCredentialStore({
        hostSlug: args.hostSlug,
      }),
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
}

/** 进程里唯一的一份 stdio 入口。 */
export const remoteNodeMcpStdioEntry: RemoteNodeMcpStdioEntryApi = new RemoteNodeMcpStdioEntry()

export function runRemoteNodeMcpStdio(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  return remoteNodeMcpStdioEntry.run(argv)
}
