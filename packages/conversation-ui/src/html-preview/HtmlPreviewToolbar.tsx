import React, { useCallback, useRef, useState } from 'react'
import {
  ArrowsClockwiseIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  CornersOutIcon,
  DownloadSimpleIcon,
} from '@phosphor-icons/react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { useTimerScope } from '../react-hooks/useTimerScope'

import type { TimerLease } from '#internal/timerScope'

const HtmlPreviewCopyResetDelayMs = 1600

export interface HtmlPreviewToolbarProps {
  copyLabel: string
  copiedLabel: string
  copyValue: string
  downloadLabel: string
  previewLabel?: string
  reloadLabel: string
  showCode: boolean
  showCodeLabel: string
  hideCodeLabel: string
  actionButtonClassName: string
  onDownload: () => void
  onOpenPreview?: () => void
  onReload: () => void
  onToggleCode: () => void
}

export function HtmlPreviewToolbar({
  copyLabel,
  copiedLabel,
  copyValue,
  downloadLabel,
  previewLabel,
  reloadLabel,
  showCode,
  showCodeLabel,
  hideCodeLabel,
  actionButtonClassName,
  onDownload,
  onOpenPreview,
  onReload,
  onToggleCode,
}: HtmlPreviewToolbarProps): React.ReactElement {
  const timers = useTimerScope('HtmlPreviewToolbar')
  const copiedResetTimerRef = useRef<Nullable<TimerLease>>(null)
  const [copied, setCopied] = useState(false)
  const copyButtonLabel = copied ? copiedLabel : copyLabel
  const handleCopy = useCallback((): void => {
    void navigator.clipboard.writeText(copyValue).then(() => {
      setCopied(true)
      copiedResetTimerRef.current?.cancel()
      copiedResetTimerRef.current = timers.after(
        HtmlPreviewCopyResetDelayMs,
        () => {
          copiedResetTimerRef.current = null
          setCopied(false)
        },
        { label: 'html-preview-toolbar.copy-reset' }
      )
    })
  }, [copyValue, timers])

  return (
    <>
      <IconButton
        label={copyButtonLabel}
        size="icon-sm"
        variant="ghost"
        className={actionButtonClassName}
        onClick={handleCopy}
      >
        {copied ? <CheckIcon size={14} weight="bold" /> : <CopyIcon size={14} />}
      </IconButton>
      <IconButton
        label={downloadLabel}
        size="icon-sm"
        variant="ghost"
        className={actionButtonClassName}
        onClick={onDownload}
      >
        <DownloadSimpleIcon size={14} />
      </IconButton>
      <IconButton
        label={reloadLabel}
        size="icon-sm"
        variant="ghost"
        className={actionButtonClassName}
        onClick={onReload}
      >
        <ArrowsClockwiseIcon size={14} />
      </IconButton>
      {!!(previewLabel && onOpenPreview) && (
        <IconButton
          label={previewLabel}
          size="icon-sm"
          variant="ghost"
          className={actionButtonClassName}
          onClick={onOpenPreview}
        >
          <CornersOutIcon size={14} />
        </IconButton>
      )}
      <IconButton
        label={showCode ? hideCodeLabel : showCodeLabel}
        size="icon-sm"
        variant={showCode ? 'secondary' : 'ghost'}
        className={actionButtonClassName}
        onClick={onToggleCode}
      >
        <CodeIcon size={14} />
      </IconButton>
    </>
  )
}
