import { lazy } from 'react'

import { hasConsoleSession } from '../console/consoleToolRenderModel'
import type { ToolRenderComponent, ToolRenderRegistration } from '../ToolRenderRegistry'
import { CommandToolNames } from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描，实际 renderer 必须保留在 React.lazy 后面。
const LazyCommandToolRender = lazy(async () =>
  import('../command/CommandToolRender').then((module) => ({
    default: module.CommandToolRender,
  }))
)

const LazyConsoleToolRender = lazy(async () =>
  import('../console/ConsoleToolRender').then((module) => ({
    default: module.ConsoleToolRender,
  }))
)

// 同一个工具名两张卡：结果里带控制台（system:run 的 interactive）的用控制台卡，其余仍是命令卡。
// 判定只读结果里的一个字段，是个纯函数，留在 lazy 外面不会把两个 renderer 本体拉进来。
const CommandOrConsoleToolRender: ToolRenderComponent = (props) =>
  hasConsoleSession(props.block.result) ? (
    <LazyConsoleToolRender {...props} />
  ) : (
    <LazyCommandToolRender {...props} />
  )

const registration: ToolRenderRegistration = {
  toolNames: CommandToolNames,
  component: CommandOrConsoleToolRender,
}

export default registration
