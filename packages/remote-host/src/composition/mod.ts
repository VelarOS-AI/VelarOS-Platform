import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'

import {
  RemoteHostModId,
  RemoteHostToolCategoryId,
} from '../contracts.js'

export interface RemoteHostBundledModDefinition {
  readonly id: typeof RemoteHostModId
  readonly specifier: string
  readonly defaultEnabled: false
  readonly manifest: typeof RemoteHostAgentModManifest
  readonly bindings: {
    readonly toolCategories: Readonly<
      Record<typeof RemoteHostToolCategoryId, ToolCategoryDefinition>
    >
  }
  readonly ui: typeof RemoteHostModUi
}

/**
 * 设置面。
 *
 * 声明式四型字段(toggle / select / text / number)是设置轴的全部表达力,所以第一版只支持
 * **一台**远程主机:多台需要可增删的列表编辑器,那要走 T3 侧栏,不是设置页能表达的东西。
 *
 * 配对码刻意是普通 text 而不是密码框:它一次性、五分钟过期,且配对成功后连接就改用密钥签名,
 * 留在设置里既无用也无害;真正需要藏的私钥从来不经过这里(它在 safeStorage 里)。
 */
const RemoteHostModUi = Object.freeze({
  settings: {
    groups: [
      {
        id: 'remote-host',
        title: '远程能力节点',
        description:
          '把另一台机器接成能力节点。建议只填私有覆盖网(Tailscale / WireGuard)地址——'
          + '本传输在应用层做设备密钥认证,但不自建 TLS。',
        domain: 'extensions',
        fields: [
          {
            key: 'host.enabled',
            type: 'toggle',
            label: '启用远程主机',
            description: '关闭即断开连接并摘除全部远程工具。',
            default: false,
          },
          {
            key: 'host.label',
            type: 'text',
            label: '主机名称',
            description: '显示在工具描述里,模型据此分辨这条命令跑在哪台机器上。',
            default: 'windows-main',
          },
          {
            key: 'host.url',
            type: 'text',
            label: '节点地址',
            description: '目标机器上 `velaros serve` 打印的地址,形如 ws://…/v1/remote-node/ws。',
            default: '',
          },
          {
            key: 'host.pairingCode',
            type: 'text',
            label: '配对码(仅首次)',
            description: '目标机器控制页上的 6 位码。配对成功后可清空——之后走密钥签名。',
            default: '',
          },
        ],
      },
    ],
  },
})

const RemoteHostToolCategory = Object.freeze<ToolCategoryDefinition>({
  id: RemoteHostToolCategoryId,
  label: 'Remote host',
  description: '在已配对的另一台机器上执行的工具(跨机调用,不作用于本机)。',
  toolOs: { domain: 'remote-host', defaultState: 'loadable' },
})

const RemoteHostAgentModManifest = Object.freeze({
  id: RemoteHostModId,
  version: '0.1.0',
  publisher: 'VelarOS',
  displayName: 'VelarOS Remote Host',
  description: '把另一台机器接成能力节点:跨机执行命令、读写文件与操作桌面。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  /*
   * 只把 `toolCategories` 写进 requiredAxes。
   *
   * 本 mod **刻意不声明 `contributes.tools`**:远程工具面是连上节点之后才知道的,而且随对端
   * 配置变化。静态清单在这里是假的——写死一份必然与真实节点漂移,而 manifest 又是权威。
   * 所以类别由 manifest 声明(它是启停门与按类别把门判定的锚),实体工具由 mod 激活后的运行时
   * 动态投影进宿主注册面,停用即整批摘除。
   */
  requiredAxes: ['toolCategories'],
  contributes: {
    toolCategories: [
      {
        id: RemoteHostToolCategoryId,
        label: RemoteHostToolCategory.label,
        description: RemoteHostToolCategory.description,
        order: 70,
      },
    ],
  },
})

/**
 * 宿主中立的 bundled pack 载荷。产品壳拥有持久化与启停,本包拥有 manifest 与运行态绑定。
 *
 * `defaultEnabled: false` 是宪章 §16.3 的要求:默认不出现,启用才可见,停用净退场。
 */
export function createRemoteHostBundledModDefinition(): RemoteHostBundledModDefinition {
  return Object.freeze({
    id: RemoteHostModId,
    specifier: `bundled:${RemoteHostModId}`,
    defaultEnabled: false,
    manifest: RemoteHostAgentModManifest,
    bindings: Object.freeze({
      toolCategories: Object.freeze({
        [RemoteHostToolCategoryId]: RemoteHostToolCategory,
      }),
    }),
    ui: RemoteHostModUi,
  })
}
