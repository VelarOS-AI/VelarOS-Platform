/**
 * 交互建议卡（AI 引导选项气泡）。
 *
 * 样式：`.velar-action-card-flat` · 见 styles/components/。
 */
import { type ComponentProps, type ReactElement, type ReactNode } from 'react'

import { cn } from '../../lib/cn'

import { ActionCard } from './ActionCard'

export type InteractionSuggestionCardProps = ComponentProps<typeof ActionCard>

/**
 * 对话内 ActionCard 建议卡（工具安装、工作区切换、记忆保存等）的统一壳层。
 * 保持 `.velar-action-card-flat` 与 ActionCard 默认布局一致。
 *
 * 形态债（§12.9，组件形态封闭）：本壳层经 `ComponentProps<typeof ActionCard>` 继承
 * ActionCard 的完整 DOM-prop 展开面（图鉴登记的 "unbounded DOM-prop surface"）——
 * 这是未收敛的通用逃生口，收敛归组件库形态封闭波，不在本批处理；此处仅登记，不改行为。
 */
export function InteractionSuggestionCard({
  className,
  ...props
}: InteractionSuggestionCardProps): ReactElement {
  return <ActionCard className={cn('velar-action-card-flat', className)} {...props} />
}

export type InteractionSuggestionActionsProps = {
  children: ReactNode
}

/** 建议卡操作区容器（语义别名，便于组件库文档）。 */
export function InteractionSuggestionActions({
  children,
}: InteractionSuggestionActionsProps): ReactElement {
  return <>{children}</>
}
