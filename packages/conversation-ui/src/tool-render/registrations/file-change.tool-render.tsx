import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'
import { FileChangeToolNames } from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描，实际 renderer 必须保留在 React.lazy 后面。
const LazyFileChangeToolRender = lazy(async () =>
  import('../fileChange/FileChangeToolRender').then((module) => ({
    default: module.FileChangeToolRender,
  }))
)

const registration: ToolRenderRegistration = {
  toolNames: FileChangeToolNames,
  component: LazyFileChangeToolRender,
}

export default registration
