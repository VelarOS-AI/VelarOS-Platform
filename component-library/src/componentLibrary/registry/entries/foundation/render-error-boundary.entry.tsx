import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 44,
  entry: {
    id: 'render-error-boundary',
    name: 'Render Error Boundary',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui',
    origin: 'packages/ui/src/primitives/display/RenderErrorBoundary',
    usage:
      '通用 React 渲染错误边界：捕获子树异常降级为宿主 fallback；resetKeys 变化自动重试；scope 用于日志。',
    avoid:
      '不要在库内承载具体恢复策略；陈旧模块硬刷新等自愈经 selfHeal 端口（onCaughtError / isRecoverableExternally）由宿主注入。',
    examples: [],
    apiComponents: ['RenderErrorBoundary'],
  },
})
