import type { RiskLevel } from "./common.js";

/** provider 运行前就会执行的内核静态安全限制和路径策略。 */
export interface CorePolicy {
  allowFullFileRewrite: boolean;
  /** 要求调用方证明自己基于最新已知 revision 编辑。 */
  requireBaseRevision: boolean;
  requireUniqueTarget: boolean;
  maxFileSizeToReadBytes: number;
  maxSearchFileSizeBytes: number;
  /**
   * 版本号与内容指纹的计算方式（进程级固定，构造后不可中途切换，否则两套版本号互不可比）：
   * - "metadata"（默认，轻量快速）：版本号仅取「路径＋纳秒级修改时间＋字节数」，快照不再为计算哈希而整文件读取或扫描；
   *   代价是「字节数相同且修改时间相同」的外部改动可能被静默漏检（详见升级文档）。
   * - "content"（精确稳重）：读取全文做内容哈希，能识别任意内容变化，但每次快照都要读取并哈希。
   */
  revisionStrategy: "metadata" | "content";
  /** 为 true 且设置了 `ProjectProviders.command` 时，adapter 扫描前优先尝试 ripgrep（失败会回退）。 */
  enableRipgrepSearch: boolean;
  /** 通过 command provider 执行 ripgrep 子进程的超时时间。 */
  ripgrepTimeoutMs: number;
  maxChangedFilesPerTransaction: number;
  maxChangedLinesPerFile: number;
  maxChangedLinesPerTransaction: number;
  maxConcurrentBatchTasks: number;
  readDeny: string[];
  writeDeny: string[];
  /** 可读取但未明确策略允许时不应修改的文件。 */
  protectedFiles: string[];
  generatedFiles: string[];
  approval: {
    requireForDeleteFile: boolean;
    requireForRenameFile: boolean;
    requireForHighRiskPatch: boolean;
    requireForProtectedFile: boolean;
  };
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
  risk?: RiskLevel;
  /** 即使动作被允许，也要求 approval provider 再确认。 */
  requireApproval?: boolean;
}

/** 宿主应用可选的动态策略决策 hook。 */
export interface PolicyProvider {
  decide(input: PolicyDecisionInput): Promise<PolicyDecision> | PolicyDecision;
}

export interface PolicyDecisionInput {
  /** 当前正在授权的内核动作。 */
  action: "read" | "search" | "resolve" | "prepare_edit" | "amend_edit" | "apply_edit" | "validate" | "rollback";
  paths?: string[];
  risk?: RiskLevel;
  data?: any;
}

export interface ApprovalProvider {
  approve(input: ApprovalRequest): Promise<boolean> | boolean;
}

/** 策略判断需要更多确认后发出的人类或宿主审批请求。 */
export interface ApprovalRequest {
  action: string;
  paths?: string[];
  risk: RiskLevel;
  reason: string;
  data?: any;
}
