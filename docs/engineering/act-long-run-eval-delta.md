# Act 长任务与正式评测接入

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

## 实际变更

1. `SearchContext.checkpoint` 与投影共同使用最新 `search:history-reset` 边界。重置后第一次整理使用 `baseThrough:0`；区间末尾必须是当前代次的脚本结果，保留最近两个响应，证据引用也必须位于当前代次。
2. 新增 `history.list({after?,through?,limit?})`，默认 32、最多 64 条，返回可用于 `history.read` 的真实引用。目录固定 through 后可以跨页遍历，不受后续追加影响。投影超过最近 64 条时附带省略范围与可调用参数。目录包含当前代次已经被 checkpoint 整理的响应和结果。
3. `scripts/agent/act-eval.mjs` 将正式 `createRuntime` 接到现有 Agent Lab。使用既有 Project 内核/领域操作、ScriptAct 隔离执行器、ContextStorage、ProviderRequestCompiler 和 `session.trace`；核验读取独立测试目录的真实文件及 Kernel 回执。
4. `scripts/agent/run-act-eval.mjs` 从显式配置组装共享 Provider 适配器和 `AiSdkModelDriver`。凭据只从配置指定的环境变量读取。每次验收创建独占工作目录并保留 SQLite、事件、逐回合原始追踪和 Agent Lab 归档。

## 工具与契约差量

唯一工具定义文件：`packages/velaros/src/impl/StandardModules.ts`。

| 工具 | 变化与理由 | 行为影响 |
| --- | --- | --- |
| `velaros:history.list` | 新增有限目录，补全历史省略后的引用发现路径 | 只在增量搜索作用域可用；无写效果，正文另行读取 |
| `velaros:history.read` | 返回 schema 从泛化 object 明确为 ContextContent | 脚本可直接访问 text、record、offset、totalChars；读取及权限行为沿用当前链路 |
| `velaros:history.checkpoint` | 区间与证据验证改为当前历史代次 | 旧代次材料不能进入新检查点；重置后的 baseThrough 与实际投影一致 |

标准模块 `schemaRevision` 从 7 升至 8，纳入当前 Velaros 0.3.0 变更集。公开 provides/requires 没有新增成员；内部 `SessionProgramAccess` 和 `SearchContextApi` 增加目录端口，数据合同为 `HistoryListRequest`、`HistoryPage`。模型协议声明和业务能力接口保持当前合同。

根目录新增 `test:act-eval`、`eval:act`；`test` 在 workspace 测试之后执行评测适配器测试。Velaros 的现有 context-management/advanced-search 测试入口包含新增用例。现有验收用例的承诺保持不变。

## 运行真实模型验收

先按仓库拓扑构建依赖和 Velaros、Agent Lab。已有构建时直接运行：

```sh
bun run eval:act --model-config /absolute/model.json --output /absolute/results
```

配置只包含以下字段；模型名称、地址和容量按实际 Provider 填写，示例数字仅展示数据形状：

```json
{
  "provider": "openai",
  "model": "YOUR_MODEL_ID",
  "baseURL": "https://YOUR_PROVIDER_ENDPOINT/v1",
  "apiKeyEnv": "ACT_EVAL_API_KEY",
  "contextTokens": 200000,
  "inputTokens": 180000,
  "outputTokens": 4096
}
```

宿主在运行前设置该环境变量。配置不接收 API Key 正文，关闭 provider script 的默认配置搜索，也不把整个宿主环境注入模型组合。CLI 缺省最多 12 个业务回合、120000 毫秒，可用 `--turns`、`--timeout-ms` 覆盖；Runtime、Lab 都有终止边界，遇到待用户交互不会自动批准。

当前真实模型用例是“读取 v1 → 一次修改 → 下一轮持续观察确认 v2”。判据同时要求：任务完成、state.txt 是 two、protected.txt 保持原样、只有一次 Project edit 且回执 committed、真实 observe 读取的 one 和 two 按顺序进入请求。模型自行宣布完成不是通过条件。

每次运行保留：

- `project/`：真实测试文件。
- `context.sqlite`：原始会话、源码、结果和回执。
- `events.json` / `traces.json`：实际事件及逐回合的 ModelDriver 请求、原文、协议判定、源码和调用回执。
- `<runId>/report.json`：Agent Lab 标准归档，可由现有 Lab 工具读取。
- `summary.json`：判据结果、模型调用数、材料字符数、实际 Provider 用量与 SQLite 文件大小。

追踪里的 providerRequest 是编译器发送前的封存记录，不证明远端收到了字节。当前驱动按 UTF-8 字节保守估计请求 token，归档保留 precision/basis；Provider 未逐次报告完整用量时总 token 为 null，费用始终为 null。未冻结的工作树会为每次 CLI 运行登记独立 consumer 身份，避免将不同源码误当作可比重复试验。

## 自动化验证

新增 9 项测试：搜索历史重置、长历史分页召回、脚本类型与作用域、40 轮租约压力，以及 5 项评测适配器检查。历史缺陷已在修复前复现。

40 个执行轮次后再完成，共 41 次受控模型请求、81 次实际隔离脚本执行、1105 条存储记录。一次单独运行耗时约 16.8 秒，稳定阶段最大模型材料正文 7090 UTF-16 字符，最后一帧 5325 字符，结束时剩余 1 个有限租约；被显式释放的 task 结果原文仍可读取。该指标来自固定负载，不能代表任意任务、超长会话或真实 Provider 的性能。

最终相关 Node 回归 **188 项通过、0 失败**，包含 Velaros 的 13 个正式链路测试文件、Context 的两组测试及评测适配器。构建、Velaros 类型检查、module-ownership、agent-arch、agent-public-api、agent-schemas、conversation-semantics、三个新脚本的 ESLint（显式 `--no-ignore`）与 git diff --check 均通过。根目录完整 check、产品验收和真实 API 调用尚未运行。

本轮独立追踪产物为任务目录 `act-evaluation/act-3U8bye`：受控 ModelDriver 发起 3 次请求，材料正文分别 1561、3066、5646 字符；Project 实际改写一次并在下一轮读到 two，外部判据通过。SQLite 关闭后为 200704 字节；模型没有报告 Provider 用量，因此 token 与费用保持 null。运行归档 ID 为 `fd1780db-8911-467e-81b4-daca980a8876`。

## 当前边界

受控测试覆盖正式运行链、租约、真实落盘、原始追踪和失败判定。真实 Provider 尚未执行，需要指定模型与凭据来源；当前外部模型用例只覆盖主模型读改观察闭环，高级搜索质量及真实多模态模型验收仍需独立用例。

上下文展示有容量界限，原始审计记录继续追加。LocalContextStorage 每次加载/更新仍处理会话元数据快照，本次没有把历史持久化成本误当作恒定成本；更长会话的存储分段或索引应由实际量测驱动。

修改前备份：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/act-long-run-before-nip6zxko/source.tgz`。代码保留在当前工作树，未提交或推送。
