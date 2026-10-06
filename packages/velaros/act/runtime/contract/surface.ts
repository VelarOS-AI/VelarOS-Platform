// 本文件由 scripts/script/generate-declarations.mjs 从能力包源码生成，不要手改。
// 模型面的声明与代码模版随包发布：空间挂这件能力时把它交给代码面的门，宿主不必另找一份。改了源码里带 @AgentView 的东西或模版，`bun run generate:script` 重算。

/** exec 入口的正式入参合同。 */
export const NativeExecutionSchema = {"type":"object","properties":{"code":{"type":"string"}},"required":["code"],"additionalProperties":false,"definitions":{"T1":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"],"additionalProperties":false}}} as const
