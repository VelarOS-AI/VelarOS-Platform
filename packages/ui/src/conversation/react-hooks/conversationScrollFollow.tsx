import {
  createContext,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useMemo,
  useState,
} from 'react'

import { type AutoCollapseHoldState, resolveAutoCollapseHold } from './scrollBehavior'

import { isPresent } from '#internal/runtime'

/**
 * 读者此刻是否在跟随底部（含持续跟随）。
 *
 * 会话里所有「界面自己」的收起/展开（完成态「已处理」、思考块、卡片自动折叠）都先问这一位：
 * 读者已上滑解除跟随时不动他正在看的内容。取值走 getter 按需读，跟随状态变化不触发任何重渲染。
 */
export interface ConversationScrollFollow {
  isFollowingBottom: () => boolean
}

/** 没有 Provider（独立预览、宿主自己管滚动）一律按跟随处理，自动收起保持原行为。 */
const AlwaysFollowingBottom: ConversationScrollFollow = { isFollowingBottom: () => true }

const ConversationScrollFollowContext = createContext(AlwaysFollowingBottom)

/**
 * `useScrollToBottom` 按它交给宿主的 scrollRef 登记跟随状态。会话面板收到的正是同一个 ref，
 * 于是面板无需宿主新增参数就能把跟随状态下发给消息组件。
 */
const ScrollFollowRegistry = new WeakMap<RefObject<unknown>, ConversationScrollFollow>()

/** 登记 scrollRef 对应的跟随状态；返回注销函数。 */
export function registerConversationScrollFollow(
  scrollRef: RefObject<unknown>,
  follow: ConversationScrollFollow
): () => void {
  ScrollFollowRegistry.set(scrollRef, follow)

  return () => {
    if (ScrollFollowRegistry.get(scrollRef) === follow) ScrollFollowRegistry.delete(scrollRef)
  }
}

/** 调用时才查登记表：宿主的 hook 晚于消息组件登记也不会读到过期结果。 */
export function resolveConversationScrollFollow(
  scrollRef: RefObject<unknown>
): ConversationScrollFollow {
  return {
    isFollowingBottom: () => {
      const follow = ScrollFollowRegistry.get(scrollRef)
      return !isPresent(follow) || follow.isFollowingBottom()
    },
  }
}

export function ConversationScrollFollowProvider({
  children,
  scrollRef,
}: {
  children: ReactNode
  scrollRef: RefObject<unknown>
}): ReactElement {
  const follow = useMemo(() => resolveConversationScrollFollow(scrollRef), [scrollRef])

  return (
    <ConversationScrollFollowContext.Provider value={follow}>
      {children}
    </ConversationScrollFollowContext.Provider>
  )
}

export function useConversationScrollFollow(): ConversationScrollFollow {
  return useContext(ConversationScrollFollowContext)
}

/**
 * 界面自发的收起请求出现的那一刻，读者不在底部就把它扣下：返回 true 表示保持展开（判据见
 * `resolveAutoCollapseHold`）。在渲染期同步推导，请求出现的那一帧子组件就按最终值挂载。
 */
export function useConversationAutoCollapseHold(collapseRequested: boolean): boolean {
  const follow = useConversationScrollFollow()
  const [hold, setHold] = useState<AutoCollapseHoldState>({
    collapseRequested,
    holdExpanded: false,
  })
  const nextHold = resolveAutoCollapseHold(hold, collapseRequested, follow.isFollowingBottom)
  if (nextHold !== hold) setHold(nextHold)

  return nextHold.holdExpanded
}
