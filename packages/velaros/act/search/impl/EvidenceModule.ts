import { readFileSync } from "node:fs";

import type { ContextTarget } from "@velaros-ai/context";
import type { OperationModuleDefinition } from "@velaros-ai/kernel";

import { VelarosRuntimeContract } from "../../runtime/contract/constants.js";
import { objectSchema, resourceTargetSchema, searchCandidatesSchema, searchEvidenceSchema } from "../../runtime/utils/schemas.js";
import { EvidenceModuleId } from "../contract/constants.js";
import type { EvidenceHost } from "../contract/requires.js";
import { EvidenceTuning } from "../tuning.js";

/** 仅搜索作用域可用的真实来源检索和读取。 */
export interface EvidenceModuleApi {
    /** 注入宿主端口，装配到共享 Kernel。 */
    create(host: EvidenceHost): OperationModuleDefinition;
}
class EvidenceModule implements EvidenceModuleApi {
    public create(host: EvidenceHost): OperationModuleDefinition {
        return {
            binding: {
                moduleId: EvidenceModuleId, instanceId: 'standard:evidence', generation: VelarosRuntimeContract.generation, schemaRevision: VelarosRuntimeContract.schemaRevision
            }, summary: '仅搜索作用域可用的真实来源检索和读取', template: readFileSync(new URL('../evidence-template.js', import.meta.url), 'utf8').trim(), operations: {
                query: {
                    summary: '按来源和字面查询检索已授权候选；内部查询独立计费。', input: objectSchema({
                        source: { type: 'string' }, query: {
                            type: 'string', minLength: 1, maxLength: 8000
                        }, limit: {
                            type: 'integer', minimum: 1, maximum: 100
                        }
                    }, ['source', 'query']), output: searchCandidatesSchema, effects: 'none', allowedModes: ['execute'], run: (input, call) => { const value = input as {
                        source: string;
                        query: string;
                        limit?: number;
                    }; return host.search!.activation(call.invocation.sessionId).query(value.source, value.query, value.limit ?? EvidenceTuning.candidates, call.signal); }
                },
                read: {
                    summary: '读取真实目标并登记不可变证据 ID、原文引用和版本。', input: objectSchema({
                        target: resourceTargetSchema, maxBytes: {
                            type: 'integer', minimum: 1, maximum: 60000
                        }
                    }, ['target']), output: searchEvidenceSchema, effects: 'none', allowedModes: ['execute'], run: (input, call) => { const value = input as {
                        target: ContextTarget;
                        maxBytes?: number;
                    }; return host.search!.activation(call.invocation.sessionId).inspect(value.target, value.maxBytes ?? EvidenceTuning.readBytes, call.signal); }
                },
            }
        };
    }
}
/** 注入端口之后接入唯一调用链。 */
export const evidenceModule: EvidenceModuleApi = new EvidenceModule();
