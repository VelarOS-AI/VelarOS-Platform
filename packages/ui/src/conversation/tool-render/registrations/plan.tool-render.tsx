import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'
import { PlanToolNames } from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描，实际 renderer 必须保留在 React.lazy 后面。
const LazyPlanToolRender = lazy(async () =>
  import('../plan/PlanToolRender').then((module) => ({
    default: module.PlanToolRender,
  }))
)

const registration: ToolRenderRegistration = {
  toolNames: PlanToolNames,
  component: LazyPlanToolRender,
}

export default registration
