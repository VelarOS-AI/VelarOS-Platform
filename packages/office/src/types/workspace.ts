/** 工作区落盘与归一化的工作类型；只在包内流动，不随可移植入口出包。 */

import type { NormalizedWordInput, OfficeMutationDecision, OfficeMutationRequest, OfficeSystemCommandResult } from './office.js'

/** office 工具写出文件后的统一回执。 */
export type OfficeOutput = {
  path: string
  bytes: number
  created: boolean
  changed: boolean
  kind: 'docx' | 'pptx' | 'xlsx' | 'pdf'
}

/** Word 输入归一化的结果：成功给归一化后的输入，失败给原路径、待回收的临时目录与命令结果。 */
export type NormalizeWordInputResult =
  | { success: true; input: NormalizedWordInput }
  | {
      success: false
      originalPath: string
      tempDir: Nullable<string>
      commandResult: OfficeSystemCommandResult
    }

/**
 * 授权请求的旧名字。
 *
 * @deprecated 改用 `OfficeMutationRequest`；这个别名只为兼容旧的导入名保留，`activate` 本包从不读。
 */
export interface OfficeProjectMutationAuthorizationInput extends OfficeMutationRequest {
  activate?: boolean
}

/**
 * 授权裁决的旧名字（宿主自己的界面还要用 switched、通知这些字段）。
 *
 * @deprecated 本包只读 `OfficeMutationDecision` 里的四个字段；这个宽形状只为兼容旧的导入名保留。
 */
export interface OfficeProjectAuthorizationDecision extends OfficeMutationDecision {
  switched: boolean
  alreadyAuthorized: boolean
  deferred?: boolean
  projectAutoApprovalNotice?: {
    id: string
    path: string
    reason: string
    action: 'add' | 'mutation'
    message: string
    approvedAt: number
  }
  autoApproved?: boolean
  authorizationScope?: 'operation' | 'project'
}
