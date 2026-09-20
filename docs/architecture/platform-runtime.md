# Platform 运行主链

当前正式入口是 `@velaros-ai/velaros.createRuntime`。一个会话通过 `script({observe?, execute?})` 提交观察更新和本轮执行，通过 `submit` 驱动模型回合。上下文正文来自观察输出与仍有效的执行结果，程序版本和运行回执使用同一份 ContextStorage。

## 执行顺序

1. `RuntimeSession.submit` 保存用户输入；`FoundationAgent` 取得任务租约。
2. 每个新模型回合先运行当前观察版本。源码引用保持不变，每次运行具有独立执行身份。
3. `ProgramContext.project` 将观察输出、有效结果租约、用户目标和必要的真实回执组合成请求材料。源码变化和输出变化分别给出差量，原文与结果始终标记各自来源。
4. `ProviderRequestCompiler.compileModelTurn` 编码真实材料和完整响应 schema，并执行最终发送预算检查。超预算时缩小投影摘录后重新编译，仍超限则返回 `context_blocked`。
5. 模型流正常结束、唯一输出通过 schema 校验后，持久保存完整响应并确认帧，消费一次成功回合租约。消息通过现有 text 事件交给宿主。
6. `StandardModules.parseTurn` 分离 message 与脚本提交。一份响应至多产生一次提交，执行身份由请求记录与已接受响应记录共同确定。响应截断、取消、重复、迟到或格式错误时不提交，也不消费租约。
7. `RuntimeSession` 直接校验提交，先检查 observe 和 execute 的全部候选。任一失败时保存可修复草稿，保持原观察版本。全部通过后原子保存观察更新、执行源码及执行占位，再进入既有 ScriptAct 执行器。模块调用统一经过 Kernel 的 schema、权限、前提校验、调用日志和结果规范化。
8. 下一轮重新运行观察脚本，投影结果继续交给主模型。完成时使用已有领域验收器；没有验收器时明确保留 `unverified`。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `agent/impl/loop/FoundationAgent.ts` | 模型回合、完整响应接收、单次提交、取消、预算、完成判断 |
| `agent/impl/context/ProviderRequestCompiler.ts` | 实际请求、响应 schema 的封存、指纹与发送前预算检查 |
| `model/impl/requests/AiSdkModelDriver.ts` | AI SDK `Output.object` 传输、用量和完整结构化输出 |
| `kernel/impl/runtime/ModelRequestEncoder.ts` | 同一文本、图像、响应格式的编码与完整输出校验 |
| `velaros/impl/RuntimeSession.ts` | 提交身份、完整预检、观察调度、一次性执行与幂等恢复 |
| `velaros/impl/ProgramContext.ts` | 不可变版本、草稿、原子提交与占位、结果租约、上下文投影 |
| `velaros/impl/ComposedRuntime.ts` | 单一 Kernel、Session 和领域模块的装配 |
| `script/impl/KernelScriptSession.ts` | 复用精确替换算法、ScriptAct 检查器和隔离执行器 |
| `context` | 持久存储、会话原文、任务事实、资源版本和证据校验 |
| `kernel` | 统一模块目录、权限、调用准备、派发与操作回执 |

表内源码路径位于对应 `packages/<包>/src/`。

## 模型入口与内部能力

模型每轮生成一份 `script_turn` JSON 响应，固定三个必填字段：

```json
{
  "message": "检查当前信息并执行本轮任务。",
  "observe": { "source": "import {output} from 'velaros'; output('持续观察所需事实');" },
  "execute": null
}
```

`message` 是用户消息；`observe: null` 保持当前观察程序；`execute: null` 不发起一次性运行。两个脚本区域都为 null 时交还控制，由既有完成验收器判断任务状态。主循环只接受完整文档；部分 JSON 和源码不会作为用户消息显示。

observe 和 execute 继续支持全文 source 或历史 sourceRef 加可选 edits。observe 还支持省略 sourceRef 的 edits，由宿主绑定本轮展示的观察版本；execute 可以指定 retainTurns。脚本描述 schema 由同一组定义构造，宿主 API 仍使用 `session.script({observe?,execute?})`。

调用和返回按以下顺序衔接：

1. AI SDK 收到 `output: Output.object({name,description,schema})`，供应商通过原生 JSON 响应格式返回完整文档。请求只有 system 与本轮用户材料，图像继续走原有多模态编码。
2. ModelDriver 发出 usage、output、finish；Agent 要求唯一 output 与正常 stop。宿主生成持久响应身份，`parseTurn` 将非 null 脚本区域转换成原有 ScriptSubmission。
3. `RuntimeSession.control` 返回原有 ScriptSubmissionReceipt：status、executed、observe 子回执及 execute 的 sourceRef、executionId、resultRef 等均保持现有含义。
4. Runtime 保存源代码、实际输出和操作日志。下一轮 `ProgramContext.project` 的 observation 是当前重跑结果，results 是带剩余租期的执行输出，mandatory/progress 包含必要事实及独立的源码/输出差量。
5. ProviderRequestCompiler 将这份 runtime-view 和 response schema 封存为下一次请求。结果通过事实投影返回，展示文本通过现有 FoundationRunEvent 返回宿主。

`ModelTurnRequest.response` 是中立格式描述；ModelDriver 和 Agent 不解释 message/observe/execute 的业务含义。响应格式独立进入请求快照、指纹和预算。OpenAI 适配使用 `strictJsonSchema: false` 传递完整 schema，以支持脚本可选字段及任意 JSON input；接收门使用 Ajv 严格校验且不补默认值、不转换类型、不移除字段。供应商不支持响应格式时明确失败；不自动重试回合或执行脚本。

脚本内部能力派发由 Kernel 负责。控制身份、持久占位和观察发布前提由宿主管理。

脚本内部的标准模块为：

- `modules`：发现与读取真实模块契约。
- `programs.read`：按当前会话引用分页读取完整程序包。
- `results.read / retain`：读取原始结果、有限重设可见租期。
- `execution.inspect`：查询真实操作回执。
- `artifacts.put / read`：保存和读取共享材料。
- `output`：选择观察或本次执行要展示的结果。

领域能力通过完整模块名导入，仍由宿主选择并注入。观察模式在 Kernel 派发前拦截已知修改能力；命令类能力依赖宿主的受限观察实现，并如实返回保护范围。

## 上下文助手

`BoundedContextPlanner` 保留为有界只读证据检索实现，使用同一个 ProviderRequestCompiler、任务预算和真实数据源。它使用 `context_plan` 响应格式，只能提交候选选择、检索、检查或缺口决策，事实由 ContextEvidenceBuilder 读取和验证。其模型请求与候选预算可独立测试，后续高级搜索工具可以复用这一实现。

主模型的循环由脚本投影直接驱动。上下文助手的调用由独立检索的调用方明确发起。

## 宿主配置

```ts
const runtime = createRuntime({
  storage,
  runner,
  model,
  modules,
  context: { sources, completion },
});
const session = await runtime.openSession('session-id');
await session.script({
  observe: { source: "import {output} from 'velaros'; output('持续观察所需事实');" },
});
for await (const event of session.submit('完成当前任务')) {
  // 宿主处理正文、用量、状态和验收结果。
}
```

增量提交、草稿恢复和租期的详细契约见 `script-context-leases.md` 与 `script-incremental-edit.md`。
