import type { Range, TrustLabel } from "./common.js";

/** 面向用户的目标选择器，adapter 会把它解析成绑定 revision 的稳定目标。 */
export interface ResolveTargetInput {
  path: string;
  /** 调用方观察到的可选 revision，用来防止基于过期内容定位。 */
  baseRevision?: string;
  target?: {
    symbol?: {
      kind?: string;
      name: string;
      container?: string;
    };
    exactSnippet?: string;
    /** 没有符号信息时，用文本锚点解析范围。 */
    anchors?: {
      before?: string;
      after?: string;
      mustContain?: string[];
    };
    lineHint?: {
      startLine: number;
      endLine: number;
    };
  };
  expectedMatches?: number;
  trust?: TrustLabel;
}

export interface ResolvedTarget {
  targetId: string;
  path: string;
  /** 目标有效时对应的 revision；文件变化后调用方应重新 resolve。 */
  baseRevision: string;
  sha256: string;
  kind: "file" | "range" | "symbol" | "cell" | "paragraph" | "slide-object" | "pdf-region";
  range?: Range;
  symbol?: {
    kind: string;
    name: string;
    container?: string;
    signatureHash?: string;
  };
  anchors: {
    /** 保留的片段，供文本策略后续重新确认目标身份。 */
    exactSnippet?: string;
    before?: string;
    after?: string;
    mustContain?: string[];
    startSnippet?: string;
    endSnippet?: string;
  };
  confidence: number;
  /** resolve 目标时预期的匹配数量。 */
  expectedMatches: number;
  adapterId: string;
  metadata?: Record<string, any>;
}

export type ResolveTargetResult =
  | { status: "resolved"; target: ResolvedTarget }
  | { status: "ambiguous"; candidates: ResolvedTarget[]; reason: string }
  | { status: "not_found"; reason: string; suggestions?: string[] };
