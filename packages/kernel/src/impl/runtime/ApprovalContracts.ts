import type { ManualApprovalOptions,ToolConfirmationDecisionOptions } from '../../types/approval.js'
import { createApprovalOperationKey } from '../../utils/approval.js'
/** 一次危险操作的审批身份与手工审批约束。 */
export interface ApprovalContractsApi {
 /** 计算跨入口一致的完整操作身份。 */
 createApprovalOperationKey(kind:string,value:unknown):string
 /** 强制本次由用户确认，禁止复用历史答案。 */
 createManualApprovalOptions(options?:ManualApprovalOptions):ToolConfirmationDecisionOptions
}
class ApprovalContracts implements ApprovalContractsApi {
 public createApprovalOperationKey(kind:string,value:unknown){return createApprovalOperationKey(kind,value)}
 public createManualApprovalOptions(options:ManualApprovalOptions={}){return {...options,requireManualApproval:true,rememberRiskScope:false}}
}
/** 操作审批公共契约。 */
export const approvalContracts:ApprovalContractsApi=new ApprovalContracts()
