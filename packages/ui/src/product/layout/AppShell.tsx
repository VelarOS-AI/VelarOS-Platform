/**
 * 应用外壳布局：侧边栏 + 主区。
 *
 * 样式：`.velar-app-shell` · 见 styles/components/。
 */
import React, { memo } from 'react'

import { cn } from '@velaros-ai/ui/lib/cn'

interface AppShellProps {
  sidebar: React.ReactNode
  header?: React.ReactNode
  sidebarCollapsed?: boolean
  children: React.ReactNode
  /**
   * 为 true 时不使用 100vh，便于嵌入 Story/组件库外层定高容器。
   * 父级需要通过样式或类名提供明确高度。
   */
  embedded?: boolean
  /** 合并到根节点上，例如在嵌入和预览场景中限制高度。 */
  className?: string
}

export const AppShell = memo(
  ({
    sidebar,
    header,
    sidebarCollapsed = false,
    children,
    embedded = false,
    className,
  }: AppShellProps): React.ReactElement => (
    <div
      className={cn('velar-app-shell', embedded && 'velar-app-shell-root-embedded', className)}
    >
      {sidebar}
      <main
        className={cn(
          'velar-app-shell-main',
          sidebarCollapsed ? 'velar-app-shell-collapsed' : 'velar-app-shell-expanded'
        )}
      >
        {header}
        <section className="velar-app-shell-content">{children}</section>
      </main>
    </div>
  )
)

AppShell.displayName = 'AppShell'
