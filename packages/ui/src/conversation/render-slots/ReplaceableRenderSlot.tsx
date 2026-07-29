import type { ReactElement } from 'react'

import { RenderErrorBoundary } from '@velaros-ai/ui/primitives/display/RenderErrorBoundary'

/**
 * **替换槽**的渲染包装：注入件住错误边界里，任何失败方向都收敛到同一个官方 `fallback`。
 *
 * 增强槽（缺席 = 那张卡不显示）不需要它——本组件是给「替换掉产品核心件」的槽用的：那类槽失败时
 * 空白掉的是消息正文，所以失败方向必须是**官方实现**，而不是「什么都不画」。三条路径同一个出口：
 *  - 注入件返回 `null`（声明「本次不替换」）；
 *  - 注入件 render / 生命周期抛错（错误边界捕获）；
 *  - 槽位压根没注入（调用点判 `undefined`，不进本组件）。
 *
 * `fallback` 收的是**已构造好的官方元素**而不是构造函数：React 元素创建是纯对象构造，官方件即便是
 * `lazy()` 也只在真正被渲染时才拉分包——替换件正常工作时官方分包不会被拉起。
 *
 * 刻意**不给 `resetKeys`**：正文流式期每帧换 `text`，自动重试会把一次崩溃放大成每帧一次的重试风暴
 * （`RenderErrorBoundary` 自身注释里的同一条理由）。崩溃后该块整个挂载生命周期钉在官方件上，
 * 下一条消息挂新边界自然重试。
 */
export function ReplaceableRenderSlot<TProps>({
  scope,
  render,
  props,
  fallback,
}: {
  /** 错误日志里的边界标识（如 `conversation.message.markdown`）。 */
  scope: string
  render: (props: TProps) => Nullable<ReactElement>
  props: TProps
  /** 官方内置件（已构造的元素）；替换件缺席 / 弃权 / 崩溃时渲染它。 */
  fallback: ReactElement
}): ReactElement {
  return (
    <RenderErrorBoundary scope={scope} fallback={() => fallback}>
      <ReplaceableRenderSlotContent render={render} props={props} fallback={fallback} />
    </RenderErrorBoundary>
  )
}

/**
 * 注入件的调用点必须是**边界的子组件**：在父组件里直接调 `render(props)` 的话，同步抛错发生在边界
 * 之外，`RenderErrorBoundary` 抓不到。
 */
function ReplaceableRenderSlotContent<TProps>({
  render,
  props,
  fallback,
}: {
  render: (props: TProps) => Nullable<ReactElement>
  props: TProps
  fallback: ReactElement
}): ReactElement {
  return render(props) ?? fallback
}
