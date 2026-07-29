import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'
import { CommandToolNames } from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描，实际 renderer 必须保留在 React.lazy 后面。
const LazyCommandToolRender = lazy(async () =>
  import('../command/CommandToolRender').then((module) => ({
    default: module.CommandToolRender,
  }))
)

const registration: ToolRenderRegistration = {
  toolNames: CommandToolNames,
  component: LazyCommandToolRender,
}

export default registration
