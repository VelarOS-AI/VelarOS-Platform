import type { Range } from "./common.js";
import type { ResolvedTarget } from "./target.js";

export interface EvidenceTaskInput {
  description?: string;
  goal?: string;
  userConstraints?: string[];
  successCriteria?: string[];
  riskLevel?: "low" | "medium" | "high";
}

export interface BuildEvidenceToolInput {
  task?: EvidenceTaskInput;
  target?: EvidenceTargetInput;
  include?: {
    currentWindow?: boolean;
    windowLinesBefore?: number;
    windowLinesAfter?: number;
  };
  editScope?: EvidencePack["editScope"];
  metadata?: Record<string, unknown>;
}

/** 随 evidence 和编辑决策一起传递的用户任务元数据。 */
export interface TaskContext {
  taskId: string;
  /** 任务的人类可读简述；随 evidence 记录，便于追溯上下文。 */
  description?: string;
  goal: string;
  userConstraints: string[];
  successCriteria: string[];
  riskLevel: "low" | "medium" | "high";
  createdAt: number;
}

export interface EvidencePack {
  evidenceId: string;
  task?: EvidenceTaskInput;
  /** evidence 对应的已解析目标；没有目标时为空。 */
  target?: ResolvedTarget;
  editScope: {
    allowedFiles?: string[];
    forbiddenFiles?: string[];
    maxChangedFiles?: number;
    maxChangedLines?: number;
    allowFullFileRewrite?: boolean;
  };
  freshContext?: {
    /** 目标附近的新鲜有界文本窗口，用来给模型提供依据。 */
    currentWindow?: string;
    path?: string;
    revision?: string;
    targetRange?: Range;
    contextRange?: Range;
    citation?: {
      path: string;
      revision?: string;
      range?: Range;
    };
    hasMoreBefore?: boolean;
    hasMoreAfter?: boolean;
    suggestedReads?: Array<{
      path: string;
      range: Range;
      /** 调用方可能需要继续读取相邻范围的原因。 */
      reason: "before-context" | "after-context" | "wider-target";
    }>;
    metadata?: Record<string, any>;
  };
  trust: {
    /** 构造 prompt 时，工作区文件一律按不可信输入处理。 */
    projectContentIsUntrusted: boolean;
    redactedSecrets: boolean;
  };
  metadata?: Record<string, any>;
}

export type EvidenceTargetInput = {
  targetId?: string;
  path?: string;
  baseRevision?: string;
  range?: Partial<Range>;
};

/** 构建紧凑、便于引用的 evidence packet 的请求。 */
export type BuildEvidencePackInput = BuildEvidenceToolInput;
