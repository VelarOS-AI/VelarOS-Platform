# Responses 终端交付修复

内置 OpenAI Responses 适配器现在在完整协议终端到达后正常结束 SDK 输入，让 SDK 自己生成 finish、usage、响应消息与加密 continuation。它不再要求供应商关闭整个 HTTP 流才能交付已完成响应。

根因在真实 SDK 的流生命周期：收到 `response.completed` 时更新状态，直到输入 EOF 才在 `flush` 里发布最终结果。直接退出驱动的 `fullStream` 循环会绕过这一步，因此修复位于 Model 所有的 fetch 响应体边界。请求内容、模型、推理配置、缓存布局与驱动完成门槛保持原合同。

## 交付与安全边界

- 仅处理内置适配器的流式、成功 HTTP、`text/event-stream`、`/responses` 路径。URL 查询参数不能冒充路径；相对 URL 保持浏览器 fetch 兼容。其它线路保留原响应。
- 按 SSE 空行解析完整事件，仅 JSON 顶层 `response.completed`、`response.incomplete`、`response.failed` 能结束 SDK 输入。文本中的伪终端、`output_text.done`、`[DONE]`、半帧均不能代替它。
- 保留事件 data 原字节。终端尾部只有 CR 时补一个等价 LF 分隔符，让 SDK 能立刻处理合法 CR-only 空行；普通事件不改写。这也覆盖 CRLF 在最后 CR/LF 之间分块。
- 真正终端仍完整交给 SDK 验证。`response:null` 等非法形状继续失败；失败事件和截断原因保持原结果。新代码不合成成功 finish 或零用量。
- 每个事件原始缓冲上限为 `ModelTuning.stream.responseEventBytes`（16 MiB）。它是单个 SSE 事件的字节上限，与输出 token 和 Script 输出字符上限不同；超限显式失败。
- 已完成响应不等待传输 cancel 返回；取消拒绝、同步抛错或永不完成不会推翻已经交付的终端。调用方在终端前取消仍中断读取，半帧不能进入程序执行。

Model 只拥有其 SDK 输入的结束边界。网关继续读取上游、记录迟到用量并保持实际在途槽位，直至网关自己的协议收束。Model 早返回不能证明上游物理结束，也不能把网关的 clientDisconnected 观测写成上游取消。终端缺失用量时 Model 仍保留未知；该修复不等待或编造终端之后才出现的用量。

调用方直接传入的自定义 LanguageModel 不经过内置 fetch 边界，本轮没有重写这种对象。

## 合同差量

新增不变量 INV-20，登记 `test/responses-terminal.test.ts`，并加入包的显式测试执行列表。新增内部 `createResponsesFetch` 和上限调优项；复用已有 `OpenAIModelFetch` 类型。公开 API 无新增字段。README 由根任务同步内置 Responses 的交付语义。

## 验证与版本身份

宿主实际依赖为 `@ai-sdk/openai 3.0.89`、`ai 6.0.237`；完整 Model 源测试 171/171，通过 932 个断言。新增终端测试在 54g 密封归档的完整 JavaScript 依赖树中再次运行：`@ai-sdk/openai 3.0.119`、`ai 6.0.293`，16/16，通过 70 个断言。只读提取到独占证据目录，原归档未修改，没有安装、网络或模型请求。

两版对缺少 usage 的 completed 有差异：3.0.89 要求 usage，3.0.119 允许缺席。因此共同非法形状用例使用 `response:null`；没有把缺失用量强行改为零或统一拒绝。缺用量的失败响应在两版中都保持未知。

回归覆盖终端后永不 EOF、cancel 永不返回与拒绝、分片 UTF-8、逐字节 CRLF、多行 data、CR-only、伪终端、终端同块尾部、半终端 EOF、已完整事件加下一事件残片、超限、挂起读取期间取消、错误优先级、晚出现的 BOM、URL 与 MIME 旁路。类型检查、局部 ESLint、Prettier 和差量空白检查通过。

冻结 54g 实际依赖加原 Model dist 的离线对照中，人为增加 500 毫秒终端后尾流：原实现终端解码后等待 501.67 毫秒，修复后 1.19 毫秒；正文、19/14 token 用量、缓存读、12 token continuation、消息阶段与 reasoning context 均保持。原先只核对 Model dist 相同的宿主实验使用的是 3.0.89；该实验不能单独代表 54g 的依赖版本，现已用实际 3.0.119 补证。

54g 没有记录最后输出或协议终端时间，无法从这次人工实验推算线上 903 秒差距中有多少属于终端后等待。根任务负责正式拓扑构建、新候选冻结及后续集成验收。

证据索引：`.velaros-workspace/bench/parallel-54/recovery-audit-54g/responses-terminal-fix-report.json`；实际依赖对照为 `terminal-eof-frozen-sdk.json`，完整依赖身份为 `frozen-sdk-extraction.json`。
