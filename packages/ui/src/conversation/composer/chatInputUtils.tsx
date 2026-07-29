import React from 'react'
import {
  ChartBarIcon,
  CursorClickIcon,
  FileCodeIcon,
  FileDocIcon,
  FileHtmlIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileXlsIcon,
  FlaskIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ListChecksIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react'

import type {
  BrowserSpeechRecognitionConstructor,
  ChatInputIconComponent,
  ChatInputPromptFeatureGroupOption,
  ChatInputPromptFeatureOption,
  ComposerSubmenuId,
} from './chatInputTypes'

import type { ChatPromptFeatureId } from '#contracts'
import {
  isOfficePromptFeature,
  OfficePromptFeatures,
  PluginPromptFeatures,
  PromptFeatureGroupManifests,
  type PromptFeatureIconId,
  PromptFeatureManifests,
  PromptFeatureOrder,
} from '#internal/promptFeatures'
import { toNullable } from '#internal/runtime'

// ─── OfficeSuiteIcon ──────────────────────────────────────────────────────────

export function OfficeSuiteIcon({
  size = 16,
  weight,
}: {
  size?: number | string
  weight?: string
}): React.ReactElement {
  const strokeWidth = weight === 'bold' || weight === 'fill' ? 20 : 16

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M86 45 177 28l39 25v150l-39 25-91-17-46-32V77Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <path
        d="M86 45v166m0-166 86 32v102l-86 32m86-134 44-24m-44 126 44 24"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ─── Voice constants ──────────────────────────────────────────────────────────

export const TrailingVoicePunctuationPattern = /[\s,，.。!！?？;；:：、]+$/g
export const VoiceSendCommandPattern =
  '(?:发送|发出|发出去|提交|确认发送|发送吧|发吧|send|send it|submit|send message)'
export const ExactVoiceSendCommands = new Set([
  '发送',
  '发出',
  '发出去',
  '提交',
  '确认发送',
  '发送吧',
  '发吧',
  '然后发送',
  '然后提交',
  'send',
  'send it',
  'submit',
  'send message',
])

// ─── Manual test prompt icon ──────────────────────────────────────────────────

export function getManualTestPromptIcon(promptId: string): React.ReactNode {
  switch (promptId) {
    case 'workspace-list':
      return <FolderOpenIcon size={14} />
    case 'workspace-add-approval':
      return <FolderPlusIcon size={14} />
    case 'workspace-package-read':
      return <FileTextIcon size={14} />
    case 'confirmation-card':
    case 'high-risk-permission':
      return <ShieldCheckIcon size={14} />
    default:
      return <FlaskIcon size={14} />
  }
}

// ─── Prompt feature configuration ────────────────────────────────────────────

const PromptFeatureIconMap: Record<PromptFeatureIconId, ChatInputIconComponent> = {
  office: OfficeSuiteIcon,
  computer: CursorClickIcon,
  html: FileHtmlIcon,
  widget: ChartBarIcon,
  word: FileDocIcon,
  spreadsheet: FileXlsIcon,
  presentation: FilePptIcon,
  pdf: FilePdfIcon,
  latex: FileCodeIcon,
}

export const ChatPromptFeatureOptions: ChatInputPromptFeatureOption[] = PromptFeatureManifests
  .filter((feature) => PluginPromptFeatures.includes(feature.id) && !feature.parentId)
  .map((feature) => ({
    id: feature.id,
    labelKey: feature.labelKey,
    icon: PromptFeatureIconMap[feature.iconId],
  }))

export const OfficePromptFeatureOptions: ChatInputPromptFeatureGroupOption[] =
  PromptFeatureGroupManifests.filter((group) => group.parentId === 'office').map((group) => ({
    id: group.id,
    featureIds: [...group.featureIds],
    labelKey: group.labelKey,
    icon: PromptFeatureIconMap[group.iconId],
  }))

export const OfficePromptFeatureIds = [...OfficePromptFeatures]
export const NonOfficePromptFeatureOptions: ChatInputPromptFeatureOption[] =
  ChatPromptFeatureOptions.filter((option) => option.id !== 'office')
export const ChatPromptFeatureOrder: ChatPromptFeatureId[] = [...PromptFeatureOrder]
export { isOfficePromptFeature }

// ─── File helpers ─────────────────────────────────────────────────────────────

export function formatChatInputFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function buildChatInputFileKey(file: File): string {
  return [file.name, file.size, file.type, file.lastModified].join(':')
}

export function mergeChatInputFiles(currentFiles: File[], nextFiles: Iterable<File>): File[] {
  const mergedFiles = [...currentFiles]
  const seen = new Set<string>()
  for (const file of currentFiles) {
    seen.add(buildChatInputFileKey(file))
  }

  for (const file of nextFiles) {
    const key = buildChatInputFileKey(file)

    if (seen.has(key)) {
      continue
    }

    mergedFiles.push(file)
    seen.add(key)
  }

  return mergedFiles
}

export function hasDraggedFiles(dataTransfer?: LooseOptional<DataTransfer>): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}

// ─── Speech Recognition helpers ───────────────────────────────────────────────

export function getSpeechRecognitionConstructor(): Nullable<BrowserSpeechRecognitionConstructor> {
  const win = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor
  }
  const ctor =
    (win.SpeechRecognition as BrowserSpeechRecognitionConstructor | undefined) ??
    (win.webkitSpeechRecognition as BrowserSpeechRecognitionConstructor | undefined)
  return (toNullable(ctor))
}

