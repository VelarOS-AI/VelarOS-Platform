import { readFileSync } from "node:fs";

import type { AgentResume,AgentStart } from "@velaros-ai/agent";
import type { OperationModuleDefinition } from "@velaros-ai/kernel";

import { VelarosRuntimeContract } from "../../runtime/contract/constants.js";
import { agentJobSchema, agentStoresSchema, contextRefSchema, objectSchema } from "../../runtime/utils/schemas.js";
import { AgentsLimits, AgentsModuleId } from "../contract/constants.js";
import type { AgentsHost } from "../contract/requires.js";

/** 同一 Act 运行时上的有界子任务；能力由宿主配置，writes 按模块占用。 */
export interface AgentsModuleApi {
    /** 注入宿主端口，装配到共享 Kernel。 */
    create(host: AgentsHost): OperationModuleDefinition;
}
class AgentsModule implements AgentsModuleApi {
    public create(host: AgentsHost): OperationModuleDefinition {
        const id = objectSchema({ id: {
                type: 'string', minLength: 1
            } });
        return {
            binding: {
                moduleId: AgentsModuleId, instanceId: 'standard:agents', generation: VelarosRuntimeContract.generation, schemaRevision: VelarosRuntimeContract.schemaRevision
            }, summary: '同一 Act 运行时上的有界子任务；能力由宿主配置，writes 按模块占用', template: readFileSync(new URL('../template.js', import.meta.url), 'utf8').trim(), operations: {
                profiles:{
                    summary:'列出实际可选配置的名称、能力范围和预算；start/resume 使用 name。',
                    input:{type:'null'},output:{type:'array',items:objectSchema({name:{type:'string'},description:{type:'string'},modules:{type:'array',items:{type:'string'}},stores:{type:'boolean'},turns:{type:'integer'},timeoutMs:{type:'integer'},modelCalls:{type:'integer'},modelTokens:{type:'integer'}})},
                    effects:'none',run:()=>host.agentProfiles(),
                },
                start: {
                    summary: '派发子任务；stores 显式共享空间及读写前缀，每项 write 必须是该项 read 的子范围，materials 复制原文，writes 是外部模块写锁。', input: objectSchema({
                        stores:agentStoresSchema, task: {
                            type: 'string', minLength: 1
                        }, profile: {
                            type: 'string', minLength: 1
                        }, writes: {
                            type: 'array', items: { type: 'string' }
                        }, materials: {
                            type: 'array', maxItems: AgentsLimits.materials, items: contextRefSchema
                        }
                    }, ['task', 'profile']), output: agentJobSchema, effects: 'none', allowedModes: ['execute'], run: (input, call) => host.agents!.start(call.invocation.sessionId, input as AgentStart, host.programs(call.invocation.sessionId).runSignal())
                },
                resume: {
                    summary:'在子任务收束后续跑同一会话，保留已用预算；profile/writes/stores 可替换工作环境，materials 追加材料。',
                    input:objectSchema({id:{type:'string'},input:{type:'string',minLength:1},profile:{type:'string',minLength:1},writes:{type:'array',items:{type:'string'}},stores:agentStoresSchema,materials:{type:'array',maxItems:AgentsLimits.materials,items:contextRefSchema}},['id','input']),
                    output:agentJobSchema,effects:'none',allowedModes:['execute'],run:(input,call)=>{const {id,...request}=input as AgentResume&{id:string};return host.agents!.resume(call.invocation.sessionId,id,request,host.programs(call.invocation.sessionId).runSignal())}
                },
                reply: {
                    summary:'回答指定子任务请求；请求出现在 job.pending 中。回答不改变权限，环境更新需收束后 resume。',
                    input:objectSchema({id:{type:'string'},requestId:{type:'string'},value:{}}),output:{type:'null'},effects:'none',allowedModes:['execute'],run:async(input,call)=>{const v=input as {id:string;requestId:string;value:unknown};await host.agents!.reply(call.invocation.sessionId,v.id,v.requestId,v.value);return null}
                },
                status: {
                    summary: '读取子任务状态和结果引用。', input: id, output: agentJobSchema, effects: 'none', run: (input, call) => host.agents!.status(call.invocation.sessionId, (input as {
                        id: string;
                    }).id)
                },
                wait: {
                    summary: '等待子任务提问或结束，不额外调用模型；pending 中的请求需要 reply。', input: id, output: agentJobSchema, effects: 'none', allowedModes: ['execute'], run: (input, call) => host.agents!.wait(call.invocation.sessionId, (input as {
                        id: string;
                    }).id, call.signal)
                },
                cancel: {
                    summary: '取消并等待子任务收束。', input: id, output: agentJobSchema, effects: 'none', allowedModes: ['execute'], run: (input, call) => host.agents!.cancel(call.invocation.sessionId, (input as {
                        id: string;
                    }).id)
                },
                send: {
                    summary: '向活动子任务发送引导，新输入抢占尚未接受的模型响应。', input: objectSchema({
                        id: { type: 'string' }, input: {
                            type: 'string', minLength: 1
                        }
                    }), output: { type: 'null' }, effects: 'none', allowedModes: ['execute'], run: async (input, call) => { const v = input as {
                        id: string;
                        input: string;
                    }; await host.agents!.send(call.invocation.sessionId, v.id, v.input); return null; }
                },
            }
        };
    }
}
/** 注入端口之后接入唯一调用链。 */
export const agentsModule: AgentsModuleApi = new AgentsModule();
