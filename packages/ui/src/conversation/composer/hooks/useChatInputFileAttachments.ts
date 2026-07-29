import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef } from 'react'

import { mergeChatInputFiles, normalizeIncomingFile } from '../chatInputUtils'
import {
  type ChatComposerLimitViolation,
  getImageAttachmentLimitViolation,
} from '../utils/chatComposerLimits'

import { isEmpty } from '#internal/runtime'

export interface UseChatInputFileAttachmentsParams {
  files: File[]
  onFilesChange?: (files: File[]) => void
  filesRef: MutableRefObject<File[]>
  disabled: boolean
  closeComposerMenu: () => void
  onAttachmentLimitViolation?: (violation: ChatComposerLimitViolation) => void
}

export interface UseChatInputFileAttachmentsResult {
  fileInputRef: RefObject<Nullable<HTMLInputElement>>
  canAcceptFiles: boolean
  appendFiles: (nextFiles: Iterable<File>) => void
  handleFileSelect: (fileList: Nullable<FileList>) => void
  handleRemoveFile: (index: number) => void
  handleSelectFiles: () => void
}

export function useChatInputFileAttachments({
  files,
  onFilesChange,
  filesRef,
  disabled,
  closeComposerMenu,
  onAttachmentLimitViolation,
}: UseChatInputFileAttachmentsParams): UseChatInputFileAttachmentsResult {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canAcceptFiles = !!onFilesChange && !disabled

  useEffect(() => {
    filesRef.current = files
  }, [files, filesRef])

  const appendFiles = useCallback((nextFiles: Iterable<File>): void => {
    if (!onFilesChange) return

    const normalizedFiles: File[] = []
    let index = 0
    for (const file of nextFiles) {
      normalizedFiles.push(normalizeIncomingFile(file, index))
      index += 1
    }

    if (isEmpty(normalizedFiles)) return

    const mergedFiles = mergeChatInputFiles(files, normalizedFiles)
    const violation = getImageAttachmentLimitViolation(mergedFiles)
    if (violation) {
      onAttachmentLimitViolation?.(violation)
      return
    }

    filesRef.current = mergedFiles
    onFilesChange(mergedFiles)
  }, [files, filesRef, onAttachmentLimitViolation, onFilesChange])

  const handleFileSelect = useCallback((fileList: Nullable<FileList>): void => {
    if (!fileList || !onFilesChange) return
    appendFiles(Array.from(fileList))
  }, [appendFiles, onFilesChange])

  const handleRemoveFile = useCallback((index: number): void => {
    if (!onFilesChange) return
    const nextFiles: File[] = []
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex]
      if (fileIndex !== index && file) nextFiles.push(file)
    }

    filesRef.current = nextFiles
    onFilesChange(nextFiles)
  }, [files, filesRef, onFilesChange])

  const handleSelectFiles = useCallback((): void => {
    fileInputRef.current?.click()
    closeComposerMenu()
  }, [closeComposerMenu])

  return {
    fileInputRef,
    canAcceptFiles,
    appendFiles,
    handleFileSelect,
    handleRemoveFile,
    handleSelectFiles,
  }
}
