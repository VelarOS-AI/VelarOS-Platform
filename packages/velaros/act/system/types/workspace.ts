import type { ContextRef } from "@velaros-ai/context";

/** 对稳定键的版本化修改；驻留只影响可见性，原文始终归档。 */
export interface WorkspaceUpdate {
    readonly key: string;
    readonly baseRevision: number;
    readonly title?: string;
    readonly body?: string;
    readonly sources?: readonly ContextRef[];
    readonly resident?: boolean;
}
/** 目录和投影使用引用，不通过目录偷偷加载全文。 */
export interface WorkspaceEntry {
    readonly key: string;
    readonly revision: number;
    readonly title: string;
    readonly ref: ContextRef;
    readonly resident: boolean;
    readonly chars: number;
}
