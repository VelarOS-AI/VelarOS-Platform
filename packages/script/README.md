# @velaros-ai/script

JavaScript 脚本的检查、精确编辑与隔离执行引擎。正式装配通过 `createKernelScriptSession` 接入同一 Kernel：生成声明用于类型检查，能力调用经过 Kernel 权限、效果分类与持久回执。

- `edit(program, edits)` 在同一底稿上原子替换主源码或附属模块，返回完整候选，保留 `input` 与 `blobs`。
- `check(program)` 校验源码、附属模块与当前能力声明，诊断包含行列和有界代码帧。
- `run(program, signal)` 按该次执行身份运行一次；调用期间暂停计算时钟，停止时报告已完成及未落定调用。

模型通过 Velaros 的统一 `script({observe?, execute?})` 入口 使用引擎。不可变源码版本、结果租约与下一轮投影由 Velaros 在 ContextStorage 中维护；模型请求由 Agent 的 ProviderRequestCompiler 编译。

脚本使用标准 ES 模块语法：`import` 获取能力，顶层 `await` 执行，`export` 或 `output` 交出结果。参数走 `input`，大字符串走 `blobs`，附属模块以 `modules` 随程序提交。模板统一通过 `velaros:system` 的 `modules.describe({module, export?})` 按需读取，能力声明由宿主当前注册表提供。

`createSubprocessCodeRunner({launch})` 统一父进程的执行计时、能力桥、输出采集和回收；宿主只注入 `ScriptProcess` 消息与终止合同。受信子进程从 `@velaros-ai/script/worker` 调用 `startScriptWorker({send, onMessage, exit})`，使用共享 QuickJS WASM 内核，guest 只通过显式能力桥访问外部。

`nodeSubprocessCodeRunner` 是同一运行器的 Node 装配。Electron 宿主显式提供自己的进程端口；正常完成由父端终止并等待进程退出后交付结果。`NodeSubprocessRunnerIsReleaseReady` 仍为 `false`；宿主须完成部署隔离认证。执行前检查、取消、超时、结果预算和权限拒绝均有自动化验收。

详细责任、公开面与测试见 [模块卡片](MODULE.md) 和 [不变量](spec/invariants.md)。

## 声明式输出

`output(value, {key?, purpose?, type?, language?, priority?, view?})` 在调用时捕获 JSON 值快照。对象的 undefined 可选字段省略，数组空位和 undefined 保存为 null；循环引用、getter、非有限数和其他不可表示的值明确拒绝。`output.configure({maxChars})` 在第一次输出前调用一次，设置整份输出的文字展示上限。`view` 支持 `mode`（auto/full/reference/summary）、`maxChars`、`lines`、`maxItems`、`edge` 与 JSON Pointer `paths`。

```js
import {output} from 'velaros';
output.configure({maxChars:16000});
const current = {status:'ready', count:3};
output(current, {
  key:'state', purpose:'持续检查当前状态', type:'json', priority:'high',
  view:{paths:['/status','/count'], maxChars:2000}
});
```

原始输出 `CodeSurfaceOutcome.output` 与有界预览 `result` 分开；无显式输出的完整返回值为 `rawValue`。业务消费者必须使用原始值解析结构化交付，预览只用于展示。每次执行最多捕获 64 块、合计 1000000 个 JSON 字符；采集失败明确反馈，已捕获块在异常、中止后仍保留。展示上限不减少生成第一个参数的采集成本。

宿主使用 `scriptOutputs.describe/edit/project/hash` 解析源码规则、生成受限编辑、重新展示和验证摘要。只直接管理主源码顶层、真实导入符号绑定、稳定 key 和字面量 options；任意计算、循环和动态声明仍可运行，自动整理只调整可静态验证的展示数据。`summary` 使用外部整理工具提供的版本绑定摘要，不在 output 中调用模型。

图片值使用 Kernel 的 `{type:'image-data',mediaType,data,label}`，原生附件单独传递；文件或已有图片可输出带 `ref` 的元信息对象。引用的访问权限仍由原读取入口校验。完整说明见仓库 `docs/architecture/script-output-observation.md`。
