# ScriptAct 统一为 Shell 和 Node

基础环境是 Shell 与真实 Node.js ESM。命令直接提交 Shell，JavaScript 使用 Node 标准库、工作区依赖和普通文件；应用能力从 `VELAROS_HOST_DIR/index.json` 按需查询，再按包名 import。主会话、业务子任务、观察、搜索及内部整理采用同一 Node 执行技术，具体权限由宿主进程端口决定。

这轮承接 [前版输入与能力目录优化](scriptact-standard-runtime-v2-20261004.md)。模型常驻说明只保留环境、结果、能力发现入口和必要的提交语法。`console.log` 就是普通结果；跨轮复用脚本放进工作目录。

```js
import { readFile } from 'node:fs/promises'
const packages = JSON.parse(await readFile(process.env.VELAROS_HOST_DIR + '/index.json', 'utf8'))
console.log(packages)
```

查阅所需包的声明后，可以直接使用：

```js
import { list } from 'velaros:sessions'
console.log(await list())
```

## 模块所有权与差量

| Owner | 差量 | 理由与影响 |
| --- | --- | --- |
| Script | `NodeCodeRunner` 统一执行 Node/Shell；原生 ESM 解析、按名导入授权包、独立进程、结构化输出文件 | 标准库、npm 和本地模块遵循 Node 语义；能力客户端只连接现有 Kernel |
| Runtime | 默认装配 Shell/Node；持续观察和维护走只读进程口；主会话只介绍执行与完成 | 各会话沿用同一语言和能力导入方式，复杂合同按需查阅 |
| Shell | 进程环境、精确会话桥与输出文件例外、取消和进程树回收 | 复用宿主审批、OS 约束与真实退出状态 |
| Context / Runtime | 进展和观察差量比较忽略本次进程的日志归档路径 | 相同结果不会仅因新日志路径被误判为进展；完整回执仍保留地址 |
| Desktop | 注入随产品分发的真实 Node；执行卡、IPC、恢复、Trace 保留语言 | Shell 注释与进程结果按实际语言展示，打包应用不依赖机器上的 Node PATH |

文件、项目事务、浏览器、图片、界面、会话协作和内部状态等能力仍归各自领域模块。它们的正式 TS 接口生成声明与校验 schema，按需导入不改变授权范围。用户代码的原生文件、网络、子进程权限由 OS/宿主决定；Kernel 逐次校验能力调用。

QuickJS 依赖、WASM worker、父子消息执行器及 Desktop utilityProcess ScriptRunner 已完成迁移清理。锁文件只减少该依赖链。历史审核的旧实现证据链接固定到对应提交，历史结论保持原记录。

## 公开合同与迁移

- Node 正文缺省执行；`CodeProgramRequest.language: 'shell'` 执行原始命令。Shell 使用普通文件传递数据，拒绝附带 `input/modules/blobs`。协议支持 `shell()`，语言随脚本版本、事件、IPC 和 UI 归档。
- 宿主 `NodeProcessRequest` 新增 `bootstrap`、`language`、`mode`。Node 进程读取 `bootstrap ?? source`，Shell 执行 `source`；审批始终使用原始 `source`。已有自定义 Node 宿主需要采用这一启动合同。
- `nodeExecutable.resolve()` 是 Script 的正式 Node 查找入口，避免在 Bun 下把 Bun 当作 Node。Desktop 显式使用产品 Node；Electron 不作为 Node 的替代可执行文件。
- `nodeSubprocessCodeRunner` 保留为 POSIX Node 便利入口；Windows、Electron及受限执行需要实际宿主进程端口。`NodeSubprocessRunnerIsReleaseReady` 保持 false，代表部署隔离仍由宿主验收。
- `createSubprocessCodeRunner`、`ScriptProcess*`、`ScriptWorker*`、`SubprocessCodeRunnerOptions` 及 `@velaros-ai/script/worker` 随旧执行器退役；宿主统一接入 `createNodeCodeRunner` / `createShellNodeEnvironment`。这是源码 API 迁移，本轮未发布 npm 包。
- `velaros` 的 `output` 与 `velaros:program` 的 `input/blobs` 继续供需要结构化归档的程序使用。输入按 JSON 反序列化并冻结，保留 `__proto__`、空值和原始字符；输出同步落盘，死循环、超时和取消后保留已完成的块。
- 原生 Node 负责标准 ESM 的静态链接、live binding、循环依赖和动态 import。语法预检返回诊断；模块绑定错误走真实执行回执。显式选择兼容合同检查器时仍支持类型剥离与额外静态合同检查。
- `ObservationReusePort.coversNativeIO` 明确要求宿主覆盖登记程序的全部原生依赖；缺少该证明时重新采集。ABA、授权变更、重启及时效规则继续成立。

