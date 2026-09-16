# @velaros-ai/shell-command 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/` 两个类上方的接口（`contract/provides.ts` 登记它们），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

agent 代跑一条 shell 命令时的公共语义：执行前判断它是不是只读、危不危险、是不是长驻服务、能不能和别的调用并发，给出确认文案，构造危险命令的审批请求。
system:run、project:run、两个空间演练沙箱里的 run、宿主的审批界面与无人值守放行都用这一份，判定处处一致；改一次判定只改一处。
它只看命令文本，不执行命令、不读写文件；根入口不碰 Node 模块，渲染进程也能加载。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：两件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `shellCommandPolicy` | `ShellCommandPolicyApi` | 执行前分类（只读、危险、长驻、端口）、并发判定、确认文案 |
| `shellCommandApproval` | `ShellCommandApprovalApi` | 危险命令的审批请求：文案加高风险手动确认选项，操作身份跨工具一致 |
| `ShellCommandOperationKind` | 契约常量 | 危险命令审批的操作身份种类 |

**数据面**是 `types/`：`types/shell-command.ts` 是可移植数据（`ShellCommandPlan`、并发判定的入参与选项），`types/approval.ts` 是审批请求的入参与结果（引用 agent 的确认选项类型，从根入口导出）。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主与渲染进程 | 命令策略、审批请求、它们用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

没有注入面：本包不需要宿主塞任何东西。

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 执行前分类 | `shellCommandPolicy.analyze(command)`：去首尾空白 → 危险黑名单（递归删除、丢未提交改动的 git、提权、格式化磁盘等，给出理由）→ 长驻判定（开发服务器、监听）→ 只读判定（白名单命令，逐段看参数、前缀、环境变量赋值、git 全局选项与子命令、sed 整段脚本，出现重定向、子 shell、后台符、换行整条否决）→ 端口提取 |
| 并发判定 | `shellCommandPolicy.isParallelSafe(input, { optIn })`：命令必须是字符串、不转后台、只读、无需确认；optIn（缺省）时还要求入参显式 `parallel: true` |
| 危险命令审批 | `shellCommandApproval.dangerous(input)` → 文案（命令、理由、递归删除的仓库提醒、是否后台、端口）+ `agentToolContracts.createManualApprovalOptions`（高风险、手动、不记忆）+ 操作身份 `agentToolContracts.createApprovalOperationKey('shell-command', { 命令, 工作目录, 前后台 })` → 调用方交给自己的审批端口，被拒怎么办调用方定 |

## 依赖什么

- 上游包：`@velaros-ai/core`（几个类型守卫）；`@velaros-ai/agent` 的 `tool-contract`（手动确认选项、操作身份）与 `protocol`（确认选项类型），peer 依赖。
- 不碰 Node 内置模块：根入口与 `./contracts` 整条引用链门禁核对。
- 不读环境变量。

## 状态归谁

没有状态：两个类都只持有常量，判定是纯函数。

## 生命周期

没有需要释放的东西。`shellCommandPolicy`、`shellCommandApproval` 随进程存在。

## 失败语义

- 不抛错：认不出的命令一律判非只读、不危险；空命令什么都不是（不只读、不危险、不长驻）。
- 判定方向是固定的：只读判定宁可误判成「非只读」（多一次修改授权、少一次并发），危险判定宁可误判成「危险」（多弹一次确认）；真正的授权门在宿主的审批端口。

## 不变量

共 4 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 3 条、门禁 1 条。未验证 0 条。

## 非目标

- 不执行命令、不管进程：跑命令是各空间宿主端口的事。
- 不决定被拒之后怎么办：system:run 被拒抛错，project:run 被拒返回结构化拒绝，由空间自己定。
- 不管长驻命令要不要问：体验型的低风险确认由空间决定问不问（system:run 问，project:run 不问）。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记两件能力的 API（定义在各自类上方，这里 re-export），constants.ts 是审批操作身份；没有注入面
  types/        只放类型：shell-command.ts 是可移植数据，approval.ts 是审批请求的入参与结果，invocation.ts 是判定内部的工作类型
  impl/         一类一文件：ShellCommandPolicy（判定的唯一出口）、ShellCommandApproval（审批请求）
  utils/        command-policy.ts：判定本身，全是纯函数，每个函数上方一句说明
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现细节测试
```

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；类的公开方法只能是接口里的方法。整个进程只需要一份，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ShellCommandPolicy.ts` | `ShellCommandPolicyApi`（同文件，provides 登记） | 执行前分类、并发判定、确认文案的唯一出口 |
| `ShellCommandApproval.ts` | `ShellCommandApprovalApi`（同文件，provides 登记） | 危险命令的审批请求 |
