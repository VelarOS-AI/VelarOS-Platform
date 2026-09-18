# @velaros-ai/project 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 本包没有自己的模型面：模型看到的是五件能力的声明（`baselines/code-surface/project.d.ts`、`code.d.ts`、`shell.d.ts`、`sandbox.d.ts`、`images.d.ts`）。
> 代码这一侧最先看 `src/impl/ProjectSpace.ts` 的装配表，其次是 `src/contract/requires.ts` 的宿主端口和 `src/utils/ports.ts` 里两个端口的说明。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`。

## 这是什么

项目空间：让 agent 在一个项目根里读源码、改源码、问代码、跑命令、演练脚本、看图，出不了项目，每一步都过项目的治理与宿主的审批边界。

一个空间就是一张装配表——给哪几件能力、每件能力用哪个端口。能力本身不在本包，都是 `@velaros-ai/velar` 里的能力单元，一件只有一份实现：

- 项目独有的两件在 `@velaros-ai/velar/project`：`velar:project`（受项目治理的文件：带行号与 fileRef 的读、事务编辑与撤销）与 `velar:code`（问代码之间的关系），连同它们底下的项目内核。空间把宿主给的上下文原样交给它们——宿主端口在结构上满足它们要的空间端口。
- 跨空间共用的三件：`velar:shell`、`velar:sandbox`、`velar:images`。本包只写它们在项目里的端口：命令的工作目录钳在项目内、会改项目的命令先过修改授权再进项目资源门、输出交给程序之前脱敏；沙箱只镜像项目内的目录、落回前核对项目的写治理与修改授权；看图只看项目里、读取策略许看的图。

另外交给 agent 的编码会话一条判据：改到哪些文件之后值得再跑一次验证。它不知道系统空间，也不知道界面长什么样；两个空间互不引用。

## 提供什么

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/contract/`（provides 登记的接口、requires、constants）和 `src/types/`，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对。

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `createProjectSpace` | `ProjectSpaceApi` | 项目空间：一张操作表，`project`、`code`、`shell`、`sandbox`、`images` 五个命名空间，交给代码面的 `createCapabilityPort` 接成能力端口；加上挂了哪几件、哪几件常驻（项目文件与命令）。**表里没有一个字是给模型看的** |
| `projectVerificationPolicy` | `ProjectVerificationPolicyApi` | 「改到这个文件之后要不要再跑一次验证」的判据，宿主交给 agent 的编码会话（`CodingSessionPolicy.isVerificationRelevantPath`） |

**注入面**，写在 `contract/requires.ts`：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `ProjectCallContext` | 是 | 宿主每次分发调用时给：取消信号、审批端口 `ApprovalPort`（来自 agent 包）、会话、可选的交图通道，以及宿主端口 |
| `ProjectHostPort` | 是 | 继承两件项目工具的空间端口（`@velaros-ai/velar/project` 的 `ProjectSpacePort`：项目根、内核、修改授权、代码查询），再加共用能力的项目端口要的：跑命令、列后台任务、刷新 shell 环境，可选的演练沙箱与裁图缩图。它自己声明的每个方法都有端口在调，门禁核对 |
| `ProjectSandboxPort` | 否 | 宿主有演练沙箱时给：公共沙箱端口加上在镜像里跑命令；不给，项目空间里的 `velar:sandbox` 明说做不了 |

**数据面**是 `types/`：`host.ts` 里只有在镜像里跑命令的选项 `ProjectSandboxRunOptions`（它引用 shell 的命令种类，所以从根入口导出）。本包没有自己的可移植数据；**常量表**是 `contract/constants.ts`，只有空间身份 `ProjectSpaceId`。两件项目工具的数据、上限与错误原因在 `@velaros-ai/velar/project/contracts`。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三个面的全部 |
| `./contracts` | 任何进程，含浏览器 | 常量表 |

## 骨干链路

