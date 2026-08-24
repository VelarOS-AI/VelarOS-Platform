import { type ReactElement } from 'react'

import {
  ChatComposer,
  type ChatComposerControl,
  type ChatComposerDensity,
} from './ChatComposer'

export type ChatSurfaceVariant = 'default' | 'side'

export interface ChatSurfaceComposerProps {
  control: ChatComposerControl
  /** 会话表面的布局形态；侧栏形态由组件库统一使用紧凑输入框。 */
  variant?: ChatSurfaceVariant
  /** 仅供不遵循表面默认策略的专用宿主显式覆盖。 */
  density?: ChatComposerDensity
}

export function resolveChatSurfaceComposerDensity({
  variant = 'default',
  density,
}: Pick<ChatSurfaceComposerProps, 'variant' | 'density'>): ChatComposerDensity {
  return density ?? (variant === 'side' ? 'compact' : 'default')
}

/**
 * 会话表面的共享输入框入口。
 *
 * 宿主只投影输入值、模型和执行动作；输入框采用几行、菜单密度等呈现行为由 Platform 按表面形态
 * 统一决定，避免 Desktop 与 Workbench 各自维护一套条件判断。
 */
export function ChatSurfaceComposer({
  control,
  variant = 'default',
  density,
}: ChatSurfaceComposerProps): ReactElement {
  return (
    <ChatComposer
      control={control}
      density={resolveChatSurfaceComposerDensity({ variant, density })}
    />
  )
}
