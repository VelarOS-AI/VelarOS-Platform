import type { ActContextPolicy } from "@velaros-ai/agent";
import type { ContextRef,ContextTarget } from "@velaros-ai/context";
import type { OperationContext } from "@velaros-ai/kernel";
import type { ModelDriver } from "@velaros-ai/model";
import type { ContextMemoryPolicy } from "@velaros-ai/velaros";

import type { SearchEvidence, SearchProfile, SearchProfileInfo,SearchReadResult, SearchRequest, SearchResult } from "../types.js";

/** 仅搜索作用域可用的真实来源检索和读取所需的窄宿主端口。 */
export interface EvidenceHost {
    /** 取得搜索活动的证据入口。 */
    readonly search: EvidenceService;
}
/** 仅搜索作用域可获得活动。 */
export interface EvidenceService {
    /** 解析并校验活动身份。 */
    activation(sessionId: string): EvidenceActivation;
}
/** 有预算的真实证据访问。 */
export interface EvidenceActivation {
    /** 查询候选。 */
    query(source: string, query: string, limit: number, signal: AbortSignal): Promise<unknown>;
    /** 读取并登记证据。 */
    inspect(target: ContextTarget, maxBytes: number, signal: AbortSignal): Promise<SearchEvidence>;
}

/** 有界高级搜索与可恢复报告；search 只允许 execute，read 可用于 observe所需的窄宿主端口。 */
export interface SearchHost {
    /** 搜索编排口。 */
    readonly search: SearchService;
}
/** 有界搜索调用与报告召回。 */
export interface SearchService {
    /** 宿主开放的档位。 */
    profiles(): readonly string[];
    /** 配置名称、默认选择与真实预算。 */
    profileInfo():readonly SearchProfileInfo[];
    /** 新建或续查。 */
    run(input: SearchRequest, call: OperationContext): Promise<SearchResult>;
    /** 召回报告或刷新目标。 */
    read(input: {
        ref: ContextRef;
        mode?: 'snapshot' | 'current';
        evidenceId?: string;
        offset?: number;
        limit?: number;
    }, call: OperationContext): Promise<SearchReadResult>;
}

/** 搜索模型与预算由宿主单独选择。 */
export interface VelarosSearchOptions {
    /** 搜索使用同一分区组装器；缺省近期窗口为 64。 */
    readonly memory?: ContextMemoryPolicy;
    /** 搜索增量历史的容量管理策略。 */
    readonly contextPolicy?: ActContextPolicy;
    /** 搜索使用共享 Provider 驱动。 */
    readonly model: ModelDriver;
    /** 当前开放的预算档位。 */
    readonly profiles: Readonly<Record<string, SearchProfile>>;
    /** 新搜索缺省使用的已登记档位。 */
    readonly defaultProfile: string;
}
