// ExecutionInteractions 用到的纯函数（不碰实例状态）。
/** 拒绝确认时给模型/执行账的那句话：固定前缀 + 用户理由（有才拼）。 */
export function buildConfirmationDenialMessage(rejectionMessage: Nullable<string>): string {
  return rejectionMessage
    ? `用户拒绝了本次确认请求：${rejectionMessage}`
    : '用户拒绝了本次确认请求。'
}
