import { readFileSync } from "node:fs";

import type { OperationModuleDefinition } from "@velaros-ai/kernel";

import { VelarosRuntimeContract } from "../../runtime/contract/constants.js";
import { objectSchema } from "../../runtime/utils/schemas.js";
import { InteractionModuleId } from "../contract/constants.js";
import type { InteractionHost } from "../contract/requires.js";

/** 请求用户提供信息或确认，答案绑定当前运行与请求身份。 */
export interface InteractionModuleApi {
    /** 注入宿主端口，装配到共享 Kernel。 */
    create(host: InteractionHost): OperationModuleDefinition;
}
class InteractionModule implements InteractionModuleApi {
    public create(host: InteractionHost): OperationModuleDefinition {
        return {
            binding: {
                moduleId: InteractionModuleId, instanceId: 'standard:interaction', generation: VelarosRuntimeContract.generation, schemaRevision: VelarosRuntimeContract.schemaRevision
            }, summary: '请求用户提供信息或确认，答案绑定当前运行与请求身份', template: readFileSync(new URL('../interaction-template.js', import.meta.url), 'utf8').trim(), operations: {
                ask: {
                    summary: '向用户请求信息，等待指定交互的回答', input: objectSchema({ message: {
                            type: 'string', minLength: 1, maxLength: 8000
                        } }), output: {}, effects: 'none', allowedModes: ['execute'], run: (input, call) => host.programs(call.invocation.sessionId).interact('input', (input as {
                        message: string;
                    }).message, call.signal)
                },
                capability: {
                    summary:'向宿主或父任务说明缺少的能力；回答不授予权限，可先交付当前进度，再由父任务更新环境续跑。',input:objectSchema({message:{type:'string',minLength:1,maxLength:8000},detail:{}},['message']),output:{},effects:'none',allowedModes:['execute'],run:(input,call)=>{const v=input as {message:string;detail?:unknown};return host.programs(call.invocation.sessionId).interact('capability',v.message,call.signal,v.detail)}
                },
                confirm: {
                    summary: '向用户请求确认，交互答案不代替具体操作的权限校验', input: objectSchema({ message: {
                            type: 'string', minLength: 1, maxLength: 8000
                        } }), output: {}, effects: 'none', allowedModes: ['execute'], run: (input, call) => host.programs(call.invocation.sessionId).interact('confirmation', (input as {
                        message: string;
                    }).message, call.signal)
                },
            }
        };
    }
}
/** 注入端口之后接入唯一调用链。 */
export const interactionModule: InteractionModuleApi = new InteractionModule();
