/** 宿主历史检索的 refKind 前缀判别，精确保留归档来源类别。 */
export function inferRecallRefKind(
  ref: string
): 'evidence' | 'tool-payload' | 'payload-ref' | 'context-handle' {
  // 两种内容寻址前缀同属全保真层；`ctx-user-payload:` 有三个冒号段,不先认出来会被下面的
  // evidence 规则误判(审计 U6),而 evidence 账本里根本没有这个 id。
  if (ref.startsWith('ctx-payload:') || ref.startsWith('ctx-user-payload:')) return 'payload-ref'
  // tool:*/message:* 都是 retrieveContextPayload 原生认识的 handle 前缀,直接走 handle 通道;
  // 若推断成 tool-payload 会经 readToolPayload 再包一层 tool: 前缀,变成 tool:tool:* 而 miss。
  if (ref.startsWith('tool:') || ref.startsWith('input:') || ref.startsWith('message:')) return 'context-handle'
  // 驻留账本记录 id(ctx-r000123):折叠信封与超大 user 正文安全阀发的就是这个形态,
  // 走 handle 通道由检索面经治理账本取回全文。
  if (/^ctx-r\d+$/u.test(ref)) return 'context-handle'
  // evidence id 形如 <toolCallId>:<kind>:<index>(至少两个冒号段);裸 tool call id 无冒号。
  if (ref.split(':').length >= 3) return 'evidence'
  return 'tool-payload'
}
