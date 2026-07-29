import React, { memo, Suspense } from 'react'

import commandRegistration from './registrations/command.tool-render'
import fileChangeRegistration from './registrations/file-change.tool-render'
import goalRegistration from './registrations/goal.tool-render'
import planRegistration from './registrations/plan.tool-render'
import richOutputRegistrations from './registrations/rich-output.tool-render'
import systemToolInstallRegistration from './registrations/system-tool-install.tool-render'
import widgetRegistration from './registrations/widget.tool-render'
import { DefaultToolRender } from './DefaultToolRender.section'
import {
  type ToolRendererRegistry,
  type ToolRenderRegistration,
  ToolRenderRegistry,
} from './ToolRenderRegistry'

import type { ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isArray } from '#internal/runtime'

export interface ToolCallBlockProps {
  block: ToolCallBlockType
  compact?: boolean
  sessionId?: string
  planUpdateIndex?: number
  formatPathForDisplay?: (path: string) => string
  /** Optional application-owned registry. Defaults to the bundled shared registry. */
  registry?: ToolRendererRegistry
}

// 显式静态注册表——替代 Vite `import.meta.glob`（本包由 tsc 构建，glob 不可用）。行为保序：
// 与原 glob 扫描 `./registrations/*.tool-render.tsx` 等价，每个工具名唯一，注册顺序不影响路由。
// PERF GUARD:registration 内的实际 renderer 仍在 React.lazy 之后——静态导入注册元数据不会
// 预加载 command/artifact/widget 等 renderer 本体，任意 tool-call 消息只在命中对应工具时才拉取实现。
// （widget 随 pass-2 htmlPreview/artifacts 入包后并入本静态表，宿主追加注册链路退役。）
const bundledToolRenderRegistrations: Array<ToolRenderRegistration | ToolRenderRegistration[]> = [
  commandRegistration,
  fileChangeRegistration,
  goalRegistration,
  planRegistration,
  richOutputRegistrations,
  systemToolInstallRegistration,
  widgetRegistration,
]

bundledToolRenderRegistrations
  .flatMap((registration) => (isArray(registration) ? registration : [registration]))
  .forEach((registration) => {
    ToolRenderRegistry.registerRegistration(registration)
  })

// 注册默认 fallback
ToolRenderRegistry.setFallback(DefaultToolRender)

/**
 * ToolCallBlock — 工具调用渲染入口
 *
 * 优先使用 ToolRenderRegistry 中注册的专属组件，
 * 未注册时回退到 DefaultToolRender（通用 JSON 展示）
 */
export const ToolCallBlock = memo(
  ({
    block,
    compact = false,
    sessionId,
    planUpdateIndex,
    formatPathForDisplay,
    registry = ToolRenderRegistry,
  }: ToolCallBlockProps): React.ReactElement => {
    const CustomRender = registry.get(block.toolName)
    if (CustomRender && CustomRender !== DefaultToolRender) return (
        <Suspense
          fallback={
            <DefaultToolRender
              block={block}
              compact={compact}
              sessionId={sessionId}
              formatPathForDisplay={formatPathForDisplay}
            />
          }
        >
          <CustomRender
            block={block}
            compact={compact}
            sessionId={sessionId}
            planUpdateIndex={planUpdateIndex}
            formatPathForDisplay={formatPathForDisplay}
          />
        </Suspense>
      )
    return (
      <DefaultToolRender
        block={block}
        compact={compact}
        sessionId={sessionId}
        formatPathForDisplay={formatPathForDisplay}
      />
    )
  }
)

ToolCallBlock.displayName = 'ToolCallBlock'
