/**
 * 图片预览对话框（放大查看）。
 *
 * 样式：`.velar-image-preview-dialog-overlay` · 见 styles/components/。
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEventListener, useLatest, useMemoizedFn } from 'ahooks'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Dialog, DialogClose, DialogOverlay, DialogPortal, DialogTitle } from '@velaros-ai/ui/primitives/overlays/Dialog'

import { cn } from '../../lib/cn'
import { isPresent, toNullable } from '../../lib/runtime'

export interface ImagePreviewItem {
  id: string
  src: string
  alt: string
  title?: string
  description?: string
}

export interface ImagePreviewDialogMessages {
  closeImagePreview: string
  previousImage: string
  nextImage: string
  imagePreviewCounter: string
  imagePreviewZoomOut: string
  imagePreviewZoomIn: string
  imagePreviewZoomLevel: string
  imagePreviewResetZoom: string
}

const defaultMessages: ImagePreviewDialogMessages = {
  closeImagePreview: 'Close',
  previousImage: 'Previous image',
  nextImage: 'Next image',
  imagePreviewCounter: '{current} / {total}',
  imagePreviewZoomOut: 'Zoom out',
  imagePreviewZoomIn: 'Zoom in',
  imagePreviewZoomLevel: 'Zoom level',
  imagePreviewResetZoom: 'Reset zoom',
}

function formatCounter(template: string, current: number, total: number): string {
  return template.replace('{current}', String(current)).replace('{total}', String(total))
}

export interface ImagePreviewDialogProps {
  items: ImagePreviewItem[]
  openIndex: Nullable<number>
  onOpenIndexChange: (index: Nullable<number>) => void
  /** 宿主提供的文案，例如本地化消息；默认使用英文文案。 */
  messages?: Partial<ImagePreviewDialogMessages>
}

const DEFAULT_SCALE = 1
const MIN_SCALE = 0.25
const MAX_SCALE = 3
const SCALE_STEP = 0.25
const DEFAULT_POSITION = { x: 0, y: 0 }

interface PreviewPosition {
  x: number
  y: number
}

interface DragState {
  pointerId: number
  lastX: number
  lastY: number
}

function getClampedIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0))
}

function getClampedScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE)
}

