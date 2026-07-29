import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpIcon } from '@phosphor-icons/react'
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
  findHighestConfidenceNextStepSuggestion,
  isNextStepSuggestionExactMatch,
  matchNextStepSuggestionPrefix,
  NoNextStepSuggestionHighlightIndex,
  resolveNextStepSuggestionKeyboardAction,
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
import { useComposerCommentMentionMenu } from './hooks/useComposerCommentMentionMenu'
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
  ChatInputCommentMentionOption,
  ChatInputCommentMentions,
  ChatInputManualTestPromptOption,
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
import { ComposerCommentMentionMenu } from './ComposerCommentMentionMenu'
import { ComposerDropOverlay } from './ComposerDropOverlay'
import { ComposerFilePreview } from './ComposerFilePreview'
import { ComposerNextStepSuggestionMenu } from './ComposerNextStepSuggestionMenu'
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

export interface ChatInputExecutionControl {
  goalMode?: boolean
  onGoalModeChange?: (enabled: boolean) => void
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
  commentMentions?: ChatInputCommentMentions
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
const EmptyCommentMentions: ChatInputCommentMentionOption[] = []
const EmptySelectedCommentIds: string[] = []
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
    commentMentions,
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
  const selectedCommentCount = commentMentions?.selectedIds.length ?? 0
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
  const [followUpSuggestionsDismissed, setFollowUpSuggestionsDismissed] = useState(false)
  const [dismissFollowUpSuggestionsWhenFilesClear, setDismissFollowUpSuggestionsWhenFilesClear] =
    useState(false)
  const [highlightedFollowUpSuggestionIndex, setHighlightedFollowUpSuggestionIndex] = useState(
    NoNextStepSuggestionHighlightIndex
  )
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
    auxiliaryContentCount: selectedCommentCount,
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
    auxiliaryContentCount: selectedCommentCount,
  })
  const composerDisabled = interactionState.composerDisabled
  const visibleFollowUpSuggestions = useMemo(
    () => matchNextStepSuggestionPrefix(followUpSuggestions, value),
    [followUpSuggestions, value]
  )
  const recommendedFollowUpSuggestion = findHighestConfidenceNextStepSuggestion(
    visibleFollowUpSuggestions
  )
  const highlightedFollowUpSuggestion =
    visibleFollowUpSuggestions[highlightedFollowUpSuggestionIndex]
  const followUpSuggestionForCompletion =
    highlightedFollowUpSuggestion ?? recommendedFollowUpSuggestion
  const canAcceptInlineCompletion =
    !composerDisabled &&
    !!followUpSuggestionForCompletion &&
    !isNextStepSuggestionExactMatch(followUpSuggestionForCompletion, value)
  const visibleSelectedFollowUpSuggestionId = visibleFollowUpSuggestions.some(
    (suggestion) =>
      suggestion.id === selectedFollowUpSuggestionId &&
      isNextStepSuggestionExactMatch(suggestion, value)
  )
    ? selectedFollowUpSuggestionId
    : undefined
  const activeFollowUpSuggestionId =
    highlightedFollowUpSuggestion?.id ?? visibleSelectedFollowUpSuggestionId
  const followUpSuggestionMenuOpen =
    !followUpSuggestionsDismissed && !isEmpty(visibleFollowUpSuggestions)
  const suggestionKeyboardHint = !composerDisabled
    ? followUpSuggestionMenuOpen
      ? canAcceptInlineCompletion
        ? 'complete'
        : null
      : !isEmpty(visibleFollowUpSuggestions)
        ? 'open'
        : null
    : null

  function dismissFollowUpSuggestionMenu(): void {
    setFollowUpSuggestionsDismissed(true)
    setHighlightedFollowUpSuggestionIndex(NoNextStepSuggestionHighlightIndex)
  }

  function requestFollowUpSuggestionMenuDismiss(): void {
    if (filesRef.current.length > 0) {
      setDismissFollowUpSuggestionsWhenFilesClear(true)
      return
    }

    dismissFollowUpSuggestionMenu()
  }

  useEffect(() => {
    setFollowUpSuggestionsDismissed(false)
    setDismissFollowUpSuggestionsWhenFilesClear(false)
    setHighlightedFollowUpSuggestionIndex(NoNextStepSuggestionHighlightIndex)
  }, [followUpSuggestions])

  useEffect(() => {
    if (!dismissFollowUpSuggestionsWhenFilesClear || files.length > 0) return

    setDismissFollowUpSuggestionsWhenFilesClear(false)
    dismissFollowUpSuggestionMenu()
  }, [dismissFollowUpSuggestionsWhenFilesClear, files.length])

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
    requestFollowUpSuggestionMenuDismiss()
    void requestSend({
      value: suggestion.prompt,
      files,
      virtualPasteReferences: [...virtualPasteReferences],
    })
  }

  const handleFollowUpSuggestionKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ): boolean => {
    if (composerDisabled || isEmpty(visibleFollowUpSuggestions)) return false
    const action = resolveNextStepSuggestionKeyboardAction(
      event.key,
      highlightedFollowUpSuggestionIndex,
      visibleFollowUpSuggestions.length,
      followUpSuggestionMenuOpen,
      value.length === 0,
      onFilesChange ? files.length : 0
    )
    if (action.kind === 'ignore') return false
    if (action.kind === 'submit' && event.nativeEvent.isComposing) return false

    event.preventDefault()
    if (action.kind === 'open') {
      setDismissFollowUpSuggestionsWhenFilesClear(false)
      setFollowUpSuggestionsDismissed(false)
      setHighlightedFollowUpSuggestionIndex(action.index)
    } else if (action.kind === 'highlight') {
      setHighlightedFollowUpSuggestionIndex(action.index)
    } else if (action.kind === 'submit') {
      const suggestion = visibleFollowUpSuggestions[action.index]
      if (suggestion) sendFollowUpSuggestion(suggestion)
    } else if (action.kind === 'remove-attachment') {
      handleRemoveFile(action.index)
      if (action.dismissWhenEmpty) setDismissFollowUpSuggestionsWhenFilesClear(true)
    } else {
      dismissFollowUpSuggestionMenu()
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
    updateExclusivePromptFeature,
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
  const commentMentionMenu = useComposerCommentMentionMenu({
    value,
    disabled: composerDisabled || !commentMentions,
    available: commentMentions?.available ?? EmptyCommentMentions,
    selectedIds: commentMentions?.selectedIds ?? EmptySelectedCommentIds,
    onToggleSelected: (id, selected) => commentMentions?.onToggleSelected(id, selected),
    onDelete: (id) => commentMentions?.onDelete(id),
    clearInput: () => applyTextareaValue('', textareaRef.current),
  })
  const activeCommentOptions = useMemo(() => {
    if (!commentMentions) return EmptyCommentMentions
    const selected = new Set(commentMentions.selectedIds)
    return commentMentions.available.filter((comment) => selected.has(comment.id))
  }, [commentMentions])
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
    updatePromptFeature('plan', false)
  }, [updatePromptFeature])
  const handlePlanModeChange = useCallback(
    (enabled: boolean): void => {
      updateExclusivePromptFeature('plan', ['proposal'], enabled)
    },
    [updateExclusivePromptFeature]
  )
  const handleClearProposalMode = useCallback((): void => {
    updatePromptFeature('proposal', false)
  }, [updatePromptFeature])
  const handleProposalModeChange = useCallback(
    (enabled: boolean): void => {
      updateExclusivePromptFeature('proposal', ['plan'], enabled)
      if (enabled) {
        onGoalModeChange?.(false)
      }
    },
    [onGoalModeChange, updateExclusivePromptFeature]
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
      if (enabled) updatePromptFeature('proposal', false)
    },
    [onGoalModeChange, updatePromptFeature]
  )

  const canShowComposerMenu =
    !!onFilesChange ||
    !!onPromptFeaturesChange ||
    !!onGoalModeChange ||
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
    auxiliaryContentCount: selectedCommentCount,
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
    canTogglePlanFeature: !!onPromptFeaturesChange,
    planModeActive: selectedPromptFeatures.has('plan'),
    updatePlanMode: handlePlanModeChange,
    canToggleProposalFeature: !!onPromptFeaturesChange,
    proposalModeActive: selectedPromptFeatures.has('proposal'),
    updateProposalMode: handleProposalModeChange,
    // 「AI 操控编辑器」仍在开发中，暂时隐藏。
    canToggleWorkbenchEditorControl: false,
    workbenchEditorControlActive: selectedPromptFeatures.has('workbench-editor'),
    updateWorkbenchEditorControl: handleWorkbenchEditorControlChange,
    canToggleGoalMode: !!onGoalModeChange,
    goalModeActive: goalMode,
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

      <ComposerCommentMentionMenu
        menu={commentMentionMenu}
        header={t('chat.composerCommentMentionHeader')}
        deleteLabel={t('workbench.editorCommentDelete')}
      />

      <ComposerNextStepSuggestionMenu
        suggestions={followUpSuggestionMenuOpen ? visibleFollowUpSuggestions : []}
        selectedId={activeFollowUpSuggestionId}
        onSelect={sendFollowUpSuggestion}
        label={t('chat.nextStepSuggestionsTitle')}
        disabled={composerDisabled}
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
            planModeActive={selectedPromptFeatures.has('plan')}
            proposalModeActive={selectedPromptFeatures.has('proposal')}
            goalModeActive={goalMode}
            onClearPlanMode={handleClearPlanMode}
            onClearProposalMode={handleClearProposalMode}
            onClearGoalMode={handleClearGoalMode}
            browserElementSelections={browserElementSelections}
            onRemoveBrowserElementSelection={onRemoveBrowserElementSelection}
            turnContextDeltas={turnContextDeltas}
            workbenchCurrentFilePath={workbenchCurrentFilePath}
            onDismissTurnContextDelta={onDismissTurnContextDelta}
            activePluginOptions={activePluginOptions}
            activeSkillOptions={activeSkillOptions}
            activeCommentOptions={activeCommentOptions}
            onRemoveCommentSelection={(id) => commentMentions?.onToggleSelected(id, false)}
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
                if (commentMentionMenu.handleKeyDown(event)) return
                if (slashSkillMenu.handleKeyDown(event)) return
                if (handleFollowUpSuggestionKeyDown(event)) return
                if (
                  !isComposing.current &&
                  event.key === 'Tab' &&
                  followUpSuggestionMenuOpen &&
                  canAcceptInlineCompletion &&
                  followUpSuggestionForCompletion
                ) {
                  event.preventDefault()
                  completeFollowUpSuggestion(followUpSuggestionForCompletion)
                  return
                }
                if (
                  !isComposing.current &&
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  followUpSuggestionMenuOpen &&
                  interactionState.canSend
                ) {
                  requestFollowUpSuggestionMenuDismiss()
                }
                handleKeyDown(event)
              }}
              onCompositionStart={() => {
                isComposing.current = true
              }}
              onCompositionEnd={() => {
                isComposing.current = false
              }}
              placeholder={placeholder}
              disabled={composerDisabled}
              rows={isCompact ? 1 : 2}
              className={cx('textarea', !!suggestionKeyboardHint && 'textareaWithCompletion')}
            />
            {!!suggestionKeyboardHint && (
              <span className={styles.inlineCompletionHint} aria-hidden>
                {suggestionKeyboardHint === 'open' && (
                  <ArrowUpIcon size={10} weight="bold" aria-hidden />
                )}
                {t(
                  suggestionKeyboardHint === 'open'
                    ? 'chat.suggestionOpenHint'
                    : 'chat.suggestionTabHint'
                )}
              </span>
            )}
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
                planModeActive={selectedPromptFeatures.has('plan')}
                proposalModeActive={selectedPromptFeatures.has('proposal')}
                goalModeActive={goalMode}
                onClearPlanMode={handleClearPlanMode}
                onClearProposalMode={handleClearProposalMode}
                onClearGoalMode={handleClearGoalMode}
                browserElementSelections={browserElementSelections}
                onRemoveBrowserElementSelection={onRemoveBrowserElementSelection}
                turnContextDeltas={turnContextDeltas}
                workbenchCurrentFilePath={workbenchCurrentFilePath}
                onDismissTurnContextDelta={onDismissTurnContextDelta}
                activePluginOptions={activePluginOptions}
                activeSkillOptions={activeSkillOptions}
                activeCommentOptions={activeCommentOptions}
                onRemoveCommentSelection={(id) => commentMentions?.onToggleSelected(id, false)}
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
