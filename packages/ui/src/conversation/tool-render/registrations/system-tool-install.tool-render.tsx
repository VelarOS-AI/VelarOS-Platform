import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'
import { SystemToolInstallToolNames } from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描，实际 renderer 必须保留在 React.lazy 后面。
const LazySystemToolInstallToolRender = lazy(async () =>
  import('../systemToolInstall/SystemToolInstallToolRender').then((module) => ({
    default: module.SystemToolInstallToolRender,
  }))
)

const registration: ToolRenderRegistration = {
  toolNames: SystemToolInstallToolNames,
  component: LazySystemToolInstallToolRender,
}

export default registration
