# Script 执行引擎

## 这是什么

`@velaros-ai/script` 提供程序级检查、纯编辑与单次执行。Velaros 持有会话、源码版本和结果租约，Kernel 持有能力注册、权限与调用回执，Agent 编译下一轮模型请求。

## 提供什么

| 入口 | 责任 |
| --- | --- |
| `scriptOutputs` / `ScriptOutputsApi` | 提取声明、只编辑展示字段、按类型投影已归档输出并校验内容指纹 |
| `ScriptOutputLimits` | 输出块数量、原始采集、展示和元数据的公开上限 |
| `scriptPackageCompiler` / `ScriptPackageCompilerApi` | 根据授权模块生成虚拟包声明和冻结成员投影，返回 `ScriptPackageSurface` |
| `createKernelScriptSession` / `KernelScriptSessionApi` | `edit` 生成候选，`check` 检查，`run` 在宿主签发的执行身份下运行一次 |
| `codeProgramChecker` / `CodeProgramCheckerApi` | 在内存中检查主源码和附属模块；诊断携带源码位置和代码帧 |
| `createCodeSurfaceSession` / `CodeSurfaceSessionApi` | 校验体量，检查后调用运行器，收集结果、图像和调用账 |
| `createCapabilityPort` / `CodeCapabilityPort` | 将宿主操作表转换成能力调用端口 |
| `nodeSubprocessCodeRunner` / `CodeRunnerApi` | Node 宿主使用共享运行器与独立 QuickJS worker |
| `createSubprocessCodeRunner` | 注入宿主进程创建，复用计时、能力桥、输出采集与回收 |
| `./worker` / `startScriptWorker` | 受信子进程的独立环境入口，建立 QuickJS 堆与消息处理 |
| `CodeSurfaceLimits` / `CodeProgramEditLimits` | 源码、参数、输出、诊断、调用数和编辑数的公开上限 |

`contract/provides.ts` 登记产品接口，`contract/requires.ts` 定义宿主注入。根入口用于 Node 宿主，`./contracts` 只导出数据与常量。`NodeSubprocessRunnerIsReleaseReady` 为 `false`，部署隔离仍需宿主验收。

公开入口 `.` 提供父进程宿主 API，`./contracts` 提供数据与常量；`./worker` 只加载受信 worker 内核，不引入编译器或父进程启动器。`CodeSurfaceDiagnosticCodes` 是可识别诊断码，`CodeSurfaceErrorCodes` 是执行错误码，`NodeSubprocessRunnerIsReleaseReady` 是发布认证状态。

注入面包括 `KernelScriptSessionOptions`（Kernel、运行器、会话、执行身份、模式与 `ScriptPackageDefinition` 包映射）、`CodeCapabilityCall` / `CodeCapabilityOutcome`（能力调用及结果）、`CodeSurfaceEventSink`（调用起止及日志事件）和 `CodeRunnerApi`（隔离运行器）。`SubprocessCodeRunnerOptions` 注入进程创建，`ScriptProcessEvents` 与 `ScriptProcess` 约定进程事件、消息和终止回执，`ScriptWorkerOptions` 提供 worker 通信与故障退出。

## 骨干链路

`KernelScriptSession` 读取同一 Kernel 的模块声明并生成能力端口，交给 `CodeSurfaceSession` 执行。程序先过体量和类型检查，再进入隔离进程。每次能力调用经 `KernelInvocationPort` 到 Kernel 的权限、效果检查和持久回执。运行器停止后返回导出值、日志、裁剪说明、附件，以及已完成和未落定调用。

`edit` 按 `oldText` 精确唯一定位，全部替换基于同一份原文；定位缺失、重复或重叠时整组拒绝。附属模块由 `module` 指定已有键。编辑操作只返回候选程序；源码版本发布及并发比较由 Velaros 的 ProgramContext 负责。

程序的 `modules` 固定该次附属源码，相对 import 只在这份模块集合内解析；同一模块每次执行只初始化一次。`input` 与 `blobs` 经 `velaros:program` 获取；大字符串不必编码进源码。

## 状态归谁

一个 KernelScriptSession 的执行身份只运行一次。隔离进程的生命周期对应一次运行，取消和超时会终止计算，并要求未落定能力调用停止。效果是否真正落定由 Kernel 回执决定，宿主遇到未知结果须先核对。

## 失败语义

检查失败返回结构化诊断，源码行与定位符计入诊断预算。执行错误码包括 `PROGRAM_ERROR`、`TIMEOUT`、`ABORTED`、`RUNNER_CRASHED`、`UNKNOWN_OPERATION`、`TOO_LARGE`、`OPERATION_FAILED`。增量定位失败返回 `SCRIPT_EDIT` 和编辑索引。

运行器、能力端口及事件观察器由宿主注入；源码与结果的持久化复用 Velaros 所注入的 ContextStorage。权限判断在能力调用处执行。

## 依赖什么

检查与 AST 改写依赖 TypeScript，guest 执行依赖 quickjs-emscripten，能力派发依赖 Kernel，公共数据判断依赖 Core。宿主通过注入面提供运行器和能力端口。

## 生命周期

宿主创建执行身份，检查通过后运行一次；程序结束后父进程终止并等待进程退出，再交付运行结果。worker 正常完成只发送终态，初始化或通信失败才由宿主退出；完成后的能力回执不会再次发送。取消信号与调用时钟由会话统一维护，持久记录由 ContextStorage 的宿主生命周期管理。

## 非目标

权限策略及副作用核对归 Kernel 与领域模块。会话投影、版本发布和结果租约归 Velaros。宿主负责实际部署环境的隔离认证。

## 不变量

`impl/KernelScriptSession.ts` 编排，`CodeSurfaceSession.ts` 处理一次执行，`CodeProgramChecker.ts` 检查，`SubprocessCodeRunner.ts` 统一父端生命周期，`NodeSubprocessCodeRunner.ts` 与 `NodeScriptProcess.ts` 装配 Node 进程，`ScriptWorker.ts` 维护 QuickJS 堆，`KernelInvocationPort.ts` 与 `CapabilityOperationPort.ts` 转发能力。`utils/` 提供编译、编辑、路径、诊断与预算纯函数，`bin/script-child.mjs` 实现隔离进程桥。

共 29 条，测试 28 条、门禁 1 条，未验证 0 条。不变量见 `spec/invariants.md`。执行引擎验收在 `spec/acceptance.test.ts`；源码版本、草稿、CAS、租约和重启恢复在 `packages/velaros/act/runtime/test/incremental-edit.test.mjs` 与 `program-context.test.mjs`。所有权门禁为 `bun run check:module-ownership`。

## 结构

```text
src/
  contract/  对外接口、注入契约、错误码与上限
  types/     程序、诊断、结果、编辑与运行器数据
  impl/      Kernel 会话、检查器、单次执行器、隔离与能力端口
  utils/     AST、编辑、路径、预算、诊断与 IPC 工具函数
bin/         script-child.mjs 隔离进程桥
```
