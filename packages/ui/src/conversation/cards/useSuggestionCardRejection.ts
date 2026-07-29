import { useCallback, useState } from 'react'

export interface UseSuggestionCardRejectionResult {
  isRejecting: boolean
  rejectionText: string
  setRejectionText: (value: string) => void
  beginReject: () => void
  cancelReject: () => void
}

/** 建议卡 / 确认卡共用的「拒绝 + 可选备注」本地 UI 状态。 */
export function useSuggestionCardRejection(): UseSuggestionCardRejectionResult {
  const [isRejecting, setIsRejecting] = useState(false)
  const [rejectionText, setRejectionText] = useState('')

  const beginReject = useCallback((): void => {
    setIsRejecting(true)
  }, [])

  const cancelReject = useCallback((): void => {
    setIsRejecting(false)
    setRejectionText('')
  }, [])

  return {
    isRejecting,
    rejectionText,
    setRejectionText,
    beginReject,
    cancelReject,
  }
}
