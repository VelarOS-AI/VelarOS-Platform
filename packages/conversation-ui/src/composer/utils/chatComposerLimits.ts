import type { ConversationMessageKey as MessageKey } from '../../i18n'

export const ChatComposerInputMaxChars = 60_000
export const ChatComposerInputWarningChars = Math.floor(ChatComposerInputMaxChars * 0.9)
export const ChatComposerRequestTextMaxChars = 140_000
export const ChatComposerImageMaxBytesPerFile = 10 * 1024 * 1024
export const ChatComposerImageMaxBytesTotal = 20 * 1024 * 1024

export type ChatComposerLimitViolation =
  | {
      kind: 'input'
      actualChars: number
      maxChars: number
    }
  | {
      kind: 'image-file'
      fileName: string
      actualBytes: number
      maxBytes: number
    }
  | {
      kind: 'image-total'
      actualBytes: number
      maxBytes: number
    }
  | {
      kind: 'request'
      actualChars: number
      maxChars: number
    }

interface ChatComposerDraftLimitInput {
  input: string
  files: readonly File[]
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function clampChatComposerInput(input: string): {
  value: string
  truncated: boolean
} {
  if (input.length <= ChatComposerInputMaxChars) return { value: input, truncated: false }

  return {
    value: input.slice(0, ChatComposerInputMaxChars),
    truncated: true,
  }
}

function isChatComposerImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

export function getImageAttachmentLimitViolation(
  files: readonly File[]
): Nullable<ChatComposerLimitViolation> {
  let totalBytes = 0
  for (const file of files) {
    if (!isChatComposerImageFile(file)) {
      continue
    }

    if (file.size > ChatComposerImageMaxBytesPerFile) return {
        kind: 'image-file',
        fileName: file.name,
        actualBytes: file.size,
        maxBytes: ChatComposerImageMaxBytesPerFile,
      }

    totalBytes += file.size

    if (totalBytes > ChatComposerImageMaxBytesTotal) return {
        kind: 'image-total',
        actualBytes: totalBytes,
        maxBytes: ChatComposerImageMaxBytesTotal,
      }
  }

  return null
}

export function getChatComposerDraftLimitViolation({
  input,
  files,
}: ChatComposerDraftLimitInput): Nullable<ChatComposerLimitViolation> {
  const normalizedInput = input.trim()

  if (normalizedInput.length > ChatComposerInputMaxChars) return {
      kind: 'input',
      actualChars: normalizedInput.length,
      maxChars: ChatComposerInputMaxChars,
    }

  const attachmentViolation = getImageAttachmentLimitViolation(files)
  if (attachmentViolation) return attachmentViolation

  if (normalizedInput.length > ChatComposerRequestTextMaxChars) return {
      kind: 'request',
      actualChars: normalizedInput.length,
      maxChars: ChatComposerRequestTextMaxChars,
    }

  return null
}

export function formatChatComposerLimitViolation(
  violation: ChatComposerLimitViolation,
  t: Translate
): string {
  switch (violation.kind) {
    case 'input':
      return t('chat.composerInputTooLong', {
        count: violation.actualChars,
        max: violation.maxChars,
      })
    case 'image-file':
      return t('chat.composerImageTooLarge', {
        name: violation.fileName,
        size: formatByteSize(violation.actualBytes),
        max: formatByteSize(violation.maxBytes),
      })
    case 'image-total':
      return t('chat.composerImagesTooLarge', {
        size: formatByteSize(violation.actualBytes),
        max: formatByteSize(violation.maxBytes),
      })
    case 'request':
      return t('chat.composerRequestTooLong', {
        count: violation.actualChars,
        max: violation.maxChars,
      })
  }
}
