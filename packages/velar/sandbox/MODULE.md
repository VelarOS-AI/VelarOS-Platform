# @velaros-ai/velar/sandbox 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `impl/RehearsalSandboxRules.ts` 类上方的接口（`contract/provides.ts` 登记它），本机实现看 `impl/LocalSandboxHost.ts`；utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

演练沙箱（ADR 0006）的公共部分：宿主端口上流动的沙箱数据形状、公开上限，落回前的核对、镜像里危险命令的确认请求，
以及代码面 `sandbox` 命名空间的五个操作。
`velar:sandbox` 与宿主的沙箱实现都用这一份，「核对过的就是要落的」只在这里实现一次（ADR 0008）；落回不问用户（ADR 0009）。
**能力不绑空间**：模型看到的只有 `velar:sandbox` 这一份声明，每个空间注入自己的 `SandboxSurfacePort`，空间之间只差作用域（`resolveSource`）。

**本机实现也在这里**（`./local` 入口，只给 Node）：本机演练沙箱 `LocalSandboxHost` 把目录镜像到临时区、看差量、落回源目录、丢弃镜像，
镜像里的命令经 shell 的受约束执行器（`@velaros-ai/velar/shell/local`）钉在镜像根。隔离由沙箱自己兑现：`run` 只走它持有的受约束执行器，
不靠空间把命令路由过来（ADR 0013）。装空间是产品的事：产品把它原样接上，自己补 `resolveSource`。
根入口与 `./contracts` 不碰 Node 模块，渲染进程也能加载（本机实现只从根入口导出类型）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `rehearsalSandboxRules` | `RehearsalSandboxRulesApi` | 按路径筛三列；落回前的核对；镜像里危险命令的确认请求 |
| `sandboxOperations` | `SandboxOperationsApi` | 代码面 `sandbox` 命名空间的五个操作：create / run / diff / apply / discard |
| `RehearsalSandboxLimits` | 契约常量表 | 沙箱的公开上限，`velar:sandbox` 的声明与宿主实现都引它 |
| `VelarSandboxModule` | 生成的合同（`contract/surface.ts`） | `velar:sandbox` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/sandbox.d.ts` 同一份）；空间挂这件能力时交给代码面的门 |
| `createLocalSandboxHost` | `LocalSandboxHostApi`（`./local` 入口） | 本机演练沙箱：`RehearsalSandboxHostPort` 在本机上的实现，外加列出登记着的沙箱与释放 |
| `SandboxErrorCodes` | 契约常量表 | 落回失败的专属错误码：`SANDBOX_CONFLICT`（源目录变过或上级路径是符号链接）、`SANDBOX_CHANGED`（核对之后镜像又变了） |

**数据面**是 `types/`：`types/rehearsal-sandbox.ts` 是可移植数据（建、跑命令、看差量、落回、丢弃的入参与结果，筛出来的三列），`types/apply.ts` 是落回前核对的入参（从根入口导出），
`types/mirror.ts` 是本机沙箱引擎的工作类型（清单、文件印记、冲突、登记项），不出包。

三个入口对应包清单 `exports` 里的 `./sandbox`、`./sandbox/contracts` 与 `./sandbox/local`，源文件是单元目录上的 `index.ts`、`contracts.ts` 与 `local.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./sandbox` | Node 宿主与渲染进程 | 落回规则、五个操作、宿主端口，本机沙箱的接口与配置，它们用到的数据 |
| `./sandbox/contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |
| `./sandbox/local` | Node 宿主 | 本机沙箱的工厂 `createLocalSandboxHost` |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `RehearsalSandboxHostPort` | 宿主的演练沙箱（建镜像、在镜像里跑命令、看差量、落回、丢弃）。它是各空间共用的端口形状：本机实现是 `createLocalSandboxHost`，项目的宿主端口 `ProjectHostPort` 也把它当沙箱给 |
| `SandboxSurfacePort` | 代码面用的那一份：上面那个端口，加上**作用域**规则（`resolveSource` 把模型给的 source 解析成真实目录）。两个空间的差别全在这里，模型面因此只有一套说明 |
| `SandboxOperationContext` | 宿主每次分发 `sandbox` 命名空间的调用时装好：取消信号、上面那个端口、审批端口 |
| `LocalSandboxHostOptions` | 建本机沙箱时给，全可缺省：平台、约束后端、沙箱基目录 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 落回前核对 | 调用方先向宿主要不附文本差量的差量（三列永远完整）→ `rehearsalSandboxRules.prepareApply(...)`：按点名路径筛三列，点名了没变化的就拒绝 → 什么都没变返回 null，否则交回完整的三列 → 调用方把同一份差量的指纹交给宿主落回 |
| 代码面 `sandbox` 命名空间 | 模型的程序调 `sandbox.<操作>` → `sandboxOperations`：核对取消信号 → 作用域交给 `ctx.sandbox.resolveSource`（系统空间收任意绝对路径，项目空间钳在项目内）→ 调注入进来的端口 → 整形回执。`diff` 三列不截、文本差量缺省全附（`paths` 只要几个），`run` 的输出只守内存上限。`apply` 多一段：先要完整的三列，过 `prepareApply`，再把同一个指纹交给宿主落回（不问用户）。`run` 先过 `prepareRun`：`velar:shell` 的判定说是危险命令就经 `ctx.approval` 问（高风险、手动、不可记忆），被拒抛错、不调端口 |
| 本机沙箱建镜像 | `LocalSandboxHost.createSandbox`：源目录要是解析好的绝对路径 → 解开符号链接、核对它与基目录互不包含 → 先建受约束执行器（探测约束后端，没有就拒绝、不留目录）→ 镜像源目录（gitignore 忽略的目录按 ignored 处理，指向源目录外的 `.git` 链接不进镜像）→ 剪断镜像里每个仓库的推送 → 清单原子落盘 → 登记 |
| 本机沙箱跑命令、看差量、落回、丢弃 | `runInSandbox` 按 id 取登记项（宿主重启过就按清单重新登记，清单读不出来就拒绝）→ 交给它的受约束执行器前台跑完；差量按清单算；落回先核对指纹、再核对源目录、再暂存、再挪到位；丢弃只删基目录下正好一层 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`）；`@velaros-ai/agent` 的 `tool-contract`（审批端口），peer 依赖。
- 同包的单元：`@velaros-ai/velar/shell`（命令判定与危险命令的审批请求，`run` 用；本机沙箱的受约束执行器，经 `./local` 入口），经它的入口引用。
- 本机实现另用：`@velaros-ai/core/path-rules`（镜像时的忽略策略）、`@velaros-ai/core/text-files`（清单的原子写、按编码解码）、`@velaros-ai/core/platform`（路径文本判定）、`diff`（文本差量）。
- 只在验收里用：`@velaros-ai/code-surface`（dev 依赖），跑那条端到端的程序。
- 根入口与 `./contracts` 整条引用链不碰 Node 内置模块，门禁核对；`./local` 只给 Node。
- 不读环境变量。

## 状态归谁

规则与五个操作都不带状态，实例各只有一份。本机沙箱的状态：**登记表**归 `LocalSandboxHost`，每个沙箱一条记录和一个约束到镜像根的受约束执行器；
镜像与清单在临时区 `velaros-sandbox/<id>/` 下，宿主重启后按 id 用到时从清单重新登记。最多同时 `RehearsalSandboxLimits.sandboxes` 个。

## 生命周期

模型面没有需要释放的东西。本机沙箱由宿主创建并持有：`dispose()` 停掉镜像里还在跑的进程，镜像目录保留（用户可能还要看差量）；`discardSandbox` 才删镜像。

## 失败语义

- 点名了没有变化的路径：抛 `VALIDATION`，什么都没写。
- 镜像在核对之后又变过：整批不落，`SANDBOX_CHANGED`；源目录里的文件自建沙箱以来变过、或上级路径是符号链接：整批不落，`SANDBOX_CONFLICT`（冲突列在 message 与 context.conflicts 里）；
  暂存拷不全什么都不落，挪到位的途中失败不回滚、已落回的路径在 message 与 context.applied 里点名。
- 没有约束后端建不出沙箱：`SHELL_CONFINEMENT_UNAVAILABLE`；清单读不出来时镜像里的命令拒绝执行，不退回裸进程；丢弃时 id 不合形状、这一项是符号链接、路径不在基目录下面一层就拒绝。
- `sandbox` 命名空间上的失败一律是抛错：source 越出空间允许的范围由端口抛（`PERMISSION`），镜像里的危险命令被用户拒绝由审批端口抛。代码面把它们变成模型程序里能 `try/catch` 的异常。

## 不变量

共 14 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。INV-9～INV-14 是本机演练沙箱的承诺，随实现从 `@velaros-ai/system` 搬来（原 INV-23～INV-28，ADR 0013）。
按检验方式：测试 13 条、门禁 1 条。未验证 0 条。

## 非目标

- 模型面不建镜像、不算差量、不跑命令、不落回：操作只经宿主端口转调；本机上的引擎在 `./local` 的本机沙箱里。
- 不装空间：哪个空间挂 `velar:sandbox`、源目录能是哪儿，是产品的事（ADR 0013）。
- 不决定作用域：source 相对哪个根解析、越界算不算，全由宿主注入的 `SandboxSurfacePort` 说了算。
- 不决定危险命令被拒之后怎么办，由空间自己定。
- 落回不问用户：落的是模型自己在镜像里做出来的变化，同样的事 shell 不经确认就能做，这道确认拦不住任何事（ADR 0009）。

## 结构

```text
sandbox/
  contract/     对外合同：provides.ts 登记三个类的 API，requires.ts 是四个注入点（宿主沙箱端口、代码面端口、调用上下文、本机沙箱配置），constants.ts 是公开上限与落回的错误码；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：rehearsal-sandbox.ts 是可移植数据，apply.ts 是落回前核对的入参，mirror.ts 是本机沙箱引擎的工作类型
  impl/         SandboxOperations（代码面五个操作）、RehearsalSandboxRules（落回规则的唯一出口）、LocalSandboxHost（本机演练沙箱）
  utils/        apply.ts（按路径筛三列的纯函数）、input.ts（入参核对）、mirror.ts（镜像、清单、差量、落回、推送剪断、基目录守卫）、tuning.ts（本机沙箱的可调参数）
  index.ts      `./sandbox` 入口，只转发
  contracts.ts  `./sandbox/contracts` 入口，只转发
  local.ts      `./sandbox/local` 入口，只转发
  template.js   代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/         不变量登记与验收测试
  test/         实现细节测试
```

**分层。** 上层是 `SandboxOperations.ts`（代码面的五个操作）与 `LocalSandboxHost.ts`（本机沙箱，互不依赖），下层是 `RehearsalSandboxRules.ts`（落回规则）；上层调下层。

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；整个进程只需要一份，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `SandboxOperations.ts` | `SandboxOperationsApi`（同文件，provides 登记） | 代码面 `sandbox` 命名空间的五个操作：解析作用域、调宿主端口、整形回执 |
| `RehearsalSandboxRules.ts` | `RehearsalSandboxRulesApi`（同文件，provides 登记） | 按路径筛三列、落回前的核对、镜像里危险命令的确认请求 |
| `LocalSandboxHost.ts` | `LocalSandboxHostApi`（同文件，provides 登记），扩展 `RehearsalSandboxHostPort`（requires） | 本机演练沙箱：登记表、镜像、差量、落回、丢弃，每个沙箱一个受约束执行器 |
