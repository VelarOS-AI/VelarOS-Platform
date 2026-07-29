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
      '把 WorkspaceSpaceKind 映射为固定图标的单一来源，跨会话切换器 / 侧边栏 / 定时任务 / 归档页等复用。',
    avoid:
      '不要在库内直依产品品牌资产；browser 分类的品牌图标经 renderBrowserIcon 端口由宿主注入。',
    examples: [],
    apiComponents: ['WorkspaceSpaceIcon'],
  },
})
