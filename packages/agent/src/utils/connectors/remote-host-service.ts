// RemoteHostService 用到的纯函数（不碰实例状态）。
import type { RemoteNodeClientApi } from '@velaros-ai/kernel'

import type { RemoteHostToolInvoker } from '../../types/connectors.js'

/** 把远端节点客户端包成远程工具的调用口：只透传能力 id、操作名与入参。 */
export function createInvoker(client: RemoteNodeClientApi): RemoteHostToolInvoker {
  return {
    invoke: (descriptor, input, signal) =>
      client.invoke(
        {
          capabilityId: descriptor.capabilityId,
          operation: descriptor.operation,
          input,
        },
        signal,
      ),
  }
}

/**
 * 生成跨机唯一的 canonical 工具名。
 *
 * 形状对齐 MCP 的 `mcp.<server>:<tool>`：注册表要求 `namespace:tool`，且 namespace 允许点号。
 * 节点侧的名字可能自带冒号（如 `provider:operation`），必须压平，否则拼出来的是非法 id。
 */
export function buildRemoteToolName(hostId: string, toolName: string): string {
  const namespace = slugify(hostId)
  const tool = toolName.toLowerCase().replaceAll(/[^a-z\d_-]/gu, '_')
  return `remote.${namespace}:${tool.replace(/^[^a-z]+/u, '')}`
}

/** 把远端主机名压成只含小写字母、数字与连字符的标识；压干净后为空就退回 host。 */
export function slugify(value: string): string {
  const slug = value.toLowerCase().replaceAll(/[^a-z\d-]/gu, '-')
  return slug.replace(/^[^a-z]+/u, '') || 'host'
}
