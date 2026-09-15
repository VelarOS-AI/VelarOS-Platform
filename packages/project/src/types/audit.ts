/**
 * 审计事件：谁在什么时候对哪个路径、哪个事务做了什么，带权限裁决与风险。
 */

export interface AuditEvent {
  id: string
  timestamp: number
  actor: 'agent' | 'user' | 'system' | 'validator' | 'plugin'
  action: string
  inputSummary?: string
  outputSummary?: string
  path?: string
  targetId?: string
  transactionId?: string
  oldRevision?: string
  newRevision?: string
  permissionDecision?: 'allow' | 'deny' | 'ask'
  risk?: 'low' | 'medium' | 'high'
  metadata?: Record<string, any>
}
