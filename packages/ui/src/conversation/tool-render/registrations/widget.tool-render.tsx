import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'
import { WidgetRenderToolNames } from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描；HtmlPreviewFrame/sandbox 尤其不能静态导入。
const LazyWidgetToolRender = lazy(async () =>
  import('../widget/WidgetToolRender').then((module) => ({
    default: module.WidgetToolRender,
  }))
)

const registration: ToolRenderRegistration = {
  toolNames: WidgetRenderToolNames,
  component: LazyWidgetToolRender,
}

export default registration
