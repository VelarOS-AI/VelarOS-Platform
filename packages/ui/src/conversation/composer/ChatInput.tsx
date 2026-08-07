import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowsDownUpIcon, ArrowUpIcon } from '@phosphor-icons/react'
import { useLatest } from 'ahooks'

import { StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'
import { ImagePreviewDialog } from '@velaros-ai/ui/primitives/overlays/ImagePreviewDialog'

import { useConversationI18n } from '../i18n'
import { useAutoFocus } from '../react-hooks/useAutoFocus'
import { useAutoResize } from '../react-hooks/useAutoResize'
import { useImagePreviewDialogMessages } from '../react-hooks/useImagePreviewDialogMessages'
import { useObjectUrls } from '../react-hooks/useObjectUrl'
import { useTimerScope } from '../react-hooks/useTimerScope'

import { buildChatInputComposerAddMenuProps } from './hooks/buildChatInputComposerAddMenuProps'
import {
  isNextStepSuggestionExactMatch,
  matchNextStepSuggestionPrefix,
  resolveInlineNextStepSuggestionIndex,
  resolveInlineNextStepSuggestionKeyboardAction,
} from './hooks/nextStepSuggestionCompletion.pure'
import {
  type ChatInputVoiceInsertBridge,
  useChatInputDraftActions,
} from './hooks/useChatInputDraftActions'
import { useChatInputFileAttachments } from './hooks/useChatInputFileAttachments'
import { useChatInputInsertDraftBridge } from './hooks/useChatInputInsertDraftBridge'
import { useChatInputPromptFeatureActivationBridge } from './hooks/useChatInputPromptFeatureActivationBridge'
import { useChatInputVoiceRecognition } from './hooks/useChatInputVoiceRecognition'
import { useComposerAddMenuState } from './hooks/useComposerAddMenuState'
import { useComposerMentionMenu } from './hooks/useComposerMentionMenu'
import { useComposerPromptFeatures } from './hooks/useComposerPromptFeatures'
import { useComposerSkillSelection } from './hooks/useComposerSkillSelection'
import { useComposerSlashSkillMenu } from './hooks/useComposerSlashSkillMenu'
import {
  ChatComposerInputMaxChars,
  ChatComposerInputWarningChars,
  type ChatComposerLimitViolation,
  clampChatComposerInput,
  formatChatComposerLimitViolation,
} from './utils/chatComposerLimits'
import {
  createVirtualPasteReference,
  shouldVirtualizePastedText,
} from './utils/chatVirtualPasteReferences'
import { ChatInputActionRow } from './ChatInputActionRow'
import { ChatInputCore } from './ChatInputCore'
import { ChatInputFunctionBar } from './ChatInputFunctionBar'
import {
  resolveChatInputInteractionState,
  resolveChatInputPrimaryActionState,
  resolveChatInputPrimaryActionStopHandler,
} from './chatInputInteractionState.pure'
import { ChatInputQueuePanel } from './ChatInputQueuePanel'
import type {
  ChatInputManualTestPromptOption,
  ChatInputMentionableOption,
  ChatInputMentionables,
  ChatInputPureChatControl,
  ChatInputQueuedDraft,
  ChatInputRunProfileControl,
  ChatInputSelectionRange,
  ChatInputSendDraft,
  ChatInputSkillDetailHandler,
  ChatInputSkillOption,
  ChatInputThinkingDepthControl,
  ChatInputThinkingVisibilityControl,
  ChatVirtualPasteReference,
} from './chatInputTypes'
import { formatChatInputFileSize, hasDraggedFiles } from './chatInputUtils'
import type { ChatComposerCapabilityControl } from './ComposerCapabilityControls'
import { ComposerDropOverlay } from './ComposerDropOverlay'
import { ComposerFilePreview } from './ComposerFilePreview'
import { ComposerMentionMenu } from './ComposerMentionMenu'
// 下一步建议的**面板**形态（`ComposerNextStepSuggestionMenu`）已于 2026-08-06 退役：它压在输入框
// 正上方、一次铺开三条整句，把对话最后几行挡掉，用户判「太重」。改为写进输入框本身的内联建议
// （幽灵文本 + ↑↓ 切换），组件与样式原样留在包里待回滚，只是不再有人渲染它。
import { ComposerSlashSkillMenu } from './ComposerSlashSkillMenu'
import { ComposerToolbarLeading } from './ComposerToolbarLeading'
import { ComposerToolbarRight } from './ComposerToolbarRight'
import { ComposerVirtualPastePreview } from './ComposerVirtualPastePreview'
import { useConversationComposerPort } from './conversationComposerPort'

import styles from './ChatInput.module.css'

import type {
  BrowserElementSelection,
  ChatPromptFeatureId,
  ChatSuggestionItem,
  TurnContextDelta,
} from '#contracts'
import { isEmpty,isPresent, optionalWhenLazy } from '#internal/runtime'

function isOnboardingComposerSendLocked(): boolean {
  return document.documentElement.dataset.tourComposerSendLocked === 'true'
}

export interface ChatInputFieldControl {
  value: string
  selection?: LooseOptional<ChatInputSelectionRange>
  placeholder?: string
  suggestion?: ChatInputSuggestionControl
  disabled?: boolean
  onValueChange: (value: string) => void
  onSelectionChange?: (selection: ChatInputSelectionRange) => void
  virtualPasteReferences?: ChatVirtualPasteReference[]
  onVirtualPasteReferencesChange?: (references: ChatVirtualPasteReference[]) => void
  onSend: (draft?: ChatInputSendDraft) => void | Promise<void>
}

export interface ChatInputSuggestionControl {
  /** 单轮完成后的候选提示词；空输入时全部展示，输入后按前缀过滤。 */
  options?: ChatSuggestionItem[]
  selectedId?: LooseOptional<string>
  onSelect?: (id: string) => void
}

export interface ChatInputAttachmentsControl {
  files: File[]
  onFilesChange?: (files: File[]) => void
  onOpenFile?: (file: File) => void | Promise<void>
}

export interface ChatInputQueueControl {
  queuedDrafts?: ChatInputQueuedDraft[]
  isQueueDraining?: boolean
  onQueuedDraftMove?: (id: string, direction: 'up' | 'down') => void
  onQueuedDraftRemove?: (id: string) => void
  onQueuedDraftUpdate?: (id: string, value: string) => void
  onQueuedDraftGuide?: (id: string) => void | Promise<void>
  onQueuedDraftReturnToInput?: (id: string) => void
  onQueuedDraftRunNow?: (id: string) => void | Promise<void>
}

/** 目标模式开关的文案（外部执行体自报其原生机制时传；不传则用包内的「目标模式」）。 */
export interface ChatInputGoalModeCopy {
  label: string
  hint: string
}

/**
 * 执行模式控制组（目标 / 计划）。
 *
 * 与 {@link ChatInputFeaturesControl} 的 `promptFeatures` 正交：那一组回答「哪些能力开着」，
 * 这一组回答「这一轮按什么执行姿态跑」。2026-08-06 拆轴前 plan 挤在 promptFeatures 数组里，
 * goal 却已经在这里——同一个概念两种形态，输入区因此得同时读两处才知道当前是什么模式。
 */
export interface ChatInputExecutionControl {
  goalMode?: boolean
  onGoalModeChange?: (enabled: boolean) => void
  /** 计划模式开关（原 `promptFeatures` 里的 `plan`）。 */
  planMode?: boolean
  onPlanModeChange?: (enabled: boolean) => void
  /**
   * 开关的显示文案覆盖。
   *
   * 判据：外部执行体的「目标模式」是它自己的原生档（Claude Code 的 plan / Codex 的 thread goal，
   * 两家本轮都只读），与 Velar 的「持续推进直到目标完成」语义相反。包内文案只描述 Velar 的机制，
   * 所以由声明方给文案，包内**不替它编**——渲染错的那句比不渲染坏得多。
   */
  goalModeCopy?: ChatInputGoalModeCopy
}

export interface ChatInputFeaturesControl {
  /**
   * 当前工作区不可用的提示特性集合（宿主边界派生：空间不支持的特性 ∪ 未装插件的能力，如未装 computeruse 时的
   * computer-use）。包内壳不透传原始 `WorkspaceSpaceKind` 枚举、不读插件可用性快照——宿主算好能力位传入。
   */
  unavailablePromptFeatures?: ChatPromptFeatureId[]
  /** 应用资源插件可用性是否已解析完成（未解析前不据此隐藏特性，避免闪烁）。 */
  resourceAvailabilityResolved?: boolean
  /** 本地 whisper 语音转写插件是否可用（决定走本地转写还是浏览器语音识别）。 */
  localWhisperAvailable?: boolean
  browserElementSelections?: BrowserElementSelection[]
  /** 环境回合上下文待附加 delta（已减 dismissed）；chips 可删，发送时冻结。 */
  turnContextDeltas?: TurnContextDelta[]
  /** Workbench 当前可见文件的轻索引；只展示一枚，切换时原位替换。 */
  workbenchCurrentFilePath?: string
  onDismissTurnContextDelta?: (id: string) => void
  lockedPromptFeatures?: ChatPromptFeatureId[]
  promptFeatures?: ChatPromptFeatureId[]
  onRemoveBrowserElementSelection?: (id: string) => void
  onPromptFeaturesChange?: (features: ChatPromptFeatureId[]) => void
  availableSkills?: ChatInputSkillOption[]
  selectedSkillIds?: string[]
  onOpenSkillDetail?: ChatInputSkillDetailHandler
  onSelectedSkillIdsChange?: (skillIds: string[]) => void
  mentionables?: ChatInputMentionables
  manualTestPrompts?: ChatInputManualTestPromptOption[]
  quickPrompts?: ChatInputManualTestPromptOption[]
  /** 仅 Workbench 注入：在 + 菜单显示 AI 编辑器控制开关。 */
  workbenchEditorControlAvailable?: boolean
}

export interface ChatInputChromeControl {
  leftActions?: React.ReactNode
  rightActions?: React.ReactNode
  submitSlot?: React.ReactNode
  bottomSlot?: React.ReactNode
  beforeInput?: React.ReactNode
  afterInput?: React.ReactNode
  /** 注入既有“+”菜单的通用能力；不传时保持原菜单结构。 */
  menuCapabilityControls?: readonly ChatComposerCapabilityControl[]
  hideSubmit?: boolean
}

export interface ChatInputStreamingControl {
  isStreaming?: boolean
  canStop?: boolean
  onStop?: () => void | Promise<void>
}

export interface ChatInputControl {
  input: ChatInputFieldControl
  attachments: ChatInputAttachmentsControl
  queue?: ChatInputQueueControl
  execution?: ChatInputExecutionControl
  runProfile?: ChatInputRunProfileControl
  thinkingDepth?: ChatInputThinkingDepthControl
  thinkingVisibility?: ChatInputThinkingVisibilityControl
  pureChat?: ChatInputPureChatControl
  features?: ChatInputFeaturesControl
  chrome?: ChatInputChromeControl
  streaming?: ChatInputStreamingControl
}

interface ChatInputProps {
  control: ChatInputControl
  density?: 'default' | 'compact'
}

export type {
  ChatInputManualTestPromptOption,
  ChatInputQueuedDraft,
  ChatInputSendDraft,
  ChatInputSkillOption,
} from './chatInputTypes'

const cx = StyleUtils.bindCx(styles)
const EmptyQueuedDrafts: ChatInputQueuedDraft[] = []
const EmptyBrowserElementSelections: BrowserElementSelection[] = []
const EmptyTurnContextDeltas: TurnContextDelta[] = []
const EmptyPromptFeatures: ChatPromptFeatureId[] = []
const EmptyUnavailablePromptFeatures = new Set<ChatPromptFeatureId>()
const EmptyAvailableSkills: ChatInputSkillOption[] = []
const EmptySelectedSkillIds: string[] = []
const EmptyMentionables: ChatInputMentionableOption[] = []
const EmptySelectedMentionIds: string[] = []
const EmptyManualTestPrompts: ChatInputManualTestPromptOption[] = []
const EmptyFollowUpSuggestions: ChatSuggestionItem[] = []
const EmptyVirtualPasteReferences: ChatVirtualPasteReference[] = []
const EmptyCapabilityControls: ChatComposerCapabilityControl[] = []

function markFirstChatComposerCommit(): void {
  const performance = globalThis.performance
  if (!performance || performance.getEntriesByName('velaros:chat-composer:committed').length > 0)
    return

  performance.mark('velaros:chat-composer:committed')
}

function clampChatInputSelection(
  selection: ChatInputSelectionRange,
  valueLength: number
): ChatInputSelectionRange {
  const start = Math.min(Math.max(selection.start, 0), valueLength)
  const end = Math.min(Math.max(selection.end, 0), valueLength)

  return { start, end }
}

function readTextareaSelection(
  textarea: HTMLTextAreaElement,
  valueLength: number
): ChatInputSelectionRange {
  return clampChatInputSelection(
    {
      start: textarea.selectionStart ?? valueLength,
      end: textarea.selectionEnd ?? valueLength,
    },
    valueLength
  )
}

function createNextVirtualPasteReferenceId(
  references: readonly ChatVirtualPasteReference[]
): string {
  const usedIds = new Set(references.map((reference) => reference.id))
  let nextIndex = references.length + 1

  while (usedIds.has(`paste-${nextIndex}`)) {
    nextIndex += 1
  }

  return `paste-${nextIndex}`
}

function readClipboardFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = []
  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') continue

    const file = item.getAsFile()
    if (isPresent(file)) files.push(file)
  }

  return files
}

