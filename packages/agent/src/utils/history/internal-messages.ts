import type { ModelMessage } from 'ai'

import { isString } from '@velaros-ai/core'

import type { InternalFollowUpModelMessage } from '../../types/history.js'

import { isContextOSGeneratedAssistantMessage } from './context-os-message'

const InternalFollowUpPrefix = '[VelarOS internal follow-up]\n'
const InternalFollowUpTagName = 'sys_note'

/** 造一条「内部续跑提醒」消息：role 为 `system`，内容按 `buildInternalFollowUpContent` 包成标签，并打上 `velarosInternal: { kind: 'follow-up' }` 这个可靠标记——后续识别优先认这个字段，不必去猜文本前缀。 */
function createInternalFollowUpMessage(content: string): ModelMessage {
  return {
    role: 'system',
    content: buildInternalFollowUpContent(content),
    velarosInternal: { kind: 'follow-up' },
  } as InternalFollowUpModelMessage
}

/**
 * 把一段内部续跑正文包进 `<sys_note role="system" hidden="1" from="velaros">` 标签的 CDATA 里。
 * 关键是那行 `]]>` 的转义：正文里出现 `]]>` 会提前闭合 CDATA，后面的内容就跑到标签外、被模型当成结构的一部分读，
 * 所以按 XML 的老办法拆成 `]]]]><![CDATA[>` 再拼回去。
 * 包标签是为了让模型看得出这段是系统旁注而不是用户说的话。
 */
function buildInternalFollowUpContent(content: string): string {
  return [
    `<${InternalFollowUpTagName} role="system" hidden="1" from="velaros">`,
    '<![CDATA[',
    content.replaceAll(']]>', ']]]]><![CDATA[>'),
    ']]>',
    `</${InternalFollowUpTagName}>`,
  ].join('\n')
}

/**
 * 判定一条消息是不是内部续跑提醒：优先看 `velarosInternal.kind === 'follow-up'` 这个标记；
 * 标记不在时退而认文本前缀（`InternalFollowUpPrefix` 或 `<sys_note` 开头）。
 * 留着前缀这条路，是因为旧会话里持久下来的续跑消息没有那个字段——只认标记会让它们在下面的映射里漏网、
 * 以 system 角色留到历史末尾，直接撞上「不能以 system 收尾」那条校验。
 */
function isInternalFollowUpMessage(message: Pick<ModelMessage, 'content' | 'role'>): boolean {
  const internal = (message as InternalFollowUpModelMessage).velarosInternal
  if (internal?.kind === 'follow-up') return true

  return (
    isString(message.content) &&
    (message.content.startsWith(InternalFollowUpPrefix) ||
      message.content.startsWith(`<${InternalFollowUpTagName}`))
  )
}

/**
 * 送给供应方之前，把内部续跑提醒与 Context OS 生成的 assistant 消息一律改挂成 `user` 角色，内容原样不动。
 * 它们在本地是「系统旁白」，但供应方只认 user/assistant/tool 的交替：留成 system 会插在对话中段（多数供应方只收开头的
 * system），留成 assistant 则可能让历史以 assistant 收尾而触发 prefill 报错。
 * 一条都没改时原样返回**同一个数组**（不复制），让调用方能靠 `changedMessages` 判断要不要接着用新那份。
 */
function mapInternalFollowUpsForProvider(history: ModelMessage[]): {
  history: ModelMessage[]
  changedMessages: number
} {
  let changedMessages = 0
  const providerHistory = history.map((message) => {
    if (!isInternalFollowUpMessage(message) && !isContextOSGeneratedAssistantMessage(message)) return message

    changedMessages += 1
    return {
      role: 'user',
      content: message.content,
    } as ModelMessage
  })

  return {
    history: changedMessages > 0 ? providerHistory : history,
    changedMessages,
  }
}

export {
  buildInternalFollowUpContent,
  createInternalFollowUpMessage,
  InternalFollowUpPrefix,
  InternalFollowUpTagName,
  isInternalFollowUpMessage,
  mapInternalFollowUpsForProvider,
}
