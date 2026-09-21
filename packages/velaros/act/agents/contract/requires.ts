import type { AgentSupervisorApi } from "@velaros-ai/agent";

/** 同一 Act 运行时上的有界子任务；能力由宿主配置，writes 按模块占用所需的窄宿主端口。 */
export interface AgentsHost {
    /** 宿主开放的配置说明，模型据此选择名称、能力和预算。 */
    agentProfiles():ReadonlyArray<{
        /** 配置名称，传给 start/resume。 */
        name:string
        /** 适用任务说明。 */
        description:string
        /** 子任务具备的业务模块。 */
        modules:readonly string[]
        /** 是否可以接受父任务的显式 store 授权。 */
        stores:boolean
        /** 单次运行最多回合。 */
        turns:number
        /** 单次运行毫秒上限。 */
        timeoutMs:number
        /** 逻辑任务累计模型调用上限。 */
        modelCalls:number
        /** 逻辑任务累计 token 上限。 */
        modelTokens:number
    }>

    /** 共享子任务调度器。 */
    readonly agents: AgentSupervisorApi;
    /** 父运行取消范围。 */
    programs(sessionId: string): AgentsSession;
}
/** 父运行访问口。 */
export interface AgentsSession {
    /** 父运行取消信号。 */
    runSignal(): AbortSignal;
}

/** 请求用户提供信息或确认，答案绑定当前运行与请求身份所需的窄宿主端口。 */
export interface InteractionHost {
    /** 取得当前会话交互端口。 */
    programs(sessionId: string): InteractionSession;
}
/** 绑定运行身份的用户交互。 */
export interface InteractionSession {
    /** 请求并等待当前交互答案。 */
    interact(kind: 'input' | 'confirmation' | 'capability', message: string, signal: AbortSignal, detail?:unknown): Promise<unknown>;
}
