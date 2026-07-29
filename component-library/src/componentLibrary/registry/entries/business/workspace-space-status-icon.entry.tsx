import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 34,
  entry: {
    id: 'workspace-space-status-icon',
    name: 'Workspace Space Status Icon',
    layer: 'Business',
    status: 'ready',
    domain: 'Workspace',
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/product/display/WorkspaceSpaceStatusIcon',
    usage:
      '在 WorkspaceSpaceIcon 外裹执行态色调（default / running / paused），侧边栏会话行 / 定时任务列表复用。',
    avoid:
      '不要在库内认识产品空间枚举（iconName 由宿主查 descriptor 后递入，透传给 WorkspaceSpaceIcon）；不要在库内直依产品品牌资产，browser 图标名的品牌资产经 renderBrowserIcon 端口由宿主注入。',
    examples: [],
    apiComponents: ['WorkspaceSpaceStatusIcon'],
  },
})