export function normalizeVoiceCommandText(text: string): string {
  return text.replace(TrailingVoicePunctuationPattern, '').trim()
}

export function parseVoiceTranscript(text: string): { shouldSend: boolean; text: string } {
  const normalizedText = normalizeVoiceCommandText(text)

  if (!normalizedText) return { shouldSend: false, text: '' }

  if (ExactVoiceSendCommands.has(normalizedText.toLowerCase())) return { shouldSend: true, text: '' }

  const separatedCommandMatch = normalizedText.match(
    new RegExp(
      `^(.*?)[\\s,，.。!！?？;；:：、]+${VoiceSendCommandPattern}[\\s,，.。!！?？;；:：、]*$`,
      'i'
    )
  )

  if (separatedCommandMatch?.[1]?.trim()) return { shouldSend: true, text: separatedCommandMatch[1].trim() }

  const connectedCommandMatch = normalizedText.match(
    new RegExp(
      `^(.*?)(?:然后|并且|并|再|就)${VoiceSendCommandPattern}[\\s,，.。!！?？;；:：、]*$`,
      'i'
    )
  )

  if (connectedCommandMatch?.[1]?.trim()) return { shouldSend: true, text: connectedCommandMatch[1].trim() }

  return { shouldSend: false, text: normalizedText }
}

export function shouldInsertVoiceSpace(base: string, addition: string): boolean {
  return /[A-Za-z0-9]$/.test(base.trimEnd()) && /^[A-Za-z0-9]/.test(addition.trimStart())
}

export function appendVoiceTranscript(base: string, addition: string): string {
  if (!base) return addition
  const separator = shouldInsertVoiceSpace(base, addition) ? ' ' : ''
  return base + separator + addition
}

// ─── File normalization ───────────────────────────────────────────────────────

export function normalizeIncomingFile(file: File, index: number): File {
  if (file.name && file.name !== 'image.png') return file
  const ext = file.type.split('/')[1] ?? 'bin'
  const newName = `image-${index + 1}.${ext}`
  return new File([file], newName, { type: file.type, lastModified: file.lastModified })
}

// ─── Submenu helpers ──────────────────────────────────────────────────────────

export const ComposerSubmenuIds: ComposerSubmenuId[] = [
  'quick-prompts',
  'rendering',
  'plugins',
  'skills',
]

// ─── Skill helpers ────────────────────────────────────────────────────────────

export function getSkillIcon(skillId: string): React.ReactNode {
  switch (skillId) {
    case 'plan':
      return <ListChecksIcon size={14} />
    case 'plugins':
      return <PuzzlePieceIcon size={14} />
    default:
      return null
  }
}
