import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ConversationRuntimeView } from '../projection'

import type { UserActionCard as UserActionCardType, UserActionCardResult } from '#contracts'
import { isEmpty, toOptional } from '#internal/runtime'

const EmptyUserActionCards: UserActionCardType[] = []
const EmptyUserActionCardIds: string[] = []

interface UseAwaitingConfirmationUserActionCardsOptions {
  runtime: Pick<
    ConversationRuntimeView,
    'awaitingConfirmationUserActionCards' | 'awaitingConfirmationExecutionId' | 'awaitingConfirmationId'
  >
  isAwaitingConfirmation: boolean
  onResolveConfirmation?: (
    approved: boolean,
    rejectionMessage?: LooseOptional<string>,
    options?: { confirmationId?: string; userActionCardResults?: UserActionCardResult[] }
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
  }, [runtime.awaitingConfirmationExecutionId, runtime.awaitingConfirmationId, activeUserActionCardKey])

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
          // 第二参数是**用户写的拒绝理由**，不是卡结果的运输通道。
          //
          // 这里曾经把 `JSON.stringify({ userActionCardResults })` 借道 rejectionMessage 传下去
          // （内核当年只认 message 一条通路）。借道早已冗余——`resolveConfirmationForSourceSession`
          // 现在以结构化的 `userActionCardResults` 为真源统一序列化信封；继续借道只会让下游把
          // 「一坨 JSON」当成用户的理由读（proposal:review 的 feedback 就这么被写进过方案制品）。
          // 卡片阶段的理由住在**每张卡自己的** `result.message` 里，整体理由本来就不存在，
          // 所以这里正确的取值是缺席。
          onResolveConfirmation(approved, undefined, { confirmationId: toOptional(runtime.awaitingConfirmationId), userActionCardResults: results })
        }

        return next
      })
    },
    [activeUserActionCardIds, onResolveConfirmation, runtime.awaitingConfirmationId]
  )

  return {
    activeUserActionCards,
    activeUserActionCardIds,
    resolveUserActionCard,
  }
}
