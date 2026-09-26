# 会话缓存键

日期：2026-09-26。范围是长程上下文的前缀缓存：会话级缓存键从 agent 到供应商。

## 起因

Desktop 开发实例 29 个会话、134 条真实请求（Platform `context.sqlite` 的 model-request 记录），逐 token 对照下一帧 `ContextStatus.cache.readTokens`：

- 段内追加的历史没有被稳定命中。和上一次请求间隔不超过 5 分钟的 48 次请求里，25 次没用上上一次请求的前缀，只拿到更早、更短的前缀；间隔只有 3–8 秒也会这样，有一帧掉到 0。
- 原因是[长程上下文](../architecture/long-running-context.md)第一阶段只接了驱动和编译器：model 会把 `cacheKey` 译成 `openai.promptCacheKey`，但 agent 从没填 `cacheKey`，OpenAI 一次都没收到过 `prompt_cache_key`。所有会话开头共用同一段 7K–18K token 的系统提示，没有键时 OpenAI 按开头前缀分配机器，同一会话前后两次请求常常落在不同的机器上。
- 段内历史本身符合 INV-49：102 对相邻请求里，57 对只有上一帧的本帧尾不同，43 对从租约到期改成引用卡的那一条分叉；没有冻结条目逐帧变化，段底座在段内也没变过。

## 对外契约

- agent：ActLoop 每帧给请求填 `cacheKey`，协议修复重发和超窗后重组的请求沿用同一个。值是会话 id 的 SHA-256 前 16 字节，写成 32 位十六进制（`utils/cache-key.ts`）。不直接用会话 id：OpenAI 的 `prompt_cache_key` 超过 64 个字符，整次请求返回 400；而普通会话下的子任务 id（`agent:<父会话>:<uuid>`）已经有 66 个字符。摘要对同一会话重启后不变，也不把会话名发给供应商。公开类型不变，会话 id 取自 ActRunService 已有的 `sessionId`。
- model：`withPromptCache(model, { sessionKey })` 由适配器声明这条线路认不认会话缓存键，默认不认。OpenAIModelAdapter 的官方直连（Responses）和 OpenRouter（Chat Completions，OpenRouter 拿它做会话粘性路由）打开；其余适配器只剥掉内部标记，不出线。原因是同样走 OpenAI SDK 的兼容线路未必认这个字段：Groq 回 400「property 'prompt_cache_key' is unsupported」，Mistral 回 422「Extra inputs are not permitted」。
- Velar Cloud 托管线路暂不发。Cloud 把请求体原样转给 OpenRouter，并开着 `require_parameters`，两者叠加没有实测过；Velar Dev 的中转按白名单丢掉未知字段，发了也到不了上游。要开的话在 VelarModelAdapter 传 `{ sessionKey: true }`，并在 Cloud 上实测。

## 已知限制

- gpt-5.5 的缓存读数按 1024 token 一档：开发实例 63 个非零读数全部是 1024 的整数倍减 256，OpenAI 文档写的是 128 一档。每轮只往稳定前缀里追加几百 token 时，读数会连续几轮不动，这不代表缓存失效。
- 结果租约到期（默认 2 轮）把两轮前的结果改成引用卡，从那一条往后要重算：每次 330–4,910 token；43 次里有 36 次每帧只省下不到 1,000 token。按大小门槛或攒批再改写会动租约语义（INV-6、INV-10），另议。
- 宿主指令里每轮刷新的内容（Desktop 的记忆索引、执行模式）在系统提示末尾，一变就让下一次请求的段底座和段内历史全部失效一次。
- 键只影响路由，不保证命中。新会话的第一次请求可能用不上别的会话留下的系统提示缓存；同一个键每分钟超过约 15 次请求时会溢出到别的机器。

## 验收

- agent INV-44：同一会话的每个模型请求（含协议修复重发）都带同一个键，等于会话 id 的 SHA-256 前 32 位十六进制；超过 64 个字符的会话 id 得到的键也只有 32 位。
- model INV-15：OpenAI 官方与 OpenRouter 的请求体带 `prompt_cache_key`，Groq、Mistral、DeepSeek 的不带，`velaros` 命名空间都不出线。
- 真机：待在 Desktop 开发实例跑一个 10 轮以上的会话，逐帧核对缓存读数能不能跟上上一次请求的前缀。
