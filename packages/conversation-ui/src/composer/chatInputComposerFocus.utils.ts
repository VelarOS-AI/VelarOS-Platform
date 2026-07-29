import type React from 'react'

import type { TimerScope } from '#internal/timerScope'

export function focusComposerTextareaNextFrame(
  textareaRef: React.RefObject<Nullable<HTMLTextAreaElement>>,
  timers: TimerScope
): void {
  timers.nextFrame(
    () => {
      textareaRef.current?.focus()
    },
    { label: 'chatInput.focus' }
  )
}

export function focusComposerTextareaWithCaretNextFrame(
  textareaRef: React.RefObject<Nullable<HTMLTextAreaElement>>,
  caretPosition: number,
  timers: TimerScope
): void {
  timers.nextFrame(
    () => {
      const textarea = textareaRef.current

      if (!textarea) return

      textarea.focus()
      textarea.setSelectionRange(caretPosition, caretPosition)
    },
    { label: 'chatInput.focusCaret' }
  )
}
