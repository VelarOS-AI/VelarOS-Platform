import type { ModelToolDelivery } from '@velaros-ai/agent';
import type { ContextContent, ContextReadStamp, ContextRef, ContextSourceHit, ContextSourceRead, ContextTarget } from "@velaros-ai/context";

/** 宿主注入的有限搜索预算，不写死任何档位时长。 */
export interface SearchProfile {
    readonly modelCalls: number;
    readonly modelTokens: number;
    readonly finalizationTokens: number;
    readonly timeoutMs: number;
    readonly callTimeoutMs: number;
    readonly finalizationMs: number;
    readonly publicationMs?: number;
    readonly outputTokens: number;
    readonly projectionChars: number;
    readonly sourceQueries: number;
    readonly candidates: number;
    readonly reads: number;
    readonly readBytes: number;
    readonly noProgressRounds?: number;
}
/** 普通脚本发起或继续一项搜索。 */
export interface SearchRequest {
    readonly query?: string;
    readonly resume?: ContextRef;
    readonly profile?: string;
    readonly sources?: readonly string[];
    readonly context?: string;
    readonly anchors?: readonly ContextTarget[];
}
/** 真实读取的不可变证据。 */
export interface SearchEvidence {
    readonly id: string;
    readonly target: ContextTarget;
    readonly ref: ContextRef;
    readonly excerpt: string;
    readonly stamp: ContextReadStamp;
    readonly complete: boolean;
}
/** 模型报告仅表达结论、依据和缺口。 */
export interface SearchDraft {
    readonly findings: ReadonlyArray<{
        readonly text: string;
        readonly evidenceIds: readonly string[];
    }>;
    readonly gaps: ReadonlyArray<{
        readonly code: string;
        readonly detail: string;
    }>;
    readonly nextSteps: readonly string[];
}
/** 已发布搜索报告；ref 同时定位关联检查点。 */
export interface SearchResult extends SearchDraft {
    /** Runtime 发布的统一交付及显式续查入口。 */
    readonly delivery?:ModelToolDelivery;
    readonly ref: ContextRef;
    readonly searchId: string;
    readonly profile: string;
    readonly continuation: 'available' | 'closed';
    readonly status: 'completed' | 'partial' | 'failed';
    readonly stopReason: string;
    readonly evidence: readonly SearchEvidence[];
    readonly coverage: {
        readonly sources: readonly string[];
        readonly queries: readonly string[];
        readonly limitsHit: readonly string[];
    };
    readonly usage: {
        readonly modelCalls: number;
        readonly sourceQueries: number;
        readonly reads: number;
        readonly readBytes: number;
        readonly elapsedMs: number;
        readonly tokens: Nullable<{
            readonly input: number;
            readonly output: number;
        }>;
    };
}
/** 同一对象存储中的搜索状态，引用跨重启可恢复。 */
export interface SearchState {
    readonly id: string;
    readonly parentSessionId: string;
    readonly sessionId: string;
    readonly query: string;
    readonly profile: string;
    readonly sources: readonly string[];
    readonly evidence: readonly SearchEvidence[];
    readonly candidates: ReadonlyArray<ContextSourceHit & {
        readonly id: string;
    }>;
    readonly queries: readonly string[];
    readonly report?: ContextRef;
    readonly activation?: string;
    readonly expiresAt?: number;
}

/** 已发布报告的快照正文或选定证据的当前读取结果。 */
export type SearchReadResult=(ContextContent&{readonly mode:'snapshot';readonly stamp?:ContextReadStamp})|{
 /** 当前读取不调用模型。 */
 readonly mode:'current'
 /** 已发布报告身份。 */
 readonly ref:ContextRef
 /** 本页刷新结果，ok 区分事实正文与失败。 */
 readonly items:ReadonlyArray<(ContextSourceRead&{readonly id:string;readonly target:ContextTarget;readonly ok:true;readonly status:'current'})|{readonly id:string;readonly ok:false;readonly status:string}>
 /** 可刷新的证据总数。 */
 readonly total:number
 /** 本操作不创建模型请求。 */
 readonly modelCalled:false
}
/** 搜索档位的实际配置目录。 */
export interface SearchProfileInfo {
 /** search 的 profile 参数值。 */
 readonly name:string
 /** 省略 profile 时是否采用此配置。 */
 readonly default:boolean
 /** 此档位的全部资源上限。 */
 readonly limits:SearchProfile
}