Script 的 INV-1/2/5/9/10/12/28/40 已按这些行为更新：由 Node 提供语言与标准环境，由宿主提供进程权限和生命周期。Runtime 的 INV-57/67/85/87 改为按需文件合同与稳定环境说明。原有 prompt 字面值、常驻声明和 worker 消息测试改为真实 import、文件/网络约束、取消、输出及包部署测试；领域行为的独立断言继续保留。

macOS 实测只读进程允许读取与本次能力桥/输出文件，拒绝工作区写入和真实 TCP 连接。宿主报告仍如实区分部分保护与完整保护；本轮不声称其他 OS 已完成同等运行验收。

## 对比方法

模型与参数固定为 `gpt-5.6-sol`、high reasoning、Responses、最多 12,000 输出 token。每个任务 8 次模型请求、240 秒总上限，每侧每题运行一次，先后顺序轮换。成功必须同时满足独立产物验收和正常完成，原文保护与真实宿主调用计入判定。

初始六个任务在运行前冻结，参考产物先验收。原 `host-priorities` 夹具提供了 `status`，缺少真实 SessionPeer 的必需字段，两侧均被 Kernel 拒绝，因此这两次是无效实验。原始结果、耗时、用量与冻结哈希完整保留，未归因于模型或运行时。

随后新增独立的 `host-workspace-queue` 任务，使用不同数据与筛选条件，在两侧实际 Kernel 和独立参考判据通过后冻结。产品快照和评测器保持原版本。有效比较由初始五题加这组新题构成；一共保留 14 次尝试，其中 12 次有效。补充任务与初始最后一组在部分时间窗口重叠，耗时结果仅作为此次运行观测。

快照合计 11,115 个文件、33 条内部包依赖链接经过核对；任务集、评测器和两侧快照哈希在运行后保持一致。冻结之后生产代码仅将 `input === undefined` 换为 Core 中等价的 `isUndefined(input)` 以满足规范门，另外修正注释和验收文档；Script 164 项回归及类型、lint、合同门再次通过。没有根据测得表现调整产品行为。

证据目录：`.velaros-workspace/bench/standard-runtime-v3-20261004/` 和 `.velaros-workspace/bench/standard-runtime-v3-host-20261004/`。完整指标、每次结果、缺失用量和冻结信息见 [机器可读记录](scriptact-shell-node-runtime-results-20261004.json)。

## 有效样本结果

| 指标 | 前版 Node | Shell + Node |
| --- | ---: | ---: |
| 产物合格且正常完成 | 5/6 | 6/6 |
| 模型请求总数 | 25 | 26 |
| 总耗时 | 547.350 秒 | 204.381 秒 |
| 完整用量记录 | 5/6 | 5/6 |
| 系统说明字符数 | 652–665 | 717–730 |

系统说明增加约 65 字符，用于介绍直接 Shell 执行和按包名导入。新版在有效样本中实际使用了 9 个 Shell 程序段。

