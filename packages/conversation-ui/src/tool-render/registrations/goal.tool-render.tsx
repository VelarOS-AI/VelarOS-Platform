import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'
import { GoalToolNames } from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描，实际 renderer 必须保留在 React.lazy 后面。
const LazyGoalToolRender = lazy(async () =>
  import('../goal/GoalToolRender').then((module) => ({
    default: module.GoalToolRender,
  }))
)

const registration: ToolRenderRegistration = {
  toolNames: GoalToolNames,
  component: LazyGoalToolRender,
}

export default registration