// ── 主组件 ──────────────────────────────────────────────────────────────────
export function ChatInput({ control, density = 'default' }: ChatInputProps): React.ReactElement {
  useLayoutEffect(() => {
    markFirstChatComposerCommit()
  }, [])

  const { t, locale } = useConversationI18n()
  const tLatest = useLatest(t)
  const composerPort = useConversationComposerPort()
  const globalMessageLatest = useLatest(composerPort.notify)
  const openMicrophoneSettings = composerPort.openMicrophoneSettings
  const {
    value,
    selection,
    placeholder = t('chat.placeholder'),
    suggestion,
    disabled = false,
    onValueChange,
    onSelectionChange,
    virtualPasteReferences = EmptyVirtualPasteReferences,
    onVirtualPasteReferencesChange,
    onSend,
  } = control.input
  const guardedOnSend = useCallback(
    (draft?: ChatInputSendDraft): void | Promise<void> => {
      if (isOnboardingComposerSendLocked()) return
      return onSend(draft)
    },
    [onSend]
  )
  const { files, onFilesChange, onOpenFile } = control.attachments
  const {
    queuedDrafts = EmptyQueuedDrafts,
    isQueueDraining = false,
    onQueuedDraftMove,
    onQueuedDraftRemove,
    onQueuedDraftGuide,
    onQueuedDraftReturnToInput,
  } = control.queue ?? {}
  const executionControl = control.execution
  const goalMode = !!executionControl?.goalMode
  const onGoalModeChange = executionControl?.onGoalModeChange
  const goalModeCopy = executionControl?.goalModeCopy
  const planMode = !!executionControl?.planMode
  const onPlanModeChange = executionControl?.onPlanModeChange
  // 按「数据 vs 回调」拆成两组取用：features 域字段较多，混取会把状态与动作摊平成一大坨局部变量。
  const {
    browserElementSelections = EmptyBrowserElementSelections,
    unavailablePromptFeatures = EmptyPromptFeatures,
    resourceAvailabilityResolved = true,
    localWhisperAvailable = false,
    turnContextDeltas = EmptyTurnContextDeltas,
    workbenchCurrentFilePath,
    lockedPromptFeatures = EmptyPromptFeatures,
    promptFeatures = EmptyPromptFeatures,
    availableSkills = EmptyAvailableSkills,
    selectedSkillIds = EmptySelectedSkillIds,
    mentionables,
    quickPrompts = EmptyManualTestPrompts,
  } = control.features ?? {}
  const {
    onRemoveBrowserElementSelection,
    onDismissTurnContextDelta,
    onOpenSkillDetail,
    onPromptFeaturesChange,
    onSelectedSkillIdsChange,
  } = control.features ?? {}
  const {
    leftActions,
    rightActions,
    submitSlot,
    bottomSlot,
    beforeInput,
    afterInput,
    menuCapabilityControls = EmptyCapabilityControls,
    hideSubmit = false,
  } = control.chrome ?? {}
  const { isStreaming = false, canStop = false, onStop } = control.streaming ?? {}
  const {
    options: followUpSuggestions = EmptyFollowUpSuggestions,
    selectedId: selectedFollowUpSuggestionId,
    onSelect: onSelectFollowUpSuggestion,
  } = suggestion ?? {}
  const selectedMentionCount = mentionables?.selectedIds.length ?? 0
  const isComposing = useRef(false)
  const dragDepthRef = useRef(0)
  const valueRef = useRef(value)
  const filesRef = useRef(files)
  const virtualPasteReferencesRef =
    useRef<readonly ChatVirtualPasteReference[]>(virtualPasteReferences)
  const onValueChangeLatest = useLatest(onValueChange)
  const timers = useTimerScope('ChatInput')
  const isCompact = density === 'compact'
  const textareaRef = useAutoResize(value, { maxHeight: optionalWhenLazy(isCompact, () => 104) })
  useAutoFocus(textareaRef)
  const composerRootRef = useRef<HTMLDivElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [draftLimitError, setDraftLimitError] = useState<Nullable<string>>(null)
  const [previewOpenIndex, setPreviewOpenIndex] = useState<Nullable<number>>(null)
  const [isStopPending, setIsStopPending] = useState(false)
  const [inlineSuggestionDismissed, setInlineSuggestionDismissed] = useState(false)
  // 「用户拨到过第几条」；可见集合随输入前缀收缩时不改这一格，只在展示前夹取（见
  // `resolveInlineNextStepSuggestionIndex`），这样退格回去还能回到原来那条。
  const [inlineSuggestionIndex, setInlineSuggestionIndex] = useState(0)
  const imagePreviewMessages = useImagePreviewDialogMessages()
  const {
    composerMenuOpen,
    composerSubmenuId,
    setComposerMenuOpenState,
    closeComposerSubmenus,
    handleComposerActiveSubmenuChange,
  } = useComposerAddMenuState()

  const voiceInsertBridgeRef = useRef<ChatInputVoiceInsertBridge>(null)

  function showDraftLimitError(description: string): void {
    setDraftLimitError(description)
    globalMessageLatest.current.warning({
      title: tLatest.current('chat.composerLimitTitle'),
      description,
    })
  }

  function showInputLimitError(): void {
    showDraftLimitError(
      tLatest.current('chat.composerInputLimitReached', {
        max: ChatComposerInputMaxChars,
      })
    )
  }

  function showAttachmentLimitError(violation: ChatComposerLimitViolation): void {
    showDraftLimitError(formatChatComposerLimitViolation(violation, tLatest.current))
  }

  function updateSelectionFromTextarea(
    textarea: HTMLTextAreaElement,
    nextValueLength: number
  ): void {
    const nextSelection = readTextareaSelection(textarea, nextValueLength)

    if (selection?.start === nextSelection.start && selection.end === nextSelection.end) return

    onSelectionChange?.(nextSelection)
  }

  function applyTextareaValue(
    nextValue: string,
    textarea: Nullable<HTMLTextAreaElement> = null
  ): void {
    const limitedValue = clampChatComposerInput(nextValue)

    if (limitedValue.truncated) {
      showInputLimitError()
    } else if (draftLimitError) {
      setDraftLimitError(null)
    }

    valueRef.current = limitedValue.value
    if (!isVoiceListening) {
      voiceBaseValueRef.current = limitedValue.value
    }
    onValueChange(limitedValue.value)

    if (textarea) {
      updateSelectionFromTextarea(textarea, limitedValue.value.length)
    }
  }

  const {
    requestSend,
    enqueueVoiceSendDraft,
    isSubmitting,
    handleKeyDown,
    handleSelectManualTestPrompt,
    insertTextAtCursor,
    sendButtonTitle,
  } = useChatInputDraftActions({
    value,
    valueRef,
    onValueChange,
    onSelectionChange,
    files,
    filesRef,
    virtualPasteReferences,
    virtualPasteReferencesRef,
    auxiliaryContentCount: selectedMentionCount,
    textareaRef,
    disabled,
    hideSubmit,
    isStreaming,
    onSend: guardedOnSend,
    isComposing,
    voiceInsertBridgeRef,
    setComposerMenuOpenState,
    onInputLimitExceeded: showInputLimitError,
    t,
    timers,
  })
  const interactionState = resolveChatInputInteractionState({
    disabled,
    fileCount: files.length,
    hideSubmit,
    isStreaming,
    isSubmitting,
    value,
    virtualPasteReferenceCount: virtualPasteReferences.length,
    auxiliaryContentCount: selectedMentionCount,
  })
  const composerDisabled = interactionState.composerDisabled
  // 建议出主进程时已按 confidence 降序排好，所以数组序**就是**优先级序：第 1 条即最高优先级，
  // 提示条上的 `1/3` 直接是这个下标。输入框为空时全部候选可切换，开始输入后只留前缀命中项。
  const visibleFollowUpSuggestions = useMemo(
    () => matchNextStepSuggestionPrefix(followUpSuggestions, value),
    [followUpSuggestions, value]
  )
  const inlineSuggestionCount = visibleFollowUpSuggestions.length
  const activeInlineSuggestionIndex = resolveInlineNextStepSuggestionIndex(
    inlineSuggestionIndex,
    inlineSuggestionCount
  )
  const activeInlineSuggestion = visibleFollowUpSuggestions[activeInlineSuggestionIndex]
  const inlineSuggestionVisible =
    !composerDisabled && !inlineSuggestionDismissed && !!activeInlineSuggestion
  const canAcceptInlineCompletion =
    inlineSuggestionVisible &&
    !!activeInlineSuggestion &&
    !isNextStepSuggestionExactMatch(activeInlineSuggestion, value)
  /**
   * 幽灵层要与 textarea 逐像素对齐，靠的是「同一段文本、同一套排版」：已输入的那一截原样渲染成
   * 透明，余量接在后面。因此只有当建议**字面**以已输入内容开头时才画——前缀匹配本身是归一化的
   * （折空白、小写化），`add` 命中 `Add tests` 时两段宽度并不相等，那种情况就只留提示条不画幽灵。
   */
  const inlineGhostRemainder =
    inlineSuggestionVisible && activeInlineSuggestion?.prompt.startsWith(value)
      ? activeInlineSuggestion.prompt.slice(value.length)
      : ''
  /**
   * 输入框右上角那枚提示条：`open` = 已被 Esc 收起、按 ↑ 唤回；`active` = 建议正显示且还有可说的
   * （能切换或能补全）。只剩一条又已经原样落进输入框时两句都没得说，整枚提示条缺席——不留一个
   * 空边框在那里。
   */
  const inlineSuggestionHint =
    composerDisabled || inlineSuggestionCount === 0
      ? null
      : !inlineSuggestionVisible
        ? 'open'
        : inlineSuggestionCount > 1 || canAcceptInlineCompletion
          ? 'active'
          : null

  // 新一批建议到达时重新唤出，并把指针停在宿主声明的已选项上（宿主每轮都清空 selectedId，
  // 于是实际落点就是优先级最高的第 1 条）。`useLatest` 让 selectedId 只当种子读一次，
  // 不会因为选中态变化把用户刚拨到的那条弹回去。
  const selectedFollowUpSuggestionIdLatest = useLatest(selectedFollowUpSuggestionId)
  useEffect(() => {
    const selectedIndex = followUpSuggestions.findIndex(
      (item) => item.id === selectedFollowUpSuggestionIdLatest.current
    )
    setInlineSuggestionDismissed(false)
    setInlineSuggestionIndex(Math.max(selectedIndex, 0))
  }, [followUpSuggestions, selectedFollowUpSuggestionIdLatest])

  const completeFollowUpSuggestion = (suggestion: ChatSuggestionItem): void => {
    onSelectFollowUpSuggestion?.(suggestion.id)
    handleSelectManualTestPrompt({
      id: `next-step:${suggestion.id}`,
      title: suggestion.prompt,
      prompt: suggestion.prompt,
    })
  }

  const sendFollowUpSuggestion = (suggestion: ChatSuggestionItem): void => {
    onSelectFollowUpSuggestion?.(suggestion.id)
    setInlineSuggestionDismissed(true)
    void requestSend({
      value: suggestion.prompt,
      files,
      virtualPasteReferences: [...virtualPasteReferences],
    })
  }

  const handleInlineSuggestionKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ): boolean => {
    if (composerDisabled) return false
    // 内联建议的四个键位（↑↓ / Tab / Enter / Esc）全是**无修饰键**的组合，所以按住任一修饰键时
    // 整条路由让位：Shift+Enter 是换行、Shift+↑ 是选区、Shift+Tab 是反向切焦点，一个都不能被劫持。
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
    const action = resolveInlineNextStepSuggestionKeyboardAction({
      key: event.key,
      activeIndex: activeInlineSuggestionIndex,
      itemCount: inlineSuggestionCount,
      visible: inlineSuggestionVisible,
      inputEmpty: isEmpty(value),
      canAccept: canAcceptInlineCompletion,
    })
    if (action.kind === 'ignore') return false
    // 输入法组字中的 Enter 是「上屏」，不是「发送这条建议」。
    if (action.kind === 'send' && event.nativeEvent.isComposing) return false

    event.preventDefault()
    if (action.kind === 'cycle') {
      setInlineSuggestionIndex(action.index)
    } else if (action.kind === 'restore') {
      setInlineSuggestionDismissed(false)
    } else if (action.kind === 'dismiss') {
      setInlineSuggestionDismissed(true)
    } else if (action.kind === 'accept') {
      if (activeInlineSuggestion) completeFollowUpSuggestion(activeInlineSuggestion)
    } else if (activeInlineSuggestion) {
      sendFollowUpSuggestion(activeInlineSuggestion)
    }

    return true
  }

  const {
    fileInputRef,
    canAcceptFiles,
    appendFiles,
    handleFileSelect,
    handleRemoveFile,
    handleSelectFiles,
  } = useChatInputFileAttachments({
    files,
    onFilesChange,
    filesRef,
    disabled: composerDisabled,
    closeComposerMenu: () => setComposerMenuOpenState(false),
    onAttachmentLimitViolation: showAttachmentLimitError,
  })
  const handleHiddenFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      handleFileSelect(event.target.files)
      event.target.value = ''
    },
    [handleFileSelect]
  )
  const unavailablePromptFeatureSet = useMemo(
    () =>
      isEmpty(unavailablePromptFeatures)
        ? EmptyUnavailablePromptFeatures
        : new Set<ChatPromptFeatureId>(unavailablePromptFeatures),
    [unavailablePromptFeatures]
  )

  const {
    selectedPromptFeatures,
    pluginOptions,
    activePluginOptions,
    updatePromptFeature,
    updatePromptFeatureGroup,
  } = useComposerPromptFeatures({
    lockedPromptFeatures,
    promptFeatures,
    onPromptFeaturesChange,
    unavailablePromptFeatures: unavailablePromptFeatureSet,
    resourceAvailabilityResolved,
  })
  const selectedSkillIdSet = new Set(selectedSkillIds)
  const activeSkillOptions: ChatInputSkillOption[] = []
  for (const skill of availableSkills) {
    if (selectedSkillIdSet.has(skill.id)) activeSkillOptions.push(skill)
  }
  const { updateSelectedSkill } = useComposerSkillSelection({
    availableSkills,
    selectedSkillIds,
    onSelectedSkillIdsChange,
  })
  const slashSkillMenu = useComposerSlashSkillMenu({
    value,
    disabled: composerDisabled || !onSelectedSkillIdsChange,
    availableSkills,
    selectedSkillIds,
    updateSelectedSkill,
  })
  const mentionMenu = useComposerMentionMenu({
    value,
    disabled: composerDisabled || !mentionables,
    available: mentionables?.available ?? EmptyMentionables,
    selectedIds: mentionables?.selectedIds ?? EmptySelectedMentionIds,
    onToggleSelected: (id, selected) => mentionables?.onToggleSelected(id, selected),
    onDelete: (id) => mentionables?.onDelete(id),
    clearInput: () => applyTextareaValue('', textareaRef.current),
  })
  const activeMentionOptions = useMemo(() => {
    if (!mentionables) return EmptyMentionables
    const selected = new Set(mentionables.selectedIds)
    return mentionables.available.filter((option) => selected.has(option.id))
  }, [mentionables])
  const {
    voiceBaseValueRef,
    isVoiceListening,
    isVoiceProcessing,
    voiceInputError,
    voiceInputSupported,
    handleToggleVoiceInput,
  } = useChatInputVoiceRecognition({
    locale,
    textareaRef,
    valueRef,
    composerValue: value,
    onValueChangeLatest,
    enqueueVoiceSendDraft,
    disabled: composerDisabled,
    isStreaming,
    hideSubmit,
    localWhisperAvailable,
    t,
    tLatest,
    globalMessageLatest,
    openMicrophoneSettings,
  })

  voiceInsertBridgeRef.current = {
    voiceBaseValueRef,
    isVoiceListening: () => isVoiceListening,
  }

  useChatInputInsertDraftBridge(textareaRef, valueRef, onValueChangeLatest, timers)
  useChatInputPromptFeatureActivationBridge(
    textareaRef,
    selectedPromptFeatures,
    updatePromptFeature
  )

  const handleClearPlanMode = useCallback((): void => {
    onPlanModeChange?.(false)
  }, [onPlanModeChange])
  const handlePlanModeChange = useCallback(
    (enabled: boolean): void => {
      onPlanModeChange?.(enabled)
    },
    [onPlanModeChange]
  )
  const handleWorkbenchEditorControlChange = useCallback(
    (enabled: boolean): void => {
      updatePromptFeature('workbench-editor', enabled)
    },
    [updatePromptFeature]
  )
  const handleClearGoalMode = useCallback((): void => {
    onGoalModeChange?.(false)
  }, [onGoalModeChange])
  const handleGoalModeChange = useCallback(
    (enabled: boolean): void => {
      onGoalModeChange?.(enabled)
    },
    [onGoalModeChange]
  )

  const canShowComposerMenu =
    !!onFilesChange ||
    !!onPromptFeaturesChange ||
    !!onGoalModeChange ||
    !!onPlanModeChange ||
    (!!onSelectedSkillIdsChange && !!availableSkills.length) ||
    !!quickPrompts.length
  const showVoiceInput = !hideSubmit
  const voiceInputDisabled = composerDisabled || isStreaming || isVoiceProcessing
  const voiceInputLabel = isVoiceProcessing
    ? t('chat.voiceInputProcessing')
    : isVoiceListening
      ? t('chat.voiceInputStop')
      : voiceInputSupported
        ? t('chat.voiceInputStart')
        : t('chat.voiceInputUnsupported')
  const voiceInputTitle = voiceInputError ?? voiceInputLabel
  const imageSourceFiles = useMemo(() => {
    const nextImageSourceFiles: File[] = []

    for (const file of files) {
      if (file.type.startsWith('image/')) nextImageSourceFiles.push(file)
    }

    return nextImageSourceFiles
  }, [files])
  const imagePreviewUrls = useObjectUrls(imageSourceFiles)
  const inputLimitHelp =
    value.length >= ChatComposerInputWarningChars
      ? t('chat.composerInputLimitCounter', {
          count: value.length,
          max: ChatComposerInputMaxChars,
        })
      : null
  const visibleLimitMessage = draftLimitError ?? inputLimitHelp
  const primaryActionState = resolveChatInputPrimaryActionState({
    disabled,
    fileCount: files.length,
    hideSubmit,
    isRunActive: isStreaming,
    isStopAvailable: !!onStop && canStop,
    isStopPending,
    isSubmitting,
    value,
    virtualPasteReferenceCount: virtualPasteReferences.length,
    auxiliaryContentCount: selectedMentionCount,
  })

  function appendVirtualPasteReference(pastedText: string): void {
    if (!onVirtualPasteReferencesChange) return

    const nextReference = createVirtualPasteReference({
      id: createNextVirtualPasteReferenceId(virtualPasteReferencesRef.current),
      text: pastedText,
    })
    const nextReferences = [...virtualPasteReferencesRef.current, nextReference]

    virtualPasteReferencesRef.current = nextReferences
    onVirtualPasteReferencesChange(nextReferences)
    if (draftLimitError) setDraftLimitError(null)
  }

  function removeVirtualPasteReference(id: string): void {
    if (!onVirtualPasteReferencesChange) return

    const target = virtualPasteReferencesRef.current.find((reference) => reference.id === id)
    const nextReferences = virtualPasteReferencesRef.current.filter(
      (reference) => reference.id !== id
    )

    virtualPasteReferencesRef.current = nextReferences
    onVirtualPasteReferencesChange(nextReferences)

    if (target && valueRef.current.includes(target.marker)) {
      applyTextareaValue(valueRef.current.split(target.marker).join(''), textareaRef.current)
    }
  }

  function insertVirtualPasteReferenceMarker(reference: ChatVirtualPasteReference): void {
    insertTextAtCursor(reference.marker)
  }

  function formatVirtualPasteMeta(reference: ChatVirtualPasteReference): string {
    return t('chat.composerVirtualPasteMeta', {
      chars: reference.charCount,
      lines: reference.lineCount,
    })
  }

  const handleStopRequest = useCallback((): void => {
    if (!onStop || primaryActionState.kind !== 'stop' || primaryActionState.disabled) return

    setIsStopPending(true)
    timers.after(1200, () => setIsStopPending(false), {
      label: 'chatInput.stopPendingFallback',
    })

    try {
      const result = onStop()
      if (result) {
        void Promise.resolve(result).catch(() => {
          setIsStopPending(false)
        })
      }
    } catch (error) {
      setIsStopPending(false)
      throw error
    }
  }, [onStop, primaryActionState.disabled, primaryActionState.kind, timers])

  const handleSendClick = useCallback((): void => {
    void requestSend()
  }, [requestSend])

  const toolbarRightChrome = useMemo(
    () => ({
      rightActions,
    }),
    [rightActions]
  )
  const toolbarRightVoice = useMemo(
    () => ({
      showVoiceInput,
      voiceInputLabel,
      voiceInputTitle,
      voiceInputDisabled,
      isVoiceListening,
      voiceInputSupported,
      voiceButtonClassName: cx('voiceButton', isVoiceListening && 'listening'),
      onToggleVoiceInput: handleToggleVoiceInput,
    }),
    [
      handleToggleVoiceInput,
      isVoiceListening,
      showVoiceInput,
      voiceInputDisabled,
      voiceInputLabel,
      voiceInputSupported,
      voiceInputTitle,
    ]
  )
  const toolbarRightPrimaryAction = useMemo(
    () => ({
      showButton: primaryActionState.showButton,
      kind: primaryActionState.kind,
      title:
        primaryActionState.kind === 'stop'
          ? t('chat.stopStreaming')
          : primaryActionState.kind === 'sending'
            ? t('chat.sendingMessage')
            : sendButtonTitle,
      disabled: primaryActionState.disabled,
      pending: primaryActionState.pending,
      buttonClassName:
        primaryActionState.kind === 'stop'
          ? styles.stopButton
          : cx(
              'sendButton',
              primaryActionState.kind === 'sending' ? 'submitting' : interactionState.sendButtonTone
            ),
      onSendClick: handleSendClick,
      onStop: resolveChatInputPrimaryActionStopHandler({
        onStopAvailable: !!onStop,
        handleStopRequest,
      }),
    }),
    [
      handleSendClick,
      handleStopRequest,
      interactionState.sendButtonTone,
      onStop,
      primaryActionState.disabled,
      primaryActionState.kind,
      primaryActionState.pending,
      primaryActionState.showButton,
      sendButtonTitle,
      t,
    ]
  )

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(() => {
    virtualPasteReferencesRef.current = virtualPasteReferences
  }, [virtualPasteReferences])

  useLayoutEffect(() => {
    if (!selection) return

    const textarea = textareaRef.current
    if (!textarea) return

    const nextSelection = clampChatInputSelection(selection, value.length)
    if (
      textarea.selectionStart === nextSelection.start &&
      textarea.selectionEnd === nextSelection.end
    )
      return

    textarea.setSelectionRange(nextSelection.start, nextSelection.end)
  }, [selection, textareaRef, value.length])

  useEffect(() => {
    if (!isPresent(previewOpenIndex)) return

    if (previewOpenIndex >= imageSourceFiles.length) {
      setPreviewOpenIndex(imageSourceFiles.length ? imageSourceFiles.length - 1 : null)
    }
  }, [imageSourceFiles.length, previewOpenIndex])

  useEffect(() => {
    if (!isStreaming && isStopPending) {
      setIsStopPending(false)
    }
  }, [isStopPending, isStreaming])

  const previewItems = useMemo(() => {
    const items: Array<{
      id: string
      src: string
      alt: string
      title: string
      description: string
    }> = []

    imageSourceFiles.forEach((file, index) => {
      const src = imagePreviewUrls[index]

      if (!src) return

      items.push({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        src,
        alt: file.name,
        title: file.name,
        description: formatChatInputFileSize(file.size),
      })
    })

    return items
  }, [imagePreviewUrls, imageSourceFiles])

  const composerAddMenuDisabled = composerDisabled

  const composerAddMenuChromeInput = {
    disabled: composerAddMenuDisabled,
    t,
  }
  const composerAddMenuNavigationInput = {
    menuOpen: composerMenuOpen,
    onMenuOpenChange: setComposerMenuOpenState,
    activeSubmenuId: composerSubmenuId,
    onActiveSubmenuChangeFromCascading: handleComposerActiveSubmenuChange,
    onCloseSubmenus: closeComposerSubmenus,
  }
  const composerAddMenuAttachmentInput = {
    onSelectFilesClick: handleSelectFiles,
    canAttachFiles: !!onFilesChange,
  }
  const composerAddMenuFeatureInput = {
    canTogglePlanFeature: !!onPlanModeChange,
    planModeActive: planMode,
    updatePlanMode: handlePlanModeChange,
    // 「AI 操控编辑器」仍在开发中，暂时隐藏。
    canToggleWorkbenchEditorControl: false,
    workbenchEditorControlActive: selectedPromptFeatures.has('workbench-editor'),
    updateWorkbenchEditorControl: handleWorkbenchEditorControlChange,
    canToggleGoalMode: !!onGoalModeChange,
    goalModeActive: goalMode,
    goalModeCopy,
    updateGoalMode: handleGoalModeChange,
    canTogglePlugins: !!onPromptFeaturesChange,
    pluginOptions,
    selectedPromptFeatures,
    updatePromptFeatureGroup,
    canToggleSkills: !!onSelectedSkillIdsChange && !isEmpty(availableSkills),
    quickPrompts,
    availableSkills,
    selectedSkillIdSet,
    updateSelectedSkill,
    handleSelectQuickPrompt: handleSelectManualTestPrompt,
  }
  const composerAddMenuProps = buildChatInputComposerAddMenuProps(canShowComposerMenu, {
    chrome: composerAddMenuChromeInput,
    menu: composerAddMenuNavigationInput,
    attachments: composerAddMenuAttachmentInput,
    features: composerAddMenuFeatureInput,
    capabilityControls: menuCapabilityControls,
  })

  return (
    <Stack
      ref={composerRootRef}
      data-chat-input-root="true"
      className={cx('root', isDragActive && 'dragActive', isCompact && 'rootCompact')}
      gap="none"
      onDragEnter={(event) => {
        if (!canAcceptFiles || !hasDraggedFiles(event.dataTransfer)) return

        event.preventDefault()
        dragDepthRef.current += 1
        setIsDragActive(true)
      }}
      onDragOver={(event) => {
        if (!canAcceptFiles || !hasDraggedFiles(event.dataTransfer)) return

        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return

        event.preventDefault()
        dragDepthRef.current = Math.max(dragDepthRef.current - 1, 0)

        if (dragDepthRef.current === 0) {
          setIsDragActive(false)
        }
      }}
      onDrop={(event) => {
        if (!canAcceptFiles || !hasDraggedFiles(event.dataTransfer)) return

        event.preventDefault()
        dragDepthRef.current = 0
        setIsDragActive(false)
        appendFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <ComposerDropOverlay
        active={isDragActive}
        title={t('chat.dropFilesHere')}
        hint={t('chat.dropFilesHint')}
      />

      <ChatInputQueuePanel
        queuedDrafts={queuedDrafts}
        isQueueDraining={isQueueDraining}
        isStreaming={isStreaming}
        onQueuedDraftMove={onQueuedDraftMove}
        onQueuedDraftRemove={onQueuedDraftRemove}
        onQueuedDraftGuide={onQueuedDraftGuide}
        onQueuedDraftReturnToInput={onQueuedDraftReturnToInput}
      />

      <ComposerSlashSkillMenu menu={slashSkillMenu} header={t('chat.composerSlashSkillHeader')} />

      <ComposerMentionMenu
        menu={mentionMenu}
        // 表头/移除文案走来源注入；缺席才回落通用文案（菜单不替任何来源起名字）。
        header={mentionables?.header ?? t('chat.composerMentionHeader')}
        deleteLabel={mentionables?.deleteLabel ?? t('common.remove')}
      />

      {beforeInput}
      <ChatInputCore
        filePreview={
          <ComposerFilePreview
            files={files}
            disabled={composerDisabled}
            imageOpenPreviewLabel={t('chat.openImagePreview')}
            removeFileLabel={t('chat.removeFile')}
            onPreviewImageSubsetIndex={setPreviewOpenIndex}
            onRemoveFileAtFilesIndex={handleRemoveFile}
            onOpenFile={onOpenFile}
          />
        }
        topSlot={
          <ChatInputFunctionBar
            placement="legacy"
            t={t}
            disabled={composerDisabled}
            capabilityControls={menuCapabilityControls}
            planModeActive={planMode}
            goalModeActive={goalMode}
            goalModeLabel={goalModeCopy?.label}
            onClearPlanMode={handleClearPlanMode}
            onClearGoalMode={handleClearGoalMode}
            browserElementSelections={browserElementSelections}
            onRemoveBrowserElementSelection={onRemoveBrowserElementSelection}
            turnContextDeltas={turnContextDeltas}
            workbenchCurrentFilePath={workbenchCurrentFilePath}
            onDismissTurnContextDelta={onDismissTurnContextDelta}
            activePluginOptions={activePluginOptions}
            activeSkillOptions={activeSkillOptions}
            activeMentionOptions={activeMentionOptions}
            onRemoveMentionSelection={(id) => mentionables?.onToggleSelected(id, false)}
            onOpenSkillDetail={onOpenSkillDetail}
            lockedPromptFeatures={lockedPromptFeatures}
            updatePromptFeatureGroup={updatePromptFeatureGroup}
            updateSelectedSkill={updateSelectedSkill}
          />
        }
        inputArea={
          <>
            <ComposerVirtualPastePreview
              references={virtualPasteReferences}
              disabled={composerDisabled}
              showInInputLabel={t('chat.composerVirtualPasteShowInInput')}
              removeLabel={t('chat.composerVirtualPasteRemove')}
              formatMeta={formatVirtualPasteMeta}
              onInsertMarker={insertVirtualPasteReferenceMarker}
              onRemove={removeVirtualPasteReference}
            />
            <div
              className={cx(
                'textareaField',
                inlineSuggestionHint === 'active' && 'textareaFieldWideHint'
              )}
            >
              <Textarea
                ref={textareaRef}
                variant="bare"
                value={value}
                maxLength={ChatComposerInputMaxChars}
                onChange={(event) => {
                  applyTextareaValue(event.target.value, event.currentTarget)
                }}
                onSelect={(event) => {
                  updateSelectionFromTextarea(event.currentTarget, value.length)
                }}
                onPaste={(event) => {
                  const pastedText = event.clipboardData.getData('text/plain')
                  const selectionStart = event.currentTarget.selectionStart ?? value.length
                  const selectionEnd = event.currentTarget.selectionEnd ?? value.length
                  const nextRawValue = `${value.slice(0, selectionStart)}${pastedText}${value.slice(selectionEnd)}`
                  const shouldVirtualizePaste =
                    !!onVirtualPasteReferencesChange &&
                    shouldVirtualizePastedText({
                      pastedText,
                      nextInputLength: nextRawValue.length,
                      maxInputChars: ChatComposerInputMaxChars,
                    })
                  const pastedFiles = canAcceptFiles ? readClipboardFiles(event.clipboardData) : []

                  if (shouldVirtualizePaste) {
                    event.preventDefault()
                    if (!isEmpty(pastedFiles)) appendFiles(pastedFiles)
                    appendVirtualPasteReference(pastedText)
                    return
                  }

                  const wouldExceedInputLimit =
                    !!pastedText && nextRawValue.length > ChatComposerInputMaxChars

                  if (wouldExceedInputLimit) {
                    event.preventDefault()
                    insertTextAtCursor(pastedText)
                    return
                  }

                  if (isEmpty(pastedFiles)) return

                  event.preventDefault()
                  appendFiles(pastedFiles)
                  if (pastedText) {
                    insertTextAtCursor(pastedText)
                  }
                }}
                onKeyDown={(event) => {
                  if (mentionMenu.handleKeyDown(event)) return
                  if (slashSkillMenu.handleKeyDown(event)) return
                  if (!isComposing.current && handleInlineSuggestionKeyDown(event)) return
                  handleKeyDown(event)
                }}
                onCompositionStart={() => {
                  isComposing.current = true
                }}
                onCompositionEnd={() => {
                  isComposing.current = false
                }}
                // 幽灵文本已经占着这一格；再画一层占位符就是两段字叠在一起。
                placeholder={inlineGhostRemainder && isEmpty(value) ? '' : placeholder}
                disabled={composerDisabled}
                rows={isCompact ? 1 : 2}
                className={cx('textarea', !!inlineSuggestionHint && 'textareaWithCompletion')}
              />
              {!!inlineGhostRemainder && (
                <div
                  className={cx('inlineGhost', !!inlineSuggestionHint && 'inlineGhostWithHint')}
                  aria-hidden
                >
                  <span className={styles.inlineGhostTyped}>{value}</span>
                  {inlineGhostRemainder}
                </div>
              )}
              {!!inlineSuggestionHint && (
                <span className={styles.inlineCompletionHint} aria-hidden>
                  {inlineSuggestionHint === 'open' ? (
                    <>
                      <ArrowUpIcon size={10} weight="bold" aria-hidden />
                      {t('chat.suggestionOpenHint')}
                    </>
                  ) : (
                    <>
                      {inlineSuggestionCount > 1 && (
                        <>
                          <ArrowsDownUpIcon size={10} weight="bold" aria-hidden />
                          {t('chat.suggestionCycleHint', {
                            index: activeInlineSuggestionIndex + 1,
                            total: inlineSuggestionCount,
                          })}
                        </>
                      )}
                      {canAcceptInlineCompletion && (
                        <>
                          {inlineSuggestionCount > 1 && (
                            <span className={styles.inlineCompletionHintDivider}>·</span>
                          )}
                          {t('chat.suggestionTabHint')}
                        </>
                      )}
                    </>
                  )}
                </span>
              )}
            </div>
            {!!visibleLimitMessage && (
              <Text
                className={cx('limitMessage', !!draftLimitError && 'limitMessageError')}
                role={optionalWhenLazy(draftLimitError, () => 'alert')}
              >
                {visibleLimitMessage}
              </Text>
            )}
          </>
        }
      />
      {afterInput}

      <ChatInputActionRow
        leading={
          <ComposerToolbarLeading
            density={density}
            disabled={composerDisabled}
            fileInputRef={fileInputRef}
            onHiddenFileInputChange={handleHiddenFileInputChange}
            showHiddenFileInput={!!onFilesChange}
            canShowComposerMenu={canShowComposerMenu}
            addMenuProps={composerAddMenuProps}
            attachFileLabel={t('chat.attachFile')}
            onFallbackAttachClick={handleSelectFiles}
            activeChips={
              <ChatInputFunctionBar
                placement="persistent"
                t={t}
                disabled={composerDisabled}
                capabilityControls={menuCapabilityControls}
                planModeActive={planMode}
                goalModeActive={goalMode}
                goalModeLabel={goalModeCopy?.label}
                onClearPlanMode={handleClearPlanMode}
                onClearGoalMode={handleClearGoalMode}
                browserElementSelections={browserElementSelections}
                onRemoveBrowserElementSelection={onRemoveBrowserElementSelection}
                turnContextDeltas={turnContextDeltas}
                workbenchCurrentFilePath={workbenchCurrentFilePath}
                onDismissTurnContextDelta={onDismissTurnContextDelta}
                activePluginOptions={activePluginOptions}
                activeSkillOptions={activeSkillOptions}
                activeMentionOptions={activeMentionOptions}
                onRemoveMentionSelection={(id) => mentionables?.onToggleSelected(id, false)}
                onOpenSkillDetail={onOpenSkillDetail}
                lockedPromptFeatures={lockedPromptFeatures}
                updatePromptFeatureGroup={updatePromptFeatureGroup}
                updateSelectedSkill={updateSelectedSkill}
              />
            }
            leftActions={leftActions}
            bottomSlot={bottomSlot}
          />
        }
        trailing={
          <ComposerToolbarRight
            chrome={toolbarRightChrome}
            submitSlot={submitSlot}
            voice={toolbarRightVoice}
            primaryAction={toolbarRightPrimaryAction}
          />
        }
      />

      <ImagePreviewDialog
        items={previewItems}
        openIndex={previewOpenIndex}
        onOpenIndexChange={setPreviewOpenIndex}
        messages={imagePreviewMessages}
      />
    </Stack>
  )
}