| 任务 | 前版：通过 / 请求 / 秒 | 本版：通过 / 请求 / 秒 |
| --- | --- | --- |
| 事件归并与空值 | 是 / 4 / 39.203 | 是 / 4 / 39.287 |
| CLI 字面参数与非零退出 | 是 / 3 / 33.706 | 是 / 4 / 36.351 |
| 已安装 ESM 包与可复用脚本 | 否 / 8 / 240.026 | 是 / 6 / 44.596 |
| 模块修复与独立检查 | 是 / 4 / 170.536 | 是 / 4 / 27.382 |
| 原始字节与验证程序 | 是 / 2 / 15.405 | 是 / 3 / 17.115 |
| 新宿主查询、关联与筛选 | 是 / 4 / 48.474 | 是 / 5 / 39.650 |

前版在两个任务中给异步 `execFile` 传入不支持的 `input` 选项，`apply_patch` 等待 stdin 导致程序超时；模块修复随后恢复，区间任务后续又遇到字符串转义错误并耗尽总时限。新版可直接通过 Shell 提交这些命令。本次总耗时减少 62.66%，主要由这两次等待造成，不能外推为所有任务的普遍速度提升。请求数增加 4%。

四组双方用量完整的有效配对中，输入 token 为 109,390 → 120,867（+10.49%），输出为 5,785 → 3,969（−31.39%）。按输入 $4/M、输出 $20/M 的固定未缓存参考单价计算，费用为 $0.553260 → $0.562848（+1.73%）。这不是实际账单，结果也不支持本版比前版更省成本。

新版事件任务首个请求发生上游 `terminated` 并恢复，前版区间任务末次请求被总期限取消；两次缺少用量均保留 null，不填零、不估完整账单。单次、小规模样本支持当前实现可用及特定失败模式改善，不能证明跨模型泛化。

## 工程验证

| 检查 | 结果 |
| --- | --- |
| Platform 构建、全量类型、lint、格式 | 通过 |
| Script | 164/164，通过原生 ESM、标准库、授权包、JSON 保真、异常、死循环、取消、输出与进程回收 |
| Context | Node 82 通过、4 跳过；Bun 21/21 |
| Velaros | Bun 1375 通过、6 跳过；Runtime/Act Node 748/748；其余 Bun 40/40 |
| 评测与 Harbor 工具回归 | 34/34；观察工作负载显式开放 observe，以实际会话身份区分主/子会话 |
| 能力套件 | 10/10 |
| 所有权、公开合同、生成目录、架构、发布源码与打包消费门 | 通过；包目录由正式生成器同步 |
| Desktop `bun run check` | 通过，含四个类型检查分区 |
| Desktop `bun run test` | 200/200 个文件通过 |
| 真实 Electron 与 ASAR | 均通过；独立测试构建、RunAsNode fuse 关闭、空 PATH 下使用随包 Node |
| Platform 依赖安全审计 | 仍有原有 27 项：11 high、13 moderate、3 low；整套 check 因此不能宣称全绿 |

Desktop 当前运行应用与共享构建目录保持原样。变更在本地提交并合并 main；远端发布是独立操作。

## 复现

使用新证据目录，复制冻结快照和 freeze 文件，保留现有尝试；本机私有凭据不进入结果仓库。

```sh
node scripts/agent/standard-runtime-evaluation.mjs \
  .velaros-workspace/bench/standard-runtime-v3-20261004 \
  validation 1 '' scripts/agent/standard-runtime-v3-validation-cases.json

node scripts/agent/standard-runtime-evaluation.mjs \
  .velaros-workspace/bench/standard-runtime-v3-host-20261004 \
  validation 1 '' scripts/agent/standard-runtime-v3-host-validation-cases.json
```

初始 host-priorities 是已标注的无效夹具；该原始任务集用于重现证据，宿主能力有效验收使用第二个入口。以上任务现已成为已观察样本，进一步泛化比较需要新的冻结任务。
