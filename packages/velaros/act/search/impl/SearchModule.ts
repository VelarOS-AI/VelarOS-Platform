import { readFileSync } from "node:fs";

import type { ContextRef } from "@velaros-ai/context";
import type { OperationModuleDefinition } from "@velaros-ai/kernel";

import { VelarosRuntimeContract } from "../../runtime/contract/constants.js";
import { contextRefSchema, objectSchema, searchProfileInfoSchema,searchReadSchema, searchRequestSchema, searchResultSchema } from "../../runtime/utils/schemas.js";
import { SearchModuleId } from "../contract/constants.js";
import type { SearchHost } from "../contract/requires.js";
import type { SearchRequest } from "../types.js";

/** 有界高级搜索与可恢复报告；search 只允许 execute，read 可用于 observe。 */
export interface SearchModuleApi {
    /** 注入宿主端口，装配到共享 Kernel。 */
    create(host: SearchHost): OperationModuleDefinition;
}
class SearchModule implements SearchModuleApi {
    public create(host: SearchHost): OperationModuleDefinition {
        const profiles=host.search.profiles();
        return {
            binding: {
                moduleId: SearchModuleId, instanceId: 'standard:search', generation: VelarosRuntimeContract.generation, schemaRevision: VelarosRuntimeContract.schemaRevision
            }, summary: '有界高级搜索与可恢复报告；search 只允许 execute，read 可用于 observe', template: readFileSync(new URL('../template.js', import.meta.url), 'utf8').trim(), operations: {
                profiles:{summary:'查看可选搜索档位、默认项和实际资源上限。',input:{type:'null'},output:searchProfileInfoSchema(profiles),effects:'none',run:()=>host.search.profileInfo()},
                search: {
                    summary: '新建或续查有界搜索；profile 来自宿主，resume 使用上一报告引用。', input: searchRequestSchema(profiles), output: searchResultSchema, effects: 'none', allowedModes: ['execute'], run: (input, call) => host.search!.run(input as SearchRequest, call)
                },
                read: {
                    summary: 'snapshot 按 UTF-16 字符读取历史报告；current 按证据项 offset/limit 刷新已选目标，不调用模型。', input: objectSchema({
                        ref: contextRefSchema, mode: { enum: ['snapshot', 'current'] }, evidenceId: { type: 'string' }, offset: {
                            type: 'integer', minimum: 0
                        }, limit: {
                            type: 'integer', minimum: 1, maximum: 60000
                        }
                    }, ['ref']), output: searchReadSchema, effects: 'none', run: (input, call) => host.search!.read(input as {
                        ref: ContextRef;
                        mode?: 'snapshot' | 'current';
                        evidenceId?: string;
                        offset?: number;
                        limit?: number;
                    }, call)
                },
            }
        };
    }
}
/** 注入端口之后接入唯一调用链。 */
export const searchModule: SearchModuleApi = new SearchModule();
