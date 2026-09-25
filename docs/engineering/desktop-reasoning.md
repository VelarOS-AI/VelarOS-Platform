# 思考摘要

日期：2026-09-25。范围是模型的思考摘要从供应商到宿主的转发。

## 对外契约

- kernel `ModelTurnDelta` 增加 `reasoning`（text）：供应商给的思考摘要增量，只供宿主展示，不进上下文，也不参与协议解码。
- agent `ActRunEvent` 增加 `reasoning`（runId、text），跟在所属请求的 `turn` 事件之后。运行服务只把它放进出站队列、不写事件账（与 text / program 预览相同），`events()` 回放和重启后都没有它，宿主要留就自己存。包版本 7.3.0 → 7.4.0，按 additive 审核声明基线；宿主的穷尽事件匹配要加这一支。
- model：AI SDK 驱动转发两路来源。一路是 SDK 解析出的思考分片（OpenAI Responses、Anthropic、Google）；另一路是 Chat Completions 原始分块里的 `reasoning_content` / `reasoning`（兼容网关、DeepSeek、OpenRouter、Velar），`@ai-sdk/openai` 的 chat 模型不解析这两个字段，所以驱动开了 `includeRawChunks` 自己取。同一条响应只认先到的那一路，不会重复；思考分段之间空一行；一条响应最多转发 20 万字符（`ModelTuning.stream.reasoningChars`），超出只停转发，响应照常接收。
- 请求侧：各家本来就按思考力度请求摘要（OpenAI `reasoningSummary: 'auto'`、Anthropic summarized thinking、Google `includeThoughts`、OpenRouter / Velar 的 `reasoning`）。

## 宿主消费

- 思考属于最近一个 `turn` 事件；协议被拒重发时有新的 `turn`，思考也跟着新的回合。被拒回合的思考由宿主决定撤不撤，Desktop 撤掉。
- 思考不是正文：不能拼进接纳的正文，也不计入正文预览。翻译、折叠等展示功能归宿主。
- 思考只有一个控制：`reasoningLevel`，low / medium / high / xhigh / max 五档，就是输入框里的「思考深度」滑块；没给按 medium（`DefaultReasoningLevel`）。直连供应商、OpenRouter、Velar 三条路同一口径。发 effort 的型号（OpenAI、自适应思考的 Claude、OpenRouter、Velar）按型号登记的最高档回退：选的档超过它就退到它（`fitReasoningLevel`），没登记的按 high；按数字预算发的型号（Claude 4.5 及更早、Gemini）五档各对应一个预算。OpenRouter 与 Velar 只发 effort，不再同时发 max_tokens。2026-09-25 删掉了旧的三档 `thinkingDepth` 与 off 档。

## 已知限制

- OpenAI 只在 Responses 接口给思考摘要，Chat Completions 不给：经兼容网关用 GPT 系列时看不到思考，直连 OpenAI 才有。兼容网关能不能显示思考，取决于网关在分块里写不写 `reasoning_content` / `reasoning`。

## 验收

- model INV-13：两路来源、只认先到的一路、分段空行、超限只停转发。
- agent INV-43：思考跟在所属 turn 之后交给宿主，不进上下文、不落事件账，非文本的思考增量按协议错误拒绝。
- Desktop 真机（2026-09-25，直连 OpenAI gpt-5.5）：回答前出现思考块，内容是英文推理摘要；打开思考翻译后自动译成中文。
