# @velaros-ai/rehearsal-sandbox 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/RehearsalSandboxRules.ts` 类上方的接口（`contract/provides.ts` 登记它），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

演练沙箱（ADR 0006）的公共部分：宿主端口上流动的沙箱数据形状、公开上限，落回前的核对与确认请求，
以及代码面 `sandbox` 命名空间的五个操作。
`velar:sandbox`、项目空间的沙箱工具、宿主的沙箱实现都用这一份，「确认的就是要落的」只在这里实现一次（ADR 0008）。
**能力不绑空间**：模型看到的只有 `velar:sandbox` 这一份声明，每个空间注入自己的 `SandboxSurfacePort`（系统空间的实现在 `@velaros-ai/system` 的 `createSystemSpace` 里）。
它只处理数据与规则，不建镜像、不跑命令、不读写文件；根入口不碰 Node 模块，渲染进程也能加载。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `rehearsalSandboxRules` | `RehearsalSandboxRulesApi` | 按路径筛三列；落回前的核对与确认请求 |
| `sandboxOperations` | `SandboxOperationsApi` | 代码面 `sandbox` 命名空间的五个操作：create / run / diff / apply / discard |
| `RehearsalSandboxLimits` | 契约常量表 | 沙箱的公开上限，`velar:sandbox` 的声明、项目空间的工具说明与 schema、宿主实现都引它 |
| `SandboxApplyOperationKind` | 契约常量 | 落回审批的操作身份种类 |

**数据面**是 `types/`：`types/rehearsal-sandbox.ts` 是可移植数据（建、跑命令、看差量、落回、丢弃的入参与结果，筛出来的三列），`types/apply.ts` 是落回确认请求的入参、结果与空间的落回政策 `SandboxApplyPolicy`（引用 agent 的确认选项类型，从根入口导出）。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主与渲染进程 | 落回规则、它用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `RehearsalSandboxHostPort` | 宿主的演练沙箱实现（建镜像、看差量、落回、丢弃）。它是各空间共用的端口形状：系统空间的宿主 `SystemSpaceHost` 与项目空间的沙箱端口 `ProjectSandboxPort` 都扩展它；本机实现是 `@velaros-ai/system` 的本地内核 |
| `SandboxSurfacePort` | 代码面用的那一份：上面那个端口，加上在镜像里跑命令，加上两条**作用域**规则（`resolveSource` 把模型给的 source 解析成真实目录，`applyPolicy` 给这个空间的落回政策）。两个空间的差别全在这里，模型面因此只有一套说明 |
| `SandboxOperationContext` | 宿主每次分发 `sandbox` 命名空间的调用时装好：取消信号、上面那个端口、审批端口 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 落回前核对与确认 | 调用方先向宿主要不截断、不附文本差量的完整差量 → `rehearsalSandboxRules.prepareApply(...)`：截断就拒绝 → 按点名路径筛三列，点名了没变化的就拒绝 → 什么都没变返回 null → 按完整三列算条数、预览、敏感路径，给出确认文案（结尾是空间自己的一句）与审批选项（高风险、手动、不可记忆，操作身份含沙箱 id、指纹、三列条数）→ 调用方交给自己的审批端口，确认后把同一个指纹交给宿主落回 |
| 代码面 `sandbox` 命名空间 | 模型的程序调 `sandbox.<操作>` → `sandboxOperations`：核对取消信号 → 作用域交给 `ctx.sandbox.resolveSource`（system 收任意绝对路径，project 钳在项目内）→ 调注入进来的端口 → 整形回执。`apply` 多一段：先要不截断的完整差量，过 `prepareApply`，再经 `ctx.approval` 向用户确认，确认后把同一个指纹交给宿主落回 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`）；`@velaros-ai/agent` 的 `tool-contract`（手动确认选项、操作身份、审批端口）与 `protocol`（确认选项类型），peer 依赖。
- 只在验收里用：`@velaros-ai/code-surface`（dev 依赖），跑那条端到端的程序。
- 不碰 Node 内置模块：根入口与 `./contracts` 整条引用链门禁核对。
- 不读环境变量。

## 状态归谁

没有状态：规则与五个操作都不带状态，实例各只有一份。沙箱本身（镜像、清单、印记）归宿主的沙箱实现。

## 生命周期

没有需要释放的东西。

## 失败语义

- 宿主给的差量被截断、点名了没有变化的路径：抛 `VALIDATION`，都发生在问用户之前，什么都没写。
- 镜像在确认之后又变过、源目录里有冲突：由宿主的落回实现按空间自己的错误码报（system 是 `SYSTEM_SANDBOX_CHANGED`、`SYSTEM_SANDBOX_CONFLICT`）。
- `sandbox` 命名空间上的失败一律是抛错：source 越出空间允许的范围由端口抛，落回被用户拒绝由审批端口抛。代码面把它们变成模型程序里能 `try/catch` 的异常。

## 不变量

共 6 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 5 条、门禁 1 条。未验证 0 条。

## 非目标

- 不建镜像、不算差量、不跑命令、不落回：引擎在宿主的沙箱实现里（本机是 `@velaros-ai/system` 的本地内核），本包只定端口形状并转调。
- 不决定作用域：source 相对哪个根解析、越界算不算，全由宿主注入的 `SandboxSurfacePort` 说了算。
- 不决定被拒之后怎么办，也不做落回前的其它授权（project 空间还要过项目修改授权），由空间自己定。
- 不管项目空间沙箱工具的入参 schema 与说明：那是项目空间自己的，数字引本包的上限。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记两个类的 API，requires.ts 是三个注入点（宿主沙箱端口、代码面端口、调用上下文），constants.ts 是公开上限与操作身份
  types/        只放类型：rehearsal-sandbox.ts 是可移植数据，apply.ts 是确认请求的入参、结果与空间的落回政策
  impl/         SandboxOperations（代码面五个操作）、RehearsalSandboxRules（落回规则的唯一出口）
  utils/        apply.ts（筛选与确认文案的纯函数）、tuning.ts（可调参数）
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现细节测试
```

**分层。** 上层是 `SandboxOperations.ts`（代码面的五个操作），下层是 `RehearsalSandboxRules.ts`（落回规则）；上层调下层，项目空间的沙箱工具直接用下层。

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；整个进程只需要一份，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `SandboxOperations.ts` | `SandboxOperationsApi`（同文件，provides 登记） | 代码面 `sandbox` 命名空间的五个操作：解析作用域、调宿主端口、整形回执 |
| `RehearsalSandboxRules.ts` | `RehearsalSandboxRulesApi`（同文件，provides 登记） | 按路径筛三列、落回前的核对与确认请求 |