export const ImagePreviewDialog = memo(
  ({
    items,
    openIndex,
    onOpenIndexChange,
    messages: messagesProp,
  }: ImagePreviewDialogProps): Nullable<React.ReactElement> => {
    const messages = { ...defaultMessages, ...messagesProp }
    const [scale, setScale] = useState(DEFAULT_SCALE)
    const [position, setPosition] = useState<PreviewPosition>(DEFAULT_POSITION)
    const [isDragging, setIsDragging] = useState(false)
    const dragStateRef = useRef<DragState>(null)
    const isOpen = isPresent(openIndex) && items.length > 0
    const currentIndex = getClampedIndex(openIndex ?? 0, items.length)
    const currentItem = items[currentIndex]
    const currentItemId = (toNullable(currentItem?.id))
    const hasMultipleItems = items.length > 1
    const zoomLabel = `${Math.round(scale * 100)}%`

    const onOpenIndexChangeLatest = useLatest(onOpenIndexChange)

    const updateScale = useCallback((delta: number): void => {
      setScale((currentScale) => getClampedScale(currentScale + delta))
    }, [])

    const resetTransform = useCallback((): void => {
      setScale(DEFAULT_SCALE)
      setPosition(DEFAULT_POSITION)
    }, [])

    function handleImageWheel(event: React.WheelEvent<HTMLDivElement>): void {
      event.preventDefault()
      updateScale(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)
    }

    function handleImagePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
      if (event.button !== 0) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragStateRef.current = {
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      }
      setIsDragging(true)
    }

    function handleImagePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
      const dragState = dragStateRef.current
      if (!dragState || dragState.pointerId !== event.pointerId) return

      event.preventDefault()
      const deltaX = event.clientX - dragState.lastX
      const deltaY = event.clientY - dragState.lastY

      dragStateRef.current = {
        ...dragState,
        lastX: event.clientX,
        lastY: event.clientY,
      }
      setPosition((currentPosition) => ({
        x: currentPosition.x + deltaX,
        y: currentPosition.y + deltaY,
      }))
    }

    function endImageDrag(event?: React.PointerEvent<HTMLDivElement>): void {
      const dragState = dragStateRef.current
      if (
        event &&
        dragState?.pointerId === event.pointerId &&
        event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      dragStateRef.current = null
      setIsDragging(false)
    }

    useEffect(() => {
      if (!isPresent(openIndex)) return

      if (!items.length) {
        onOpenIndexChangeLatest.current(null)
        return
      }

      const clampedIndex = getClampedIndex(openIndex, items.length)
      if (clampedIndex !== openIndex) {
        onOpenIndexChangeLatest.current(clampedIndex)
      }
    }, [items.length, openIndex])

    const handlePreviewKeyDown = useMemoizedFn((event: KeyboardEvent): void => {
      if (hasMultipleItems && event.key === 'ArrowLeft') {
        event.preventDefault()
        onOpenIndexChangeLatest.current((currentIndex - 1 + items.length) % items.length)
      }

      if (hasMultipleItems && event.key === 'ArrowRight') {
        event.preventDefault()
        onOpenIndexChangeLatest.current((currentIndex + 1) % items.length)
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        updateScale(SCALE_STEP)
      }

      if (event.key === '-') {
        event.preventDefault()
        updateScale(-SCALE_STEP)
      }

      if (event.key === '0') {
        event.preventDefault()
        resetTransform()
      }
    })

    useEventListener('keydown', handlePreviewKeyDown, { enable: isOpen })

    useEffect(() => {
      if (isOpen) {
        resetTransform()
      }
    }, [currentItemId, isOpen, resetTransform])

    if (!currentItem) return null

    const counterText = hasMultipleItems
      ? formatCounter(messages.imagePreviewCounter, currentIndex + 1, items.length)
      : null

    const subtitle = [currentItem.description, counterText].filter((value) => !!value).join(' · ')

    return (
      <Dialog
        open={isOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            onOpenIndexChangeLatest.current(null)
          }
        }}
      >
        <DialogPortal>
          <DialogOverlay className="velar-image-preview-dialog-overlay" />
          <DialogPrimitive.Content
            className="velar-image-preview-dialog-content"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="velar-image-preview-dialog-top-bar">
              <div className="velar-image-preview-dialog-meta">
                <DialogTitle className="velar-image-preview-dialog-title">
                  {currentItem.title || currentItem.alt}
                </DialogTitle>
                {(subtitle.length > 0) && (
                  <p className="velar-image-preview-dialog-subtitle">{subtitle}</p>
                )}
              </div>

              <DialogClose asChild>
                <IconButton
                  label={messages.closeImagePreview}
                  size="icon-sm"
                  className="velar-image-preview-dialog-close-button"
                >
                  <XIcon size={18} weight="bold" />
                </IconButton>
              </DialogClose>
            </div>

            <div className="velar-image-preview-dialog-viewport">
              {hasMultipleItems && (
                <>
                  <IconButton
                    label={messages.previousImage}
                    size="icon"
                    className={cn(
                      'velar-image-preview-dialog-nav-button',
                      'velar-image-preview-dialog-nav-button-left',
                    )}
                    onClick={() => {
                      onOpenIndexChangeLatest.current((currentIndex - 1 + items.length) % items.length)
                    }}
                  >
                    <CaretLeftIcon size={18} weight="bold" />
                  </IconButton>

                  <IconButton
                    label={messages.nextImage}
                    size="icon"
                    className={cn(
                      'velar-image-preview-dialog-nav-button',
                      'velar-image-preview-dialog-nav-button-right',
                    )}
                    onClick={() => {
                      onOpenIndexChangeLatest.current((currentIndex + 1) % items.length)
                    }}
                  >
                    <CaretRightIcon size={18} weight="bold" />
                  </IconButton>
                </>
              )}

              <div className="velar-image-preview-dialog-image-frame">
                <div
                  className={cn(
                    'velar-image-preview-dialog-image-stage',
                    isDragging && 'velar-image-preview-dialog-image-stage-dragging',
                  )}
                  style={{
                    transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
                  }}
                  onPointerDown={handleImagePointerDown}
                  onPointerMove={handleImagePointerMove}
                  onPointerUp={endImageDrag}
                  onPointerCancel={endImageDrag}
                  onLostPointerCapture={() => endImageDrag()}
                  onWheel={handleImageWheel}
                >
                  <img
                    src={currentItem.src}
                    alt={currentItem.alt}
                    className="velar-image-preview-dialog-image"
                    draggable={false}
                    style={{ transform: `scale(${scale})` }}
                  />
                </div>
              </div>
            </div>

            <div className="velar-image-preview-dialog-toolbar">
              <IconButton
                label={messages.imagePreviewZoomOut}
                size="icon-sm"
                className={cn(
                  'velar-image-preview-dialog-toolbar-button',
                  'velar-image-preview-dialog-toolbar-button-first',
                )}
                disabled={scale <= MIN_SCALE}
                onClick={() => updateScale(-SCALE_STEP)}
              >
                <MinusIcon size={16} weight="bold" />
              </IconButton>
              <span
                className="velar-image-preview-dialog-zoom-value"
                aria-label={messages.imagePreviewZoomLevel}
              >
                {zoomLabel}
              </span>
              <IconButton
                label={messages.imagePreviewZoomIn}
                size="icon-sm"
                className="velar-image-preview-dialog-toolbar-button"
                disabled={scale >= MAX_SCALE}
                onClick={() => updateScale(SCALE_STEP)}
              >
                <PlusIcon size={16} weight="bold" />
              </IconButton>
              <span className="velar-image-preview-dialog-toolbar-divider" aria-hidden="true" />
              <IconButton
                label={messages.imagePreviewResetZoom}
                size="icon-sm"
                className={cn(
                  'velar-image-preview-dialog-toolbar-button',
                  'velar-image-preview-dialog-toolbar-button-last',
                )}
                disabled={scale === DEFAULT_SCALE && position.x === 0 && position.y === 0}
                onClick={resetTransform}
              >
                <ArrowCounterClockwiseIcon size={16} />
              </IconButton>
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    )
  },
)

ImagePreviewDialog.displayName = 'ImagePreviewDialog'