| 链路 | 怎么走 |
| --- | --- |
| 项目空间的一次调用 | 模型的程序调 `read(...)` / `run(...)` / `view(...)` → 能力端口按命名空间找到装配表里那一格 → `resolveCall` 给出这一次调用的上下文（项目根、内核、审批通道、取消信号、会话）→ 交给那件能力：`project`、`code` 直接拿这份上下文，`shell`、`sandbox`、`images` 装成它们要的上下文与端口 |
| `velar:shell` 的项目端口 | `resolveCwd`：按真实路径钳在项目内；`commandPolicy`：确认文案说「当前项目」，风险分类 `project-command:dangerous`；`reviewCommand`：只读命令放行，其余先过宿主的修改授权；`runCommand`：后台命令直接交宿主，前台命令在项目资源门里跑（只读走读门，其余走写门），输出过内核的脱敏后端 |
| `velar:sandbox` 的项目端口 | `resolveSource`：源目录按真实路径钳在项目内；建、看差量、丢弃交宿主的沙箱端口；`runInSandbox`：交宿主、输出脱敏；`reviewApply`：三列路径先过内核的写授权（有一条不许写就在问用户之前整批拒绝并点名），再过宿主的修改授权；`applyPolicy`：风险分类 `project-sandbox:apply` |
| `velar:images` 的项目端口 | `locate`：路径钳在项目内、换成相对项目根的写法，经内核的 `stat` 过读取策略（内核的拒绝按 `reason` 翻成通用码）；`resizeImage`：宿主给了才有 |

## 依赖什么

- `@velaros-ai/velar`：`project` 单元的两件工具、项目资源门、内核的 Agent 视图与模块声明；`shell`、`sandbox`、`images` 单元的操作、端口形状与模块声明。
- `@velaros-ai/code-surface`：操作表与模块清单的类型。
- `@velaros-ai/core`：`AppError`、类型守卫、真实路径；`@velaros-ai/platform`：路径文本的包含判断与相对写法。
- `@velaros-ai/agent` 的 `tool-contract` 子路径（peer）：审批端口。
- 不读环境变量。

## 状态归谁

本包没有自己的状态：装配表每次调用现装端口，上下文由宿主每次给。项目资源门（进程内按项目根排队的读写门）属于 `@velaros-ai/velar/project`，本包的 shell 端口与两件项目工具共用同一个。

## 生命周期

`createProjectSpace` 随宿主创建、随宿主丢弃，没有要释放的句柄。内核、变更记录这些有生命周期的东西由宿主从 `@velaros-ai/velar/project` 建、经宿主端口的 `kernel()` 交进来。

## 失败语义

- 共用能力的项目端口抛通用码：出了项目、修改授权被拒、写治理拦下都是 `PERMISSION`，message 里点名为什么与下一步；宿主没接演练沙箱是 `UNAVAILABLE`。
- 看图时内核的拒绝按原因码翻成通用码（`PERMISSION_DENIED` → `PERMISSION`，`TARGET_NOT_FOUND` → `NOT_FOUND`），下一步照写进 message。
- 被拒时一个进程都不起、一个文件都不落；命令自己失败（非零退出、超时）不抛错，如实写进回执。
- 两件项目工具的失败语义见 `@velaros-ai/velar/project` 的卡片。

## 不变量

共 6 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排，从两件工具那边搬来的几条在登记表开头写了出处。
按检验方式：测试 5 条、门禁 1 条。未验证 0 条。

## 非目标

- 不写能力本身：读写文件、问代码、跑命令、演练、看图的操作各在 `@velaros-ai/velar` 的单元里，本包只给项目空间的端口。
- 不建项目内核、不管事务与变更记录：宿主从 `@velaros-ai/velar/project` 建，经宿主端口交进来。
- 不做项目根管理、Git 界面、文件树可见性：它们归产品壳。
- 不管项目以外的东西：那是系统空间（`@velaros-ai/system`）。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记产品面，requires.ts 宿主端口与调用上下文，constants.ts 空间身份
  types/        只放类型：host.ts 是在镜像里跑命令的选项
  impl/         扁平，一个类一个文件：ProjectSpace.ts 装配表（shell 端口要用资源门，写在这里）、ProjectVerificationPolicy.ts 验证判据
  utils/        ports.ts 是不带状态的两个端口与它们用到的判定（路径钳制、输出脱敏、落回前的写授权、失败翻译）；
                verification-paths.ts 是「什么算代码文件」的判据；tuning.ts 是可调参数
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现细节测试；test/support 是项目空间的测试夹具
```

**看代码的顺序**：五份生成的声明（模型看到的全部）→ `ProjectSpace.ts` 的装配表 → `contract/requires.ts` → `utils/ports.ts` 里函数上方的一句说明。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ProjectSpace.ts` | `ProjectSpaceApi`（同文件，provides 登记） | 项目空间的装配表：五件能力配上项目的端口 |
| `ProjectVerificationPolicy.ts` | `ProjectVerificationPolicyApi`（同文件，provides 登记） | 验证判据 |

两个实现文件在同一层，互不依赖；utils 在最底下，只引 utils、types 与合同。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。

`./contracts` 入口会被渲染进程加载，它的整条引用链不碰 Node 模块。`contract/` 的三个文件改了等于改对外契约，要在差量报告里点名。
