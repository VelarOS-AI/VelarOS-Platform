import { type ReactElement } from 'react'

import { useConversationI18n } from '../i18n'

import { ChatInput, type ChatInputChromeControl, type ChatInputControl } from './ChatInput'
import type { ModelSelectOption } from './chatInputTypes'
import {
  type ChatComposerCapabilityControl,
  ComposerCapabilityControls,
} from './ComposerCapabilityControls'
import { ComposerModelRunSelector } from './ComposerModelRunSelector'

export interface ChatComposerProviderModelSelectOption {
  value: string
  label: string
  description?: string
  defaultModel: string
  models: ModelSelectOption[]
}

export interface ChatComposerModelSelectorControl {
  /** 菜单里这一段的段头文案；不传时用包内的「模型」。 */
  label: string
  /**
   * 段头旁的说明气泡（外部执行体自报「这份目录是谁给的」时传）。
   *
   * 不传就不渲染气泡：**不替它编一句包内文案**——目录来源是宿主/执行体的事实，包内猜一句
   * 会把「引擎自报的模型」说成 Velar 自己的模型。
   */
  hint?: string
  /** 仅用于界面目录的身份；不要求它是已注册的 API Provider。 */
  provider: string
  model: string
  providers: ChatComposerProviderModelSelectOption[]
  disabled?: boolean
  onChange: (provider: string, model: string) => void
}

/**
 * 模型/运行档摘要按钮的文案覆盖 —— **传了就统管两格**。
 *
 * 判据一：这颗按钮在没有 `modelSelector` 时回落包内的「选择模型 / 自动」，而外部执行体会话里
 * 「选择模型」是一句做不到的承诺——目录问不到时用户一格都选不了。宿主此时传一份如实的摘要
 * （执行体名 + 目录为什么没有），包内不再替它编。
 *
 * 判据二（为什么两格必须一起交出去）：两格各自回落时，宿主没有任何办法表达「这两个轴现在说的
 * 是同一件事」。真机形态：模型轴与推理档轴双双处于「跟随引擎设置」，包内一格拼成
 * 「Codex / 跟随 Codex 设置」、另一格再画一遍「跟随 Codex 设置」，同一句话连出现两次。
 * 现在由宿主一次算出两格：模型轴显式选过才把型号拼进主标签，否则主标签只有执行体名，
 * 「跟随……」这句话只在运行档那一格出现一次。
 *
 * `secondaryLabel` 缺席 = **这一格不渲染**（不是「回落到某个默认档」）：外部执行体没有 Velar
 * 的「自动」这个概念，硬填一个词就是又一次「界面说了引擎没读的话」。
 *
 * 不传整个 summary 即保持原回落，Velar 会话零变化。
 */
export interface ChatComposerModelRunSummary {
  primaryLabel: string
  secondaryLabel?: string
}

/**
 * 厂商动态推理档位。档位 ID 与显示文案都由适配器提供，Composer 只负责统一渲染。
 */
export interface ChatComposerReasoningControl {
  label: string
  hint: string
  value: string
  summaryLabel?: string
  options: Array<{
    value: string
    label: string
    description?: string
  }>
  disabled?: boolean
  onChange: (value: string) => void
}

/** 与聊天输入控制形态一致，但外壳控制由聊天组合器控制合入。 */
export type ChatComposerInputControl = Omit<ChatInputControl, 'chrome'> & {
  chrome?: Pick<ChatInputChromeControl, 'hideSubmit' | 'submitSlot' | 'beforeInput' | 'afterInput'>
}

export interface ChatComposerSlots {
  beforeInput?: React.ReactNode
  afterInput?: React.ReactNode
  toolbarLeading?: React.ReactNode
  toolbarTrailing?: React.ReactNode
  footer?: React.ReactNode
  /**
   * 上下文用量指示器插槽（宿主注入 `ChatContextUsageIndicator`）。该指示器读会话运行态（宿主耦合），
   * 故由宿主经插槽提供，包内壳只负责在工具条右侧固定位放置。
   */
  contextUsageIndicator?: React.ReactNode
}

export interface ChatComposerControl {
  scopeKey?: string
  input: ChatComposerInputControl
  modelSelector?: ChatComposerModelSelectorControl
  /** 摘要按钮文案覆盖；只在宿主能给出比包内回落更真的一份时传。 */
  modelRunSummary?: ChatComposerModelRunSummary
  reasoning?: ChatComposerReasoningControl
  leftSlot?: React.ReactNode
  rightSlot?: React.ReactNode
  bottomSlot?: React.ReactNode
  /** 厂商无关的官网能力声明；仅专用工作区注入，现有工作区默认不传。 */
  capabilityControls?: ChatComposerCapabilityControl[]
  /** 结构化 UI 插槽；旧 left/right/bottomSlot 继续兼容。 */
  slots?: ChatComposerSlots
}

interface ChatComposerProps {
  control: ChatComposerControl
  density?: 'default' | 'compact'
}

export function ChatComposer({ control, density = 'default' }: ChatComposerProps): ReactElement {
  const { t } = useConversationI18n()
  const {
    input,
    modelSelector,
    modelRunSummary,
    reasoning,
    leftSlot,
    rightSlot,
    bottomSlot,
    capabilityControls = [],
    slots,
  } = control

  const combinedModelRunSelectorAction = !!(
    modelSelector ||
    reasoning ||
    input.runProfile ||
    input.thinkingDepth ||
    input.thinkingVisibility ||
    input.pureChat
  ) && (
    <ComposerModelRunSelector
      t={t}
      modelSelector={modelSelector}
      modelRunSummary={modelRunSummary}
      reasoning={reasoning}
      runProfile={input.runProfile}
      thinkingDepth={input.thinkingDepth}
      thinkingVisibility={input.thinkingVisibility}
      pureChat={input.pureChat}
      capabilityControls={capabilityControls}
      density={density}
    />
  )

  const chatInputControl: ChatInputControl = {
    ...input,
    chrome: {
      ...input.chrome,
      leftActions: (
        <>
          {combinedModelRunSelectorAction}
          <ComposerCapabilityControls
            controls={capabilityControls}
            placement="toolbar"
            disabled={input.input.disabled}
          />
          {slots?.toolbarLeading}
          {leftSlot}
        </>
      ),
      rightActions: (
        <>
          {rightSlot}
          {slots?.toolbarTrailing}
          {slots?.contextUsageIndicator}
        </>
      ),
      beforeInput: slots?.beforeInput ?? input.chrome?.beforeInput,
      afterInput: slots?.afterInput ?? input.chrome?.afterInput,
      bottomSlot: slots?.footer ?? bottomSlot,
      menuCapabilityControls: capabilityControls.filter(
        (capability) => capability.placement === 'add-menu'
      ),
    },
  }

  return <ChatInput key={control.scopeKey} density={density} control={chatInputControl} />
}
