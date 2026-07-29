import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.businessCandidates,
  entryOrder: 33,
  entry: {
    id: 'workspace-space-icon',
    name: 'Workspace Space Icon',
    layer: 'Business',
    status: 'ready',
    domain: 'Workspace',
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/product/display/WorkspaceSpaceIcon',
    usage:
      '把空间 descriptor 声明的图标语义名 iconName 映射为具体图标资产，跨会话切换器 / 侧边栏 / 定时任务 / 归档页等复用。',
    avoid:
      '不要在库内认识产品空间枚举、也不要再造一份「空间 → 图标名」映射（宿主查 descriptor.iconName 后递入）；不要在库内直依产品品牌资产，browser 图标名的品牌资产经 renderBrowserIcon 端口由宿主注入。',
    examples: [],
    apiComponents: ['WorkspaceSpaceIcon'],
  },
})
