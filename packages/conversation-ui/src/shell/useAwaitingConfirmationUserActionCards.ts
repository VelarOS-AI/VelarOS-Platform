import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ConversationRuntimeView } from '../projection'

import type { UserActionCard as UserActionCardType, UserActionCardResult } from '#contracts'
import { isEmpty } from '#internal/runtime'

const EmptyUserActionCards: UserActionCardType[] = []
const EmptyUserActionCardIds: string[] = []

interface UseAwaitingConfirmationUserActionCardsOptions {
  runtime: Pick<
    ConversationRuntimeView,
    'awaitingConfirmationUserActionCards' | 'awaitingConfirmationExecutionId'
  >
  isAwaitingConfirmation: boolean
  onResolveConfirmation?: (
    approved: boolean,
    rejectionMessage?: LooseOptional<string>,
    options?: { userActionCardResults?: UserActionCardResult[] }
  ) => void
}

export interface UseAwaitingConfirmationUserActionCardsReturn {
  activeUserActionCards: UserActionCardType[]
  activeUserActionCardIds: string[]
  resolveUserActionCard: (result: UserActionCardResult) => void
}

/** awaiting-confirmation 阶段阻塞型 user-action-card 聚合与批量 resolve。 */
export function useAwaitingConfirmationUserActionCards({
  runtime,
  isAwaitingConfirmation,
  onResolveConfirmation,
}: UseAwaitingConfirmationUserActionCardsOptions): UseAwaitingConfirmationUserActionCardsReturn {
  const activeUserActionCards = useMemo(() => {
    if (!isAwaitingConfirmation) return EmptyUserActionCards

    const cards: UserActionCardType[] = []
    for (const card of runtime.awaitingConfirmationUserActionCards) {
      if (card.blocking) {
        cards.push(card)
      }
    }

    return cards
  }, [isAwaitingConfirmation, runtime.awaitingConfirmationUserActionCards])
  const activeUserActionCardIds = useMemo(() => {
    if (isEmpty(activeUserActionCards)) return EmptyUserActionCardIds

    return activeUserActionCards.map((card) => card.id)
  }, [activeUserActionCards])
  const [, setUserActionCardResults] = useState<Record<string, UserActionCardResult>>({})
  const activeUserActionCardKey = activeUserActionCardIds.join('|')

  useEffect(() => {
    setUserActionCardResults({})
  }, [runtime.awaitingConfirmationExecutionId, activeUserActionCardKey])

  const resolveUserActionCard = useCallback(
    (result: UserActionCardResult): void => {
      if (!onResolveConfirmation || isEmpty(activeUserActionCardIds)) return

      setUserActionCardResults((current) => {
        if (current[result.cardId]) return current

        const next = {
          ...current,
          [result.cardId]: result,
        }
        const results: UserActionCardResult[] = []
        let allSettled = true
        for (const cardId of activeUserActionCardIds) {
          const entry = next[cardId]
          if (!entry) {
            allSettled = false
            break
          }
          results.push(entry)
        }

        if (allSettled) {
          const approved = results.every((entry) => entry.approved)
          const message = JSON.stringify({ userActionCardResults: results })
          onResolveConfirmation(approved, message, { userActionCardResults: results })
        }

        return next
      })
    },
    [activeUserActionCardIds, onResolveConfirmation]
  )

  return {
    activeUserActionCards,
    activeUserActionCardIds,
    resolveUserActionCard,
  }
}
