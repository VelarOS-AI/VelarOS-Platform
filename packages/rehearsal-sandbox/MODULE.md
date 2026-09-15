# @velaros-ai/rehearsal-sandbox 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/RehearsalSandboxRules.ts` 类上方的接口（`contract/provides.ts` 登记它），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

演练沙箱（ADR 0006）的公共部分：宿主端口上流动的沙箱数据形状、公开上限，以及落回前的核对与确认请求。
system:sandbox 与 project:sandbox 两个工具、宿主的沙箱实现都用这一份，「确认的就是要落的」只在这里实现一次（ADR 0008）。
它只处理数据与规则，不建镜像、不跑命令、不读写文件；根入口不碰 Node 模块，渲染进程也能加载。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `rehearsalSandboxRules` | `RehearsalSandboxRulesApi` | 按路径筛三列；落回前的核对与确认请求 |
| `RehearsalSandboxLimits` | 契约常量表 | 沙箱的公开上限，两个空间的工具说明与 schema、宿主实现都引它 |
| `SandboxApplyOperationKind` | 契约常量 | 落回审批的操作身份种类 |

**数据面**是 `types/`：`types/rehearsal-sandbox.ts` 是可移植数据（建、看差量、落回、丢弃的入参与结果，筛出来的三列），`types/apply.ts` 是落回确认请求的入参与结果（引用 agent 的确认选项类型，从根入口导出）。

两个入口对应 `package.json` 的 `exports`，源文件在 `src/exports/`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主与渲染进程 | 落回规则、它用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

**注入面**在 `contract/requires.ts`：`RehearsalSandboxHostPort`，宿主的演练沙箱实现（建镜像、看差量、落回、丢弃）。本包自己不调它，它是两个空间共用的端口形状：system 的宿主端口 `SystemToolSystemApi` 与 project 的沙箱端口 `ProjectSandboxPort` 都扩展它；本机实现是 `@velaros-ai/system` 的本地内核。

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 落回前核对与确认 | 调用方先向宿主要不截断、不附文本差量的完整差量 → `rehearsalSandboxRules.prepareApply(...)`：截断就拒绝 → 按点名路径筛三列，点名了没变化的就拒绝 → 什么都没变返回 null → 按完整三列算条数、预览、敏感路径，给出确认文案（结尾是空间自己的一句）与审批选项（高风险、手动、不可记忆，操作身份含沙箱 id、指纹、三列条数）→ 调用方交给自己的审批端口，确认后把同一个指纹交给宿主落回 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`）；`@velaros-ai/agent` 的 `tool-contract`（手动确认选项、操作身份）与 `protocol`（确认选项类型），peer 依赖。
- 不碰 Node 内置模块：根入口与 `./contracts` 整条引用链门禁核对。
- 不读环境变量。

## 状态归谁

没有状态：规则是纯函数，实例只有一份。沙箱本身（镜像、清单、印记）归宿主的沙箱实现。

## 生命周期

没有需要释放的东西。

## 失败语义

- 宿主给的差量被截断、点名了没有变化的路径：抛 `VALIDATION`，都发生在问用户之前，什么都没写。
- 镜像在确认之后又变过、源目录里有冲突：由宿主的落回实现按空间自己的错误码报（system 是 `SYSTEM_SANDBOX_CHANGED`、`SYSTEM_SANDBOX_CONFLICT`）。

## 不变量

共 4 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 3 条、门禁 1 条。未验证 0 条。

## 非目标

- 不建镜像、不算差量、不落回：引擎在宿主的沙箱实现里（本机是 `@velaros-ai/system` 的本地内核），本包只定端口形状。
- 不决定被拒之后怎么办，也不做落回前的其它授权（project 空间还要过项目修改授权），由空间自己定。
- 不管两个工具的入参 schema 与说明：形状相同、文案按空间不同，各持一份，数字引本包的上限。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记落回规则的 API，requires.ts 是宿主沙箱端口的形状，constants.ts 是公开上限与操作身份
  types/        只放类型：rehearsal-sandbox.ts 是可移植数据，apply.ts 是确认请求的入参与结果
  impl/         RehearsalSandboxRules：落回规则的唯一出口
  utils/        apply.ts（筛选与确认文案的纯函数）、tuning.ts（可调参数）
  exports/      两个入口，只有转发
spec/           不变量登记与验收测试
test/           实现细节测试
```

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；整个进程只需要一份，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `RehearsalSandboxRules.ts` | `RehearsalSandboxRulesApi`（同文件，provides 登记） | 按路径筛三列、落回前的核对与确认请求 |
