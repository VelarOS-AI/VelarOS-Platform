import { useEffect, useMemo, useRef, useState } from 'react'
import { useLatest, useMemoizedFn } from 'ahooks'
import type { MutableRefObject, RefObject } from 'react'

import type { ConversationMessageKey as MessageKey } from '../../i18n'
import { useTimerScope } from '../../react-hooks/useTimerScope'
import { focusComposerTextareaNextFrame } from '../chatInputComposerFocus.utils'
import {
  type BrowserSpeechRecognition,
  type BrowserSpeechRecognitionErrorEvent,
  type BrowserSpeechRecognitionEvent,
} from '../chatInputTypes'
import {
  appendVoiceTranscript,
  getSpeechRecognitionConstructor,
  parseVoiceTranscript,
} from '../chatInputUtils'
import { useConversationComposerPort } from '../conversationComposerPort'

import { LocalSpeechCapture } from './localSpeechCapture'

import type { AppLocale } from '#contracts'
import { Result } from '#internal/result'
import { isBlank,optionalWhen, optionalWhenLazy } from '#internal/runtime'

const LocalVoiceCaptureMaxDurationMs = 120_000

interface ComposerGlobalMessageLatest {
  error: (opts: {
    title: string
    duration?: number
    actionLabel?: string
    onAction?: () => void
  }) => void
  warning: (opts: { title: string }) => void
}

export interface UseChatInputVoiceRecognitionOptions {
  locale: AppLocale
  textareaRef: RefObject<Nullable<HTMLTextAreaElement>>
  valueRef: MutableRefObject<string>

  composerValue: string
  onValueChangeLatest: MutableRefObject<(next: string) => void>
  enqueueVoiceSendDraft: (nextValue: string) => void

  disabled: boolean
  isStreaming: boolean
  hideSubmit: boolean
  localWhisperAvailable: boolean

  t: (key: MessageKey, params?: Record<string, string | number>) => string
  tLatest: MutableRefObject<(key: MessageKey, params?: Record<string, string | number>) => string>
  globalMessageLatest: MutableRefObject<ComposerGlobalMessageLatest>

  openMicrophoneSettings: () => void | Promise<void>
}

export interface UseChatInputVoiceRecognitionResult {
  voiceBaseValueRef: MutableRefObject<string>
  isVoiceListening: boolean
  isVoiceProcessing: boolean
  voiceInputError: Nullable<string>
  voiceInputSupported: boolean
  handleToggleVoiceInput: () => void
}

export function useChatInputVoiceRecognition({
  locale,
  textareaRef,
  valueRef,
  composerValue,
  onValueChangeLatest,
  enqueueVoiceSendDraft,
  disabled,
  isStreaming,
  hideSubmit,
  localWhisperAvailable,
  t,
  tLatest,
  globalMessageLatest,
  openMicrophoneSettings,
}: UseChatInputVoiceRecognitionOptions): UseChatInputVoiceRecognitionResult {
  const composerPort = useConversationComposerPort()
  const recognitionRef = useRef<BrowserSpeechRecognition>(null)
  const localCaptureRef = useRef<Nullable<LocalSpeechCapture>>(null)
  const localCaptureStartPendingRef = useRef(false)
  const localCaptureStopTimerRef = useRef<Nullable<{ cancel(): boolean }>>(null)
  const voiceBaseValueRef = useRef(composerValue)
  const timers = useTimerScope('useChatInputVoiceRecognition')

  const enqueueVoiceSendDraftLatest = useLatest(enqueueVoiceSendDraft)

  const [isVoiceListening, setIsVoiceListening] = useState(false)
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false)
  const [voiceInputError, setVoiceInputError] = useState<Nullable<string>>(null)

  const speechRecognitionConstructor = useMemo(() => getSpeechRecognitionConstructor(), [])

  const updateVoiceDraft = useMemoizedFn((nextValue: string): void => {
    valueRef.current = nextValue
    onValueChangeLatest.current(nextValue)
  })

  const voiceInputSupported = localWhisperAvailable || !!speechRecognitionConstructor

  const stopBrowserVoiceRecognition = useMemoizedFn((): void => {
    recognitionRef.current?.stop()
    setIsVoiceListening(false)
  })

  const getVoiceInputErrorMessage = useMemoizedFn(
    (event: BrowserSpeechRecognitionErrorEvent): string => {
      switch (event.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          return t('chat.voiceInputPermissionError')
        case 'audio-capture':
          return t('chat.voiceInputMicrophoneUnavailable')
        case 'network':
          return t('chat.voiceInputNetworkError')
        default:
          return event.message || t('chat.voiceInputError')
      }
    }
  )

  const isVoiceInputPermissionError = useMemoizedFn(
    (event: BrowserSpeechRecognitionErrorEvent): boolean =>
      event.error === 'not-allowed' || event.error === 'service-not-allowed'
  )

  const getVoiceInputStartErrorMessage = useMemoizedFn((error: any): string => {
    if (error instanceof DOMException) {
      switch (error.name) {
        case 'NotAllowedError':
        case 'SecurityError':
          return t('chat.voiceInputPermissionError')
        case 'NotFoundError':
        case 'NotReadableError':
          return t('chat.voiceInputMicrophoneUnavailable')
        default:
          return error.message || t('chat.voiceInputError')
      }
    }

    return error instanceof Error ? error.message : t('chat.voiceInputError')
  })

  const isVoiceInputStartPermissionError = useMemoizedFn(
    (error: any): boolean =>
      error instanceof DOMException &&
      (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  )

  const showVoiceInputError = useMemoizedFn((message: string, canOpenSettings = false): void => {
    setVoiceInputError(message)
    globalMessageLatest.current.error({
      title: message,
      duration: optionalWhenLazy(canOpenSettings, () => 10_000),
      actionLabel: optionalWhenLazy(canOpenSettings, () =>
        tLatest.current('chat.voiceInputOpenMicrophoneSettings')
      ),
      onAction: optionalWhen<boolean, () => void>(canOpenSettings, () => {
        void openMicrophoneSettings()
      }),
    })
  })

  const handleVoiceError = useMemoizedFn((event: BrowserSpeechRecognitionErrorEvent): void => {
    const ignoredErrors = new Set(['aborted', 'no-speech'])

    if (!event.error || !ignoredErrors.has(event.error)) {
      const message = getVoiceInputErrorMessage(event)
      showVoiceInputError(message, isVoiceInputPermissionError(event))
    }

    setIsVoiceListening(false)
  })

  const handleVoiceResult = useMemoizedFn((event: BrowserSpeechRecognitionEvent): void => {
    let nextBaseValue = voiceBaseValueRef.current
    let interimTranscript = ''
    let shouldAutoSend = false

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]
      const transcript = result?.[0]?.transcript ?? ''

      if (isBlank(transcript.trim())) {
        continue
      }

      if (result?.isFinal) {
        const parsedTranscript = parseVoiceTranscript(transcript)
        nextBaseValue = appendVoiceTranscript(nextBaseValue, parsedTranscript.text)
        shouldAutoSend = shouldAutoSend || parsedTranscript.shouldSend
        continue
      }

      interimTranscript = appendVoiceTranscript(interimTranscript, transcript)
    }

    voiceBaseValueRef.current = nextBaseValue
    updateVoiceDraft(
      shouldAutoSend ? nextBaseValue : appendVoiceTranscript(nextBaseValue, interimTranscript)
    )

    if (shouldAutoSend) {
      stopBrowserVoiceRecognition()
      timers.nextFrame(() => enqueueVoiceSendDraftLatest.current(nextBaseValue), {
        label: 'chatInput.voiceAutoSend',
      })
    }
  })

  const applyLocalTranscript = useMemoizedFn((transcript: string): void => {
    if (isBlank(transcript.trim())) return

    const parsedTranscript = parseVoiceTranscript(transcript)
    const nextBaseValue = appendVoiceTranscript(voiceBaseValueRef.current, parsedTranscript.text)
    voiceBaseValueRef.current = nextBaseValue
    updateVoiceDraft(nextBaseValue)

    if (parsedTranscript.shouldSend) {
      timers.nextFrame(() => enqueueVoiceSendDraftLatest.current(nextBaseValue), {
        label: 'chatInput.localVoiceAutoSend',
      })
    }
  })

  const stopLocalVoiceRecognition = useMemoizedFn(async (): Promise<void> => {
    const capture = localCaptureRef.current
    if (!capture) return

    localCaptureRef.current = null
    localCaptureStopTimerRef.current?.cancel()
    localCaptureStopTimerRef.current = null
    setIsVoiceListening(false)
    setIsVoiceProcessing(true)

    try {
      const audioBase64 = await capture.stop()
      if (isBlank(audioBase64)) return
      const result = Result.unwrap(
        await composerPort.transcribeLocalSpeech({ audioBase64, locale })
      )
      applyLocalTranscript(result.text)
      setVoiceInputError(null)
    } catch (error) {
      showVoiceInputError(
        error instanceof Error && !isBlank(error.message)
          ? error.message
          : tLatest.current('chat.voiceInputError')
      )
    } finally {
      setIsVoiceProcessing(false)
      focusComposerTextareaNextFrame(textareaRef, timers)
    }
  })

  const abortLocalVoiceRecognition = useMemoizedFn(async (): Promise<void> => {
    const capture = localCaptureRef.current
    localCaptureRef.current = null
    localCaptureStopTimerRef.current?.cancel()
    localCaptureStopTimerRef.current = null
    setIsVoiceListening(false)
    if (capture) await capture.abort()
  })

  const startLocalVoiceRecognition = useMemoizedFn(async (): Promise<void> => {
    if (localCaptureStartPendingRef.current) return
    localCaptureStartPendingRef.current = true
    try {
      const permission = Result.unwrap(await composerPort.requestMicrophonePermission())
      if (permission !== 'granted') {
        showVoiceInputError(tLatest.current('chat.voiceInputPermissionError'), true)
        return
      }

      voiceBaseValueRef.current = valueRef.current
      const capture = await LocalSpeechCapture.start()
      localCaptureRef.current = capture
      localCaptureStopTimerRef.current = timers.after(
        LocalVoiceCaptureMaxDurationMs,
        () => {
          void stopLocalVoiceRecognition()
        },
        { label: 'chatInput.localVoiceMaxDuration' }
      )
      setVoiceInputError(null)
      setIsVoiceListening(true)
    } catch (error) {
      const message = getVoiceInputStartErrorMessage(error)
      showVoiceInputError(message, isVoiceInputStartPermissionError(error))
    } finally {
      localCaptureStartPendingRef.current = false
    }
  })

  const handleToggleVoiceInput = useMemoizedFn((): void => {
    if (isVoiceProcessing || localCaptureStartPendingRef.current) return

    if (isVoiceListening) {
      if (localCaptureRef.current) {
        void stopLocalVoiceRecognition()
      } else {
        stopBrowserVoiceRecognition()
      }
      return
    }

    if (localWhisperAvailable) {
      void startLocalVoiceRecognition()
      return
    }

    if (!speechRecognitionConstructor) {
      const message = tLatest.current('chat.voiceInputUnsupported')
      setVoiceInputError(message)
      globalMessageLatest.current.warning({ title: message })
      return
    }

    const recognition = new speechRecognitionConstructor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = locale
    recognition.onresult = handleVoiceResult
    recognition.onerror = handleVoiceError
    recognition.onend = () => {
      recognitionRef.current = null
      setIsVoiceListening(false)
      focusComposerTextareaNextFrame(textareaRef, timers)
    }

    try {
      voiceBaseValueRef.current = valueRef.current
      recognitionRef.current = recognition
      recognition.start()
      setVoiceInputError(null)
      setIsVoiceListening(true)
    } catch (error) {
      recognitionRef.current = null
      setIsVoiceListening(false)
      const message = getVoiceInputStartErrorMessage(error)
      showVoiceInputError(message, isVoiceInputStartPermissionError(error))
    }
  })

  useEffect(() => {
    if (!isVoiceListening) {
      voiceBaseValueRef.current = composerValue
    }
  }, [composerValue, isVoiceListening])

  useEffect(() => {
    if (isVoiceListening && (disabled || isStreaming || hideSubmit)) {
      if (localCaptureRef.current) {
        void abortLocalVoiceRecognition()
      } else {
        stopBrowserVoiceRecognition()
      }
    }
  }, [
    abortLocalVoiceRecognition,
    disabled,
    hideSubmit,
    isStreaming,
    isVoiceListening,
    stopBrowserVoiceRecognition,
  ])

  useEffect(
    () => () => {
      const recognition = recognitionRef.current

      if (recognition) {
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        recognition.abort()
      }

      recognitionRef.current = null
      localCaptureStopTimerRef.current?.cancel()
      localCaptureStopTimerRef.current = null
      void localCaptureRef.current?.abort()
      localCaptureRef.current = null
    },
    []
  )

  return {
    voiceBaseValueRef,
    isVoiceListening,
    isVoiceProcessing,
    voiceInputError,
    voiceInputSupported,
    handleToggleVoiceInput,
  }
}
